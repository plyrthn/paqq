import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceHealthMonitor } from "../src/source-health";
import { sourcesRegistry } from "../src/sources";

interface FakeTarget {
  source: string;
  consecutiveFailures: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastCheckedAt?: string;
}

function makeTarget(partial: FakeTarget) {
  return {
    key: `${partial.source}?trackingNumber=${Math.round(
      partial.consecutiveFailures + Math.abs(partial.source.length)
    )}-${partial.lastCheckedAt ?? "x"}`,
    source: partial.source,
    params: { trackingNumber: "T" + partial.consecutiveFailures },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    isDelivered: false,
    consecutiveFailures: partial.consecutiveFailures,
    lastError: partial.lastError,
    lastSuccessAt: partial.lastSuccessAt,
    lastCheckedAt: partial.lastCheckedAt,
  } as any;
}

describe("SourceHealthMonitor", () => {
  let dir: string;
  let targets: any[];
  let notifications: Array<{
    source: string;
    status: string;
    previousStatus: string;
  }>;

  const scheduler = {
    isEnabled: () => true,
    listTargets: async () => targets,
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paqq-health-"));
    targets = [];
    notifications = [];
    sourcesRegistry.initialize({});
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function buildMonitor() {
    return new SourceHealthMonitor(
      {
        PAQQ_SOURCE_HEALTH_STATE_FILE: join(dir, "health.json"),
        PAQQ_SOURCE_HEALTH_MIN_FAILURES: "3",
        PAQQ_SOURCE_HEALTH_MIN_DISTINCT: "2",
      },
      {
        scheduler,
        notifications: {
          notifySourceHealthChange: async (payload) => {
            notifications.push({
              source: payload.source,
              status: payload.status,
              previousStatus: payload.previousStatus,
            });
          },
        },
      }
    );
  }

  it("reports registered sources with no targets as unknown", async () => {
    const monitor = buildMonitor();
    const report = await monitor.getReport();
    const yunexpress = report.find((entry) => entry.source === "yunexpress");
    expect(yunexpress).toBeDefined();
    expect(yunexpress?.status).toBe("unknown");
  });

  it("flags a source down when multiple distinct trackings fail with no success", async () => {
    targets = [
      makeTarget({
        source: "yunexpress",
        consecutiveFailures: 4,
        lastError: "WAF blocked",
        lastCheckedAt: "2026-06-01T00:00:00.000Z",
      }),
      makeTarget({
        source: "yunexpress",
        consecutiveFailures: 3,
        lastError: "WAF blocked",
        lastCheckedAt: "2026-06-01T01:00:00.000Z",
      }),
    ];

    const monitor = buildMonitor();
    await monitor.evaluate();

    const report = await monitor.getReport();
    const yunexpress = report.find((entry) => entry.source === "yunexpress");
    expect(yunexpress?.status).toBe("down");
    expect(yunexpress?.lastError).toBe("WAF blocked");

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      source: "yunexpress",
      status: "down",
    });
  });

  it("treats a single failing tracking number as degraded, not down", async () => {
    targets = [
      makeTarget({
        source: "yunexpress",
        consecutiveFailures: 5,
        lastError: "not found",
        lastCheckedAt: "2026-06-01T00:00:00.000Z",
      }),
      makeTarget({
        source: "yunexpress",
        consecutiveFailures: 0,
        lastSuccessAt: "2026-06-01T02:00:00.000Z",
        lastCheckedAt: "2026-06-01T02:00:00.000Z",
      }),
    ];

    const monitor = buildMonitor();
    await monitor.evaluate();

    const report = await monitor.getReport();
    const yunexpress = report.find((entry) => entry.source === "yunexpress");
    expect(yunexpress?.status).toBe("degraded");
    // Degraded is not a down/recover transition, so no alert is sent.
    expect(notifications).toHaveLength(0);
  });

  it("notifies recovery when a down source starts succeeding again", async () => {
    targets = [
      makeTarget({
        source: "yunexpress",
        consecutiveFailures: 4,
        lastError: "WAF blocked",
        lastCheckedAt: "2026-06-01T00:00:00.000Z",
      }),
      makeTarget({
        source: "yunexpress",
        consecutiveFailures: 3,
        lastError: "WAF blocked",
        lastCheckedAt: "2026-06-01T01:00:00.000Z",
      }),
    ];

    const monitor = buildMonitor();
    await monitor.evaluate();
    expect(notifications).toHaveLength(1);

    // All trackings succeed on the next run.
    targets = [
      makeTarget({
        source: "yunexpress",
        consecutiveFailures: 0,
        lastSuccessAt: "2026-06-02T00:00:00.000Z",
        lastCheckedAt: "2026-06-02T00:00:00.000Z",
      }),
      makeTarget({
        source: "yunexpress",
        consecutiveFailures: 0,
        lastSuccessAt: "2026-06-02T01:00:00.000Z",
        lastCheckedAt: "2026-06-02T01:00:00.000Z",
      }),
    ];

    await monitor.evaluate();

    const report = await monitor.getReport();
    const yunexpress = report.find((entry) => entry.source === "yunexpress");
    expect(yunexpress?.status).toBe("up");
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toMatchObject({
      source: "yunexpress",
      previousStatus: "down",
      status: "up",
    });
  });
});
