import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { handleGet } from "../src/handlers/get";
import { handleList } from "../src/handlers/list";
import { sourcesRegistry } from "../src/sources";

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

async function createMockScraperServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
    requests: CapturedRequest[]
  ) => void
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
    });

    handler(req, res, body, requests);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const serversToClose: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (serversToClose.length > 0) {
    const close = serversToClose.pop();
    if (close) {
      await close();
    }
  }
});

describe("YunExpress source integration", () => {
  it("includes YunExpress in /api/list", async () => {
    sourcesRegistry.initialize({
      YUNEXPRESS_SCRAPER_URL: "http://127.0.0.1:8790",
    });

    const response = await handleList(new Request("https://paqq.test/api/list"));
    const sources = (await response.json()) as Array<{
      name: string;
      requiredFields: string[];
      icon?: string;
    }>;

    const yunexpress = sources.find((source) => source.name === "yunexpress");

    expect(yunexpress).toBeDefined();
    expect(yunexpress?.requiredFields).toEqual(["trackingNumber"]);
    expect(yunexpress?.icon).toBe("yunexpress.webp");
  });

  it("retrieves YunExpress tracking via configured scraper service", async () => {
    const server = await createMockScraperServer((req, res, body) => {
      if (req.url !== "/track/yunexpress" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          trackingNumber: "YT2521800703039536",
          trackingUrl:
            "https://www.yuntrack.com/parcelTracking?id=YT2521800703039536",
          carrier: "yunexpress",
          status: {
            code: "5",
            description: "Delivered. , Evidence",
            timestamp: "2025-08-18T10:14:33.000Z",
            location: "Nürnberg (DE)",
          },
          events: [
            {
              code: "5",
              description: "Delivered. , Evidence",
              timestamp: "2025-08-18T10:14:33.000Z",
              location: "Nürnberg (DE)",
            },
          ],
        })
      );

      const parsed = JSON.parse(body);
      expect(parsed.trackingNumber).toBe("YT2521800703039536");
      expect(parsed.timeoutMs).toBe(45000);
    });

    serversToClose.push(server.close);

    const env = {
      YUNEXPRESS_SCRAPER_URL: server.baseUrl,
      YUNEXPRESS_SCRAPER_TOKEN: "yunexpress-token",
      YUNEXPRESS_SCRAPER_TIMEOUT_MS: "45000",
    };
    sourcesRegistry.initialize(env);

    const response = await handleGet(
      new Request(
        "https://paqq.test/api/get?source=yunexpress&trackingNumber=YT2521800703039536"
      ),
      env
    );

    expect(response.status).toBe(200);
    const shipment = (await response.json()) as {
      carrier: string;
      trackingNumber: string;
      status: { description: string };
      events: Array<{ description: string }>;
    };

    expect(shipment.carrier).toBe("yunexpress");
    expect(shipment.trackingNumber).toBe("YT2521800703039536");
    expect(shipment.status.description).toContain("Delivered");
    expect(shipment.events.length).toBeGreaterThan(0);

    expect(server.requests.length).toBe(1);
    expect(server.requests[0].headers["x-yunexpress-scraper-token"]).toBe(
      "yunexpress-token"
    );
  });

  it("returns backend error when YunExpress scraper fails", async () => {
    const server = await createMockScraperServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "YunExpress WAF blocked this request" }));
    });

    serversToClose.push(server.close);

    const env = {
      YUNEXPRESS_SCRAPER_URL: server.baseUrl,
      YUNEXPRESS_SCRAPER_TIMEOUT_MS: "60000",
    };

    sourcesRegistry.initialize(env);

    const response = await handleGet(
      new Request(
        "https://paqq.test/api/get?source=yunexpress&trackingNumber=YT2521800703039536"
      ),
      env
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("YunExpress WAF blocked this request");
  });
});
