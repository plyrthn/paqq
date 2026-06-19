import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserContext, BrowserContextOptions } from "playwright";

export type CarrierSessionKey =
  | "amazon"
  | "ups"
  | "usps"
  | "uniuni"
  | "yunexpress";
type PersistedStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

function compact(value: string | undefined | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
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

function getGlobalPersistSetting(): boolean {
  return parseBoolean(process.env.PAQQ_SCRAPER_PERSIST_SESSION_STATE, true);
}

function getCarrierPersistSetting(carrier: CarrierSessionKey): boolean {
  const globalSetting = getGlobalPersistSetting();
  const key = `${carrier.toUpperCase()}_PERSIST_SESSION_STATE`;
  return parseBoolean(process.env[key], globalSetting);
}

function resolveDefaultStateDir(): string {
  const configured = compact(process.env.PAQQ_SCRAPER_STATE_DIR);
  if (configured) {
    return configured;
  }

  if (existsSync("/workspace/scraper-run")) {
    return "/workspace/scraper-run/state";
  }

  if (existsSync("/app/data")) {
    return "/app/data/scraper-state";
  }

  return join(process.cwd(), ".paqq-scraper-state");
}

function getCarrierStateFile(carrier: CarrierSessionKey): string {
  const baseDir = resolveDefaultStateDir();
  return join(baseDir, `${carrier}.storage-state.json`);
}

async function readCarrierStorageState(
  carrier: CarrierSessionKey
): Promise<PersistedStorageState | undefined> {
  const stateFile = getCarrierStateFile(carrier);
  try {
    const raw = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as PersistedStorageState;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function withCarrierSessionState(
  carrier: CarrierSessionKey,
  contextOptions: BrowserContextOptions
): Promise<BrowserContextOptions> {
  if (!getCarrierPersistSetting(carrier)) {
    return contextOptions;
  }

  if (typeof contextOptions.storageState !== "undefined") {
    return contextOptions;
  }

  const persisted = await readCarrierStorageState(carrier);
  if (!persisted) {
    return contextOptions;
  }

  return {
    ...contextOptions,
    storageState: persisted,
  };
}

export async function persistCarrierSessionState(
  carrier: CarrierSessionKey,
  context: BrowserContext
): Promise<void> {
  if (!getCarrierPersistSetting(carrier)) {
    return;
  }

  const state = await context.storageState();
  const stateFile = getCarrierStateFile(carrier);
  await mkdir(dirname(stateFile), { recursive: true });
  const tmpFile = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpFile, JSON.stringify(state), "utf8");
  await rename(tmpFile, stateFile);
}
