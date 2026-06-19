import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  AmazonImportRequest,
  AmazonImportResponse,
  ShipmentInfo,
} from "./types.js";

export interface ScraperRouteHandlers {
  usps: (trackingNumber: string, options: { timeoutMs?: number }) => Promise<ShipmentInfo>;
  uniuni: (trackingNumber: string, options: { timeoutMs?: number }) => Promise<ShipmentInfo>;
  ups: (trackingNumber: string, options: { timeoutMs?: number }) => Promise<ShipmentInfo>;
  yunexpress: (trackingNumber: string, options: { timeoutMs?: number }) => Promise<ShipmentInfo>;
  amazonImport: (payload: AmazonImportRequest) => Promise<AmazonImportResponse>;
}

const TRACKING_ROUTES = new Set([
  "/track",
  "/track/usps",
  "/track/uniuni",
  "/track/ups",
  "/track/yunexpress",
]);
const AMAZON_IMPORT_ROUTE = "/amazon/import";

function jsonResponse(
  res: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function unauthorized(res: ServerResponse): void {
  jsonResponse(res, 401, { error: "Unauthorized" });
}

function getHeaderToken(
  req: IncomingMessage,
  headerName: string
): string | undefined {
  const providedToken = req.headers[headerName];
  if (Array.isArray(providedToken)) {
    return providedToken[0];
  }
  return providedToken;
}

function ensureAuthToken(
  req: IncomingMessage,
  res: ServerResponse,
  envToken: string | undefined,
  headerName: string
): boolean {
  if (!envToken) {
    return true;
  }
  const provided = getHeaderToken(req, headerName);
  if (provided !== envToken) {
    unauthorized(res);
    return false;
  }
  return true;
}

function resolveRoute(
  routePath: string
): "usps" | "uniuni" | "ups" | "yunexpress" {
  if (routePath === "/track" || routePath === "/track/usps") {
    return "usps";
  }
  if (routePath === "/track/ups") {
    return "ups";
  }
  if (routePath === "/track/yunexpress") {
    return "yunexpress";
  }
  return "uniuni";
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseTrackingBody(rawBody: string): {
  trackingNumber: string;
  timeoutMs?: number;
} {
  const body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  const trackingNumber =
    typeof body.trackingNumber === "string" ? body.trackingNumber : "";
  const timeoutMs =
    typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
      ? body.timeoutMs
      : undefined;
  return {
    trackingNumber,
    timeoutMs,
  };
}

function parseJsonBody<T>(rawBody: string): T {
  if (rawBody.length === 0) {
    return {} as T;
  }
  return JSON.parse(rawBody) as T;
}

export function createScraperServer(handlers: ScraperRouteHandlers): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return jsonResponse(res, 200, { ok: true });
      }

      if (req.method === "POST" && req.url === AMAZON_IMPORT_ROUTE) {
        const isAuthorized = ensureAuthToken(
          req,
          res,
          process.env.AMAZON_SCRAPER_TOKEN,
          "x-amazon-scraper-token"
        );
        if (!isAuthorized) {
          return;
        }

        const rawBody = await readRequestBody(req);
        const payload = parseJsonBody<AmazonImportRequest>(rawBody);
        const result = await handlers.amazonImport(payload);
        return jsonResponse(
          res,
          result.status === "totp_required" ? 202 : 200,
          result
        );
      }

      if (
        req.method !== "POST" ||
        !req.url ||
        !TRACKING_ROUTES.has(req.url)
      ) {
        return jsonResponse(res, 404, { error: "Not found" });
      }

      const route = resolveRoute(req.url);

      if (route === "usps") {
        const isAuthorized = ensureAuthToken(
          req,
          res,
          process.env.USPS_SCRAPER_TOKEN,
          "x-usps-scraper-token"
        );
        if (!isAuthorized) {
          return;
        }
      } else if (route === "uniuni") {
        const isAuthorized = ensureAuthToken(
          req,
          res,
          process.env.UNIUNI_SCRAPER_TOKEN,
          "x-uniuni-scraper-token"
        );
        if (!isAuthorized) {
          return;
        }
      } else if (route === "yunexpress") {
        const isAuthorized = ensureAuthToken(
          req,
          res,
          process.env.YUNEXPRESS_SCRAPER_TOKEN,
          "x-yunexpress-scraper-token"
        );
        if (!isAuthorized) {
          return;
        }
      } else {
        const isAuthorized = ensureAuthToken(
          req,
          res,
          process.env.UPS_SCRAPER_TOKEN,
          "x-ups-scraper-token"
        );
        if (!isAuthorized) {
          return;
        }
      }

      const rawBody = await readRequestBody(req);
      const { trackingNumber, timeoutMs } = parseTrackingBody(rawBody);

      if (!trackingNumber) {
        return jsonResponse(res, 400, { error: "trackingNumber is required" });
      }

      const shipment =
        route === "usps"
          ? await handlers.usps(trackingNumber, { timeoutMs })
          : route === "uniuni"
          ? await handlers.uniuni(trackingNumber, { timeoutMs })
          : route === "yunexpress"
          ? await handlers.yunexpress(trackingNumber, { timeoutMs })
          : await handlers.ups(trackingNumber, { timeoutMs });
      return jsonResponse(res, 200, shipment);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected scraper error";
      return jsonResponse(res, 500, { error: message });
    }
  });
}
