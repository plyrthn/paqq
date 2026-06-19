import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createHmac } from "node:crypto";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
} from "playwright";
import {
  normalizeYunexpressTracking,
  type YunexpressQueryResponse,
} from "./normalize-yunexpress.js";
import {
  persistCarrierSessionState,
  withCarrierSessionState,
} from "./session-state.js";
import type { ScrapeOptions, ShipmentInfo } from "./types.js";

const chromiumWithFlags = chromium as typeof chromium & {
  __paqqStealthApplied?: boolean;
};

if (!chromiumWithFlags.__paqqStealthApplied) {
  chromium.use(StealthPlugin());
  chromiumWithFlags.__paqqStealthApplied = true;
}

// Key is embedded in the public yuntrack.com JS bundle; the Query endpoint
// rejects unsigned bodies. The signature is computed over the timestamp and
// the serialized tracking-number list.
const SIGN_KEY = "f3c42837e3b46431ddf5d7db7d67017d";
const API_URL = "https://services.yuntrack.com/Track/Query";
const BASE_URL = "https://www.yuntrack.com/";
const TRACKING_URL_BASE = "https://www.yuntrack.com/parcelTracking?id=";
const DEFAULT_TIMEOUT_MS = 60_000;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface BrowserSession {
  context: BrowserContext;
  close: () => Promise<void>;
}

interface BrowserSessionOptions {
  usePersistedState?: boolean;
}

class WafExpiredError extends Error {
  constructor() {
    super("yuntrack WAF session expired");
    this.name = "WafExpiredError";
  }
}

function ensureTrackingNumber(trackingNumber: string): string {
  const normalized = trackingNumber.trim().toUpperCase();
  if (!/^[A-Z0-9-]{8,40}$/.test(normalized)) {
    throw new Error("Invalid YunExpress tracking number format");
  }
  return normalized;
}

function getExecutablePath(): string | undefined {
  if (process.env.YUNEXPRESS_BROWSER_EXECUTABLE_PATH) {
    return process.env.YUNEXPRESS_BROWSER_EXECUTABLE_PATH;
  }
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return undefined;
}

function buildSignedBody(trackingNumbers: string[]): Record<string, unknown> {
  const timestamp = Date.now();
  const signature = createHmac("sha256", SIGN_KEY)
    .update(`Timestamp=${timestamp}&NumberList=${JSON.stringify(trackingNumbers)}`)
    .digest("hex");
  return {
    NumberList: trackingNumbers,
    CaptchaVerification: "",
    Year: 0,
    Timestamp: timestamp,
    Signature: signature,
  };
}

async function createBrowserSession(
  timeoutMs: number,
  options: BrowserSessionOptions = {}
): Promise<BrowserSession> {
  const cdpEndpoint = process.env.YUNEXPRESS_CDP_WS_ENDPOINT?.trim();
  const usePersistedState = options.usePersistedState !== false;

  const baseContextOptions = {
    locale: "en-US",
    timezoneId: process.env.YUNEXPRESS_TIMEZONE ?? "America/New_York",
    userAgent: process.env.YUNEXPRESS_USER_AGENT ?? DEFAULT_USER_AGENT,
    viewport: { width: 1366, height: 900 },
  } satisfies BrowserContextOptions;
  const contextOptions = usePersistedState
    ? await withCarrierSessionState("yunexpress", baseContextOptions)
    : baseContextOptions;

  if (cdpEndpoint) {
    const browser = await chromium.connectOverCDP(cdpEndpoint, {
      timeout: timeoutMs,
    });

    if (browser.contexts().length > 0) {
      const context = browser.contexts()[0];
      return {
        context,
        close: async () => {
          await persistCarrierSessionState("yunexpress", context).catch(
            () => undefined
          );
          await browser.close();
        },
      };
    }

    const context = await browser.newContext(contextOptions);
    return {
      context,
      close: async () => {
        await persistCarrierSessionState("yunexpress", context).catch(
          () => undefined
        );
        await context.close();
        await browser.close();
      },
    };
  }

  const headless = process.env.YUNEXPRESS_HEADFUL !== "1";

  // Headless on a server has no GPU, so the acceleration flags just add
  // software-emulation overhead. --disable-dev-shm-usage routes Chromium's
  // shared memory to /tmp instead of the tiny default /dev/shm, which is the
  // usual cause of crashes in containers.
  const launchArgs = headless
    ? [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ]
    : ["--disable-blink-features=AutomationControlled"];

  const browser: Browser = await chromium.launch({
    headless,
    executablePath: getExecutablePath(),
    args: launchArgs,
  });

  const context = await browser.newContext(contextOptions);
  return {
    context,
    close: async () => {
      await persistCarrierSessionState("yunexpress", context).catch(
        () => undefined
      );
      await context.close();
      await browser.close();
    },
  };
}

// Alibaba Cloud WAF in front of services.yuntrack.com rejects Node/curl
// requests via TLS fingerprinting. Issuing the signed POST from inside a real
// Chromium page reuses Chrome's TLS handshake and the acw_tc WAF cookie set by
// the navigation, so the request is accepted.
async function queryTrackingViaPage(
  session: BrowserSession,
  trackingNumber: string,
  timeoutMs: number
): Promise<YunexpressQueryResponse> {
  const page = await session.context.newPage();
  try {
    // The WAF only sets its acw_tc cookie during the first cross-origin call,
    // so a cold context's first POST frequently returns 405. Retrying the fetch
    // in the same page (after re-navigating) lets the now-present cookie through
    // instead of tearing down and starting cold again.
    const maxWafAttempts = 5;
    for (let attempt = 1; attempt <= maxWafAttempts; attempt += 1) {
      await page.goto(BASE_URL, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      await page.waitForTimeout(600 + attempt * 500);

      const body = buildSignedBody([trackingNumber]);
      const result = await page.evaluate(
        async ({ url, payload, requestTimeout }) => {
          const controller = new AbortController();
          const abortTimer = setTimeout(
            () => controller.abort(),
            requestTimeout
          );
          try {
            const res = await fetch(url, {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/plain, */*",
                Authorization: "Nebula token:undefined",
              },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
            return { status: res.status, text: await res.text() };
          } finally {
            clearTimeout(abortTimer);
          }
        },
        { url: API_URL, payload: body, requestTimeout: timeoutMs }
      );

      if (result.status === 200) {
        try {
          return JSON.parse(result.text) as YunexpressQueryResponse;
        } catch {
          throw new Error("YunExpress tracking response was not valid JSON");
        }
      }

      if (result.status === 405) {
        // Cookie not established yet; re-navigate and try again.
        await page.waitForTimeout(500);
        continue;
      }

      throw new Error(
        `YunExpress tracking request failed (status ${result.status})`
      );
    }

    throw new WafExpiredError();
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function scrapeYunexpressTracking(
  trackingNumber: string,
  options: ScrapeOptions = {}
): Promise<ShipmentInfo> {
  const normalizedTrackingNumber = ensureTrackingNumber(trackingNumber);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const trackingUrl = `${TRACKING_URL_BASE}${encodeURIComponent(
    normalizedTrackingNumber
  )}`;

  const parsedMaxAttempts = Number(
    process.env.YUNEXPRESS_SCRAPE_MAX_ATTEMPTS ?? "5"
  );
  const maxAttempts =
    Number.isInteger(parsedMaxAttempts) && parsedMaxAttempts > 0
      ? parsedMaxAttempts
      : 5;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = await createBrowserSession(timeoutMs, {
      // The WAF's acw_tc cookie is short-lived (~30 min). Reusing a persisted,
      // expired cookie causes 405s, so always start from a clean context and
      // let the in-page retry establish a fresh cookie.
      usePersistedState: false,
    });

    try {
      const payload = await queryTrackingViaPage(
        session,
        normalizedTrackingNumber,
        timeoutMs
      );
      return normalizeYunexpressTracking(
        normalizedTrackingNumber,
        trackingUrl,
        payload
      );
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("YunExpress scraping failed");

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    } finally {
      await session.close();
    }
  }

  throw lastError ?? new Error("YunExpress scraping failed");
}
