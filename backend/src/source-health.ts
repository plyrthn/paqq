import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sourcesRegistry } from "./sources";
import type { TrackingScheduler, WatchedTargetView } from "./scheduler";

type RuntimeEnv = Record<string, string | undefined>;

export type SourceHealthStatus = "up" | "degraded" | "down" | "unknown";

export interface SourceHealthReport {
  source: string;
  status: SourceHealthStatus;
  watchedCount: number;
  failingCount: number;
  healthyCount: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  since?: string;
  updatedAt: string;
}

interface PersistedSourceState {
  status: SourceHealthStatus;
  since: string;
  lastError?: string;
}

interface SourceHealthState {
  version: 1;
  sources: Record<string, PersistedSourceState>;
}

interface SourceHealthServices {
  scheduler: Pick<TrackingScheduler, "listTargets" | "isEnabled">;
  settings?: unknown;
  notifications?: {
    notifySourceHealthChange: (payload: {
      source: string;
      status: SourceHealthStatus;
      previousStatus: SourceHealthStatus;
      report: SourceHealthReport;
    }) => Promise<void>;
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function maxIso(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (!best || value.localeCompare(best) > 0) {
      best = value;
    }
  }
  return best;
}

export class SourceHealthMonitor {
  private readonly enabled: boolean;
  private readonly minFailures: number;
  private readonly minDistinct: number;
  private readonly stateFile: string;

  private readonly state: SourceHealthState = {
    version: 1,
    sources: {},
  };

  private loadPromise: Promise<void> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    env: RuntimeEnv,
    private readonly services: SourceHealthServices
  ) {
    this.enabled = parseBoolean(env.PAQQ_SOURCE_HEALTH_ENABLED, true);
    this.minFailures = parsePositiveInteger(
      env.PAQQ_SOURCE_HEALTH_MIN_FAILURES,
      3
    );
    this.minDistinct = parsePositiveInteger(
      env.PAQQ_SOURCE_HEALTH_MIN_DISTINCT,
      2
    );
    this.stateFile =
      env.PAQQ_SOURCE_HEALTH_STATE_FILE ??
      "/app/data/source-health-state.json";
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // Read-only view used by the API. No notifications, no persistence side effects.
  async getReport(): Promise<SourceHealthReport[]> {
    await this.ensureLoaded();
    const targets = await this.collectTargets();
    return this.deriveReports(targets);
  }

  // Called after each scheduler run. Detects up/down transitions and notifies.
  async evaluate(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.ensureLoaded();
    const targets = await this.collectTargets();
    const reports = this.deriveReports(targets);
    let changed = false;

    for (const report of reports) {
      if (report.status === "unknown") {
        // Don't churn state or alert on sources we have no signal for.
        continue;
      }

      const previous = this.state.sources[report.source];
      const previousStatus: SourceHealthStatus = previous?.status ?? "unknown";

      if (previousStatus !== report.status) {
        this.state.sources[report.source] = {
          status: report.status,
          since: nowIso(),
          lastError: report.lastError,
        };
        changed = true;

        const enteredDown = report.status === "down";
        const recoveredFromDown =
          previousStatus === "down" && report.status !== "down";

        if (
          (enteredDown || recoveredFromDown) &&
          this.services.notifications
        ) {
          await this.services.notifications
            .notifySourceHealthChange({
              source: report.source,
              status: report.status,
              previousStatus,
              report,
            })
            .catch((error) => {
              console.error("Source health notification failed:", error);
            });
        }
      } else if (previous && previous.lastError !== report.lastError) {
        this.state.sources[report.source] = {
          ...previous,
          lastError: report.lastError,
        };
        changed = true;
      }
    }

    if (changed) {
      await this.queueSave();
    }
  }

  private async collectTargets(): Promise<WatchedTargetView[]> {
    if (!this.services.scheduler.isEnabled()) {
      return [];
    }
    try {
      return await this.services.scheduler.listTargets();
    } catch (error) {
      console.error("Source health failed to read scheduler targets:", error);
      return [];
    }
  }

  private deriveReports(targets: WatchedTargetView[]): SourceHealthReport[] {
    const grouped = new Map<string, WatchedTargetView[]>();
    for (const target of targets) {
      const list = grouped.get(target.source) ?? [];
      list.push(target);
      grouped.set(target.source, list);
    }

    // Include every registered source so the API reports carriers with no
    // watched packages as "unknown" rather than omitting them.
    const sourceNames = new Set<string>(grouped.keys());
    for (const [name] of sourcesRegistry.entries()) {
      sourceNames.add(name);
    }

    const updatedAt = nowIso();
    const reports: SourceHealthReport[] = [];

    for (const source of [...sourceNames].sort()) {
      const sourceTargets = grouped.get(source) ?? [];
      const watchedCount = sourceTargets.length;

      const failing = sourceTargets.filter(
        (target) => target.consecutiveFailures >= this.minFailures
      );
      // A target whose most recent check succeeded proves the source backend
      // still works, so a single bad tracking number can't read as "down".
      const healthy = sourceTargets.filter(
        (target) =>
          target.consecutiveFailures === 0 &&
          Boolean(target.lastCheckedAt ?? target.lastSuccessAt)
      );

      let status: SourceHealthStatus;
      if (watchedCount === 0) {
        status = "unknown";
      } else if (failing.length >= this.minDistinct && healthy.length === 0) {
        status = "down";
      } else if (failing.length > 0) {
        status = "degraded";
      } else {
        status = "up";
      }

      const lastSuccessAt = maxIso(
        sourceTargets.map((target) => target.lastSuccessAt)
      );
      const failingChecked = sourceTargets
        .filter((target) => Boolean(target.lastError))
        .sort((left, right) =>
          (right.lastCheckedAt ?? "").localeCompare(left.lastCheckedAt ?? "")
        );
      const lastFailureAt = maxIso(
        failingChecked.map((target) => target.lastCheckedAt)
      );
      const lastError = failingChecked[0]?.lastError;

      const persisted = this.state.sources[source];
      const since =
        persisted && persisted.status === status ? persisted.since : undefined;

      reports.push({
        source,
        status,
        watchedCount,
        failingCount: failing.length,
        healthyCount: healthy.length,
        lastSuccessAt,
        lastFailureAt,
        lastError,
        since,
        updatedAt,
      });
    }

    return reports;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadState();
    }
    await this.loadPromise;
  }

  private async loadState(): Promise<void> {
    try {
      const content = await readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(content) as Partial<SourceHealthState>;
      if (parsed.sources && typeof parsed.sources === "object") {
        this.state.sources = parsed.sources as Record<
          string,
          PersistedSourceState
        >;
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== "ENOENT") {
        console.error("Failed to load source health state:", error);
      }
    }
  }

  private queueSave(): Promise<void> {
    const next = this.saveQueue
      .catch(() => undefined)
      .then(async () => this.saveState());
    this.saveQueue = next;
    return next;
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    await writeFile(
      this.stateFile,
      JSON.stringify(this.state, null, 2),
      "utf8"
    );
  }
}
