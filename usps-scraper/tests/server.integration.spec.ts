import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createScraperServer } from "../src/server-app.js";

interface RunningServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startServer(
  handlers: {
    usps: Parameters<typeof createScraperServer>[0]["usps"];
    uniuni: Parameters<typeof createScraperServer>[0]["uniuni"];
    ups: Parameters<typeof createScraperServer>[0]["ups"];
    yunexpress: Parameters<typeof createScraperServer>[0]["yunexpress"];
    amazonImport: Parameters<typeof createScraperServer>[0]["amazonImport"];
  }
): Promise<RunningServer> {
  const server = createScraperServer(handlers);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  delete process.env.USPS_SCRAPER_TOKEN;
  delete process.env.UNIUNI_SCRAPER_TOKEN;
  delete process.env.UPS_SCRAPER_TOKEN;
  delete process.env.YUNEXPRESS_SCRAPER_TOKEN;
  delete process.env.AMAZON_SCRAPER_TOKEN;

  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) {
      await task();
    }
  }
});

describe("scraper server routing", () => {
  it("routes /track/ups requests and enforces UPS token when configured", async () => {
    process.env.UPS_SCRAPER_TOKEN = "ups-secret";
    const ups = vi.fn().mockResolvedValue({
      trackingNumber: "1Z262AY97298603378",
      trackingUrl: "https://www.ups.com/track?loc=en_US&tracknum=1Z262AY97298603378",
      carrier: "ups",
      status: {
        code: "3",
        description: "On the way",
        timestamp: "2026-03-02T12:42:00.000Z",
      },
      events: [
        {
          code: "3",
          description: "On the way",
          timestamp: "2026-03-02T12:42:00.000Z",
        },
      ],
    });
    const server = await startServer({
      usps: vi.fn(),
      uniuni: vi.fn(),
      ups,
      yunexpress: vi.fn(),
      amazonImport: vi.fn(),
    });
    cleanupTasks.push(server.close);

    const unauthorized = await fetch(`${server.baseUrl}/track/ups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackingNumber: "1Z262AY97298603378" }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${server.baseUrl}/track/ups`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ups-scraper-token": "ups-secret",
      },
      body: JSON.stringify({
        trackingNumber: "1Z262AY97298603378",
        timeoutMs: 45000,
      }),
    });
    expect(authorized.status).toBe(200);
    expect(ups).toHaveBeenCalledTimes(1);
    expect(ups.mock.calls[0][0]).toBe("1Z262AY97298603378");
    expect(ups.mock.calls[0][1]).toEqual({ timeoutMs: 45000 });
  });

  it("routes /track and /track/usps to USPS handler", async () => {
    const usps = vi.fn().mockResolvedValue({
      trackingNumber: "9400150208203004850386",
      trackingUrl:
        "https://tools.usps.com/go/TrackConfirmAction.action?tLabels=9400150208203004850386",
      carrier: "usps",
      status: {
        code: "3",
        description: "In Transit",
        timestamp: "2026-03-02T10:00:00.000Z",
      },
      events: [
        {
          code: "3",
          description: "In Transit",
          timestamp: "2026-03-02T10:00:00.000Z",
        },
      ],
    });
    const server = await startServer({
      usps,
      uniuni: vi.fn(),
      ups: vi.fn(),
      yunexpress: vi.fn(),
      amazonImport: vi.fn(),
    });
    cleanupTasks.push(server.close);

    const baseRequest = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackingNumber: "9400150208203004850386" }),
    } as const;

    const responseA = await fetch(`${server.baseUrl}/track`, baseRequest);
    const responseB = await fetch(`${server.baseUrl}/track/usps`, baseRequest);

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(usps).toHaveBeenCalledTimes(2);
  });

  it("routes /track/yunexpress requests and enforces YunExpress token when configured", async () => {
    process.env.YUNEXPRESS_SCRAPER_TOKEN = "yunexpress-secret";
    const yunexpress = vi.fn().mockResolvedValue({
      trackingNumber: "YT2521800703039536",
      trackingUrl:
        "https://www.yuntrack.com/parcelTracking?id=YT2521800703039536",
      carrier: "yunexpress",
      status: {
        code: "5",
        description: "Delivered",
        timestamp: "2025-08-18T10:14:33.000Z",
      },
      events: [
        {
          code: "5",
          description: "Delivered",
          timestamp: "2025-08-18T10:14:33.000Z",
        },
      ],
    });
    const server = await startServer({
      usps: vi.fn(),
      uniuni: vi.fn(),
      ups: vi.fn(),
      yunexpress,
      amazonImport: vi.fn(),
    });
    cleanupTasks.push(server.close);

    const unauthorized = await fetch(`${server.baseUrl}/track/yunexpress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackingNumber: "YT2521800703039536" }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${server.baseUrl}/track/yunexpress`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-yunexpress-scraper-token": "yunexpress-secret",
      },
      body: JSON.stringify({
        trackingNumber: "YT2521800703039536",
        timeoutMs: 45000,
      }),
    });
    expect(authorized.status).toBe(200);
    expect(yunexpress).toHaveBeenCalledTimes(1);
    expect(yunexpress.mock.calls[0][0]).toBe("YT2521800703039536");
    expect(yunexpress.mock.calls[0][1]).toEqual({ timeoutMs: 45000 });
  });

  it("routes /amazon/import and enforces Amazon token when configured", async () => {
    process.env.AMAZON_SCRAPER_TOKEN = "amazon-secret";
    const amazonImport = vi.fn().mockResolvedValue({
      status: "totp_required",
      challengeId: "challenge-123",
      expiresAt: "2026-03-03T20:00:00.000Z",
    });

    const server = await startServer({
      usps: vi.fn(),
      uniuni: vi.fn(),
      ups: vi.fn(),
      yunexpress: vi.fn(),
      amazonImport,
    });
    cleanupTasks.push(server.close);

    const unauthorized = await fetch(`${server.baseUrl}/amazon/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "user@example.com",
        password: "secret",
      }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${server.baseUrl}/amazon/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amazon-scraper-token": "amazon-secret",
      },
      body: JSON.stringify({
        username: "user@example.com",
        password: "secret",
        maxShipments: 12,
      }),
    });

    expect(authorized.status).toBe(202);
    expect(amazonImport).toHaveBeenCalledTimes(1);
    expect(amazonImport.mock.calls[0][0]).toEqual({
      username: "user@example.com",
      password: "secret",
      maxShipments: 12,
    });
  });
});
