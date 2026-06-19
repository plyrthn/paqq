import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ShipmentInfo } from "./schemas/shipment";
import { sourcesRegistry } from "./sources";
import { resolveEnvWithSettings, type PaqqSettings } from "./settings-schema";

type RuntimeEnv = Record<string, string | undefined>;

interface WatchedTarget {
  source: string;
  params: Record<string, string>;
  friendlyName?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: number;
  deliveredAt?: string;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  lastResult?: ShipmentInfo;
}

interface SchedulerState {
  version: 1;
  watchedTargets: Record<string, WatchedTarget>;
}

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  watchedCount: number;
  stateFile: string;
  lastRunStartedAt?: string;
  lastRunCompletedAt?: string;
  nextRunAt?: string;
}

export interface WatchedTargetView {
  key: string;
  source: string;
  params: Record<string, string>;
  friendlyName?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  deliveredAt?: string;
  isDelivered: boolean;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  lastResult?: ShipmentInfo;
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

function parsePositiveInteger(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function sortParams(params: Record<string, string>): Record<string, string> {
  const sortedEntries = Object.entries(params).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const sorted: Record<string, string> = {};
  for (const [key, value] of sortedEntries) {
    sorted[key] = value;
  }
  return sorted;
}

function buildTargetKey(source: string, params: Record<string, string>): string {
  const sorted = sortParams(params);
  const serializedParams = Object.entries(sorted)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join("&");
  return `${source}?${serializedParams}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isDelivered(result: ShipmentInfo | undefined): boolean {
  if (!result) {
    return false;
  }
  if (String(result.status?.code ?? "").trim() === "5") {
    return true;
  }
  const description = String(result.status?.description ?? "").toLowerCase();
  return description.includes("deliver");
}

export class TrackingScheduler {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly stateFile: string;
  private readonly runOnStart: boolean;

  private readonly state: SchedulerState = {
    version: 1,
    watchedTargets: {},
  };

  private loadPromise: Promise<void> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunStartedAt?: string;
  private lastRunCompletedAt?: string;
  private nextRunAt?: string;
  private afterRunHook: (() => Promise<void> | void) | null = null;

  constructor(
    private readonly env: RuntimeEnv,
    private readonly services: {
      settings?: { getSettings: () => Promise<PaqqSettings> };
      notifications?: {
        notifyTrackingUpdate: (payload: {
          source: string;
          params: Record<string, string>;
          friendlyName?: string;
          previousResult?: ShipmentInfo;
          result: ShipmentInfo;
        }) => Promise<void>;
      };
    } = {}
  ) {
    this.enabled = parseBoolean(
      env.PAQQ_TRACKING_SCHEDULER_ENABLED,
      true
    );
    this.intervalMs = parsePositiveInteger(
      env.PAQQ_TRACKING_SCHEDULER_INTERVAL_MS,
      4 * 60 * 60 * 1000
    );
    this.stateFile =
      env.PAQQ_TRACKING_SCHEDULER_STATE_FILE ??
      "/app/data/tracking-scheduler-state.json";
    this.runOnStart = parseBoolean(
      env.PAQQ_TRACKING_SCHEDULER_RUN_ON_START,
      true
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setAfterRunHook(hook: (() => Promise<void> | void) | null): void {
    this.afterRunHook = hook;
  }

  getStatus(): SchedulerStatus {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      watchedCount: Object.keys(this.state.watchedTargets).length,
      stateFile: this.stateFile,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunCompletedAt: this.lastRunCompletedAt,
      nextRunAt: this.nextRunAt,
    };
  }

  async listTargets(): Promise<WatchedTargetView[]> {
    if (!this.enabled) {
      return [];
    }

    await this.ensureLoaded();

    return Object.entries(this.state.watchedTargets)
      .map(([key, target]) => ({
        key,
        source: target.source,
        params: target.params,
        friendlyName: target.friendlyName,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
        nextRunAt:
          target.nextRunAt >= Number.MAX_SAFE_INTEGER
            ? undefined
            : new Date(target.nextRunAt).toISOString(),
        deliveredAt: target.deliveredAt,
        isDelivered: Boolean(target.deliveredAt),
        lastCheckedAt: target.lastCheckedAt,
        lastSuccessAt: target.lastSuccessAt,
        lastError: target.lastError,
        consecutiveFailures: target.consecutiveFailures,
        lastResult: target.lastResult,
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (this.timer) {
      return;
    }

    await this.ensureLoaded();

    this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
    this.timer = setInterval(() => {
      void this.runNow().catch((error) => {
        console.error("Tracking scheduler run failed:", error);
      });
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }

    if (this.runOnStart) {
      void this.runNow({ force: true }).catch((error) => {
        console.error("Tracking scheduler startup run failed:", error);
      });
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextRunAt = undefined;
  }

  async registerTarget(
    source: string,
    params: Record<string, string>,
    options: { friendlyName?: string } = {}
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.ensureLoaded();

    const key = buildTargetKey(source, params);
    const existing = this.state.watchedTargets[key];
    const now = Date.now();
    const updatedAt = nowIso();
    const sortedParams = sortParams(params);

    this.state.watchedTargets[key] = {
      source,
      params: sortedParams,
      friendlyName: options.friendlyName ?? existing?.friendlyName,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
      nextRunAt: existing?.deliveredAt
        ? Number.MAX_SAFE_INTEGER
        : existing?.nextRunAt ?? now + this.intervalMs,
      deliveredAt: existing?.deliveredAt,
      lastCheckedAt: existing?.lastCheckedAt,
      lastSuccessAt: existing?.lastSuccessAt,
      lastError: existing?.lastError,
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      lastResult: existing?.lastResult,
    };

    await this.queueSave();
  }

  async unregisterTarget(
    source: string,
    params: Record<string, string>
  ): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    await this.ensureLoaded();

    const key = buildTargetKey(source, params);
    const existed = typeof this.state.watchedTargets[key] !== "undefined";
    if (existed) {
      delete this.state.watchedTargets[key];
      await this.queueSave();
    }
    return existed;
  }

  async recordSuccess(
    source: string,
    params: Record<string, string>,
    result: ShipmentInfo
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.ensureLoaded();

    const key = buildTargetKey(source, params);
    const existing = this.state.watchedTargets[key];
    const now = Date.now();
    const timestamp = nowIso();
    const sortedParams = sortParams(params);

    this.state.watchedTargets[key] = {
      source,
      params: sortedParams,
      friendlyName: existing?.friendlyName,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      nextRunAt: isDelivered(result)
        ? Number.MAX_SAFE_INTEGER
        : now + this.intervalMs,
      deliveredAt: isDelivered(result) ? timestamp : undefined,
      lastCheckedAt: timestamp,
      lastSuccessAt: timestamp,
      lastError: undefined,
      consecutiveFailures: 0,
      lastResult: result,
    };

    await this.queueSave();
  }

  async recordFailure(
    source: string,
    params: Record<string, string>,
    message: string
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.ensureLoaded();

    const key = buildTargetKey(source, params);
    const existing = this.state.watchedTargets[key];
    const now = Date.now();
    const timestamp = nowIso();
    const sortedParams = sortParams(params);

    this.state.watchedTargets[key] = {
      source,
      params: sortedParams,
      friendlyName: existing?.friendlyName,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      nextRunAt: existing?.deliveredAt
        ? Number.MAX_SAFE_INTEGER
        : now + this.intervalMs,
      deliveredAt: existing?.deliveredAt,
      lastCheckedAt: timestamp,
      lastSuccessAt: existing?.lastSuccessAt,
      lastError: message,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      lastResult: existing?.lastResult,
    };

    await this.queueSave();
  }

  async runNow(options: { force?: boolean } = {}): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    await this.ensureLoaded();

    if (this.running) {
      return false;
    }

    this.running = true;
    this.lastRunStartedAt = nowIso();

    try {
      const force = options.force === true;
      const currentTime = Date.now();

      const runtimeEnv = await this.resolveRuntimeEnv();
      sourcesRegistry.initialize(runtimeEnv);

      for (const [key, target] of Object.entries(this.state.watchedTargets)) {
        if (!force && target.deliveredAt) {
          continue;
        }
        if (!force && target.nextRunAt > currentTime) {
          continue;
        }

        const source = sourcesRegistry.get(target.source);
        if (!source) {
          this.applyFailure(
            key,
            target,
            `Source '${target.source}' is not available`
          );
          continue;
        }

        try {
          const previousResult = target.lastResult;
          const result = await source.getTracking(target.params, runtimeEnv);
          this.applySuccess(key, target, result);
          if (this.services.notifications && previousResult) {
            await this.services.notifications.notifyTrackingUpdate({
              source: target.source,
              params: target.params,
              friendlyName: target.friendlyName,
              previousResult,
              result,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "server error";
          this.applyFailure(key, target, message);
        }
      }

      await this.queueSave();

      if (this.afterRunHook) {
        try {
          await this.afterRunHook();
        } catch (error) {
          console.error("Scheduler after-run hook failed:", error);
        }
      }

      return true;
    } finally {
      this.lastRunCompletedAt = nowIso();
      this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
      this.running = false;
    }
  }

  private applySuccess(
    key: string,
    target: WatchedTarget,
    result: ShipmentInfo
  ): void {
    const now = Date.now();
    const timestamp = nowIso();
    this.state.watchedTargets[key] = {
      ...target,
      updatedAt: timestamp,
      nextRunAt: isDelivered(result)
        ? Number.MAX_SAFE_INTEGER
        : now + this.intervalMs,
      deliveredAt: isDelivered(result) ? timestamp : undefined,
      lastCheckedAt: timestamp,
      lastSuccessAt: timestamp,
      lastError: undefined,
      consecutiveFailures: 0,
      lastResult: result,
    };
  }

  private applyFailure(
    key: string,
    target: WatchedTarget,
    message: string
  ): void {
    const now = Date.now();
    const timestamp = nowIso();
    this.state.watchedTargets[key] = {
      ...target,
      updatedAt: timestamp,
      nextRunAt: target.deliveredAt ? Number.MAX_SAFE_INTEGER : now + this.intervalMs,
      lastCheckedAt: timestamp,
      lastError: message,
      consecutiveFailures: target.consecutiveFailures + 1,
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadState();
    }
    await this.loadPromise;
  }

  private async resolveRuntimeEnv(): Promise<RuntimeEnv> {
    if (!this.services.settings) {
      return this.env;
    }

    const settings = await this.services.settings.getSettings();
    return resolveEnvWithSettings(this.env, settings);
  }

  private async loadState(): Promise<void> {
    try {
      const content = await readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(content) as Partial<SchedulerState>;
      const targets = parsed.watchedTargets;
      if (targets && typeof targets === "object") {
        this.state.watchedTargets = targets as Record<string, WatchedTarget>;
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== "ENOENT") {
        throw error;
      }
      await this.queueSave();
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
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
  }
}
