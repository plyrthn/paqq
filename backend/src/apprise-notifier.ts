import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ShipmentInfo } from "./schemas/shipment";
import type { PaqqSettings, RuntimeEnv } from "./settings-schema";

const execFileAsync = promisify(execFile);

interface SettingsProvider {
  getSettings: () => Promise<PaqqSettings>;
}

interface TrackingUpdatePayload {
  source: string;
  params: Record<string, string>;
  friendlyName?: string;
  previousResult?: ShipmentInfo;
  result: ShipmentInfo;
}

function compact(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
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

function hasStatusChanged(previous: ShipmentInfo, next: ShipmentInfo): boolean {
  const leftCode = String(previous.status?.code ?? "").trim();
  const rightCode = String(next.status?.code ?? "").trim();
  const leftDescription = String(previous.status?.description ?? "").trim();
  const rightDescription = String(next.status?.description ?? "").trim();
  const leftTimestamp = String(previous.status?.timestamp ?? "").trim();
  const rightTimestamp = String(next.status?.timestamp ?? "").trim();
  return (
    leftCode !== rightCode ||
    leftDescription !== rightDescription ||
    leftTimestamp !== rightTimestamp
  );
}

function buildTrackingUrl(payload: TrackingUpdatePayload): string | undefined {
  const fromResult = compact(payload.result.trackingUrl);
  if (fromResult) {
    return fromResult;
  }

  const trackingNumber = compact(payload.result.trackingNumber);
  if (!trackingNumber) {
    return undefined;
  }

  if (payload.source === "usps") {
    return `https://tools.usps.com/go/TrackConfirmAction.action?tLabels=${encodeURIComponent(
      trackingNumber
    )}`;
  }
  if (payload.source === "uniuni") {
    return "https://www.uniuni.com/tracking/";
  }
  if (payload.source === "ups") {
    return `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(
      trackingNumber
    )}`;
  }
  if (payload.source === "yunexpress") {
    return `https://www.yuntrack.com/parcelTracking?id=${encodeURIComponent(
      trackingNumber
    )}`;
  }

  return undefined;
}

export class AppriseNotifier {
  private readonly pythonBin: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly env: RuntimeEnv,
    private readonly settingsProvider: SettingsProvider
  ) {
    this.pythonBin = compact(env.PAQQ_APPRISE_PYTHON_BIN) ?? "python3";
    this.timeoutMs = parsePositiveInteger(
      compact(env.PAQQ_APPRISE_TIMEOUT_MS),
      20_000
    );
  }

  async sendTestNotification(): Promise<{ ok: boolean; detail?: string }> {
    const settings = await this.settingsProvider.getSettings();
    const config = settings.notifications;
    if (!config.enabled) {
      return { ok: false, detail: "Notifications are disabled." };
    }
    if (config.appriseUrls.length === 0) {
      return { ok: false, detail: "No Apprise URLs configured." };
    }

    const now = new Date().toISOString();
    const result = await this.sendAppriseMessage(
      config.appriseUrls,
      "Paqq test notification",
      `Apprise integration is configured.\nTime: ${now}`
    );
    return result.ok
      ? { ok: true }
      : { ok: false, detail: result.detail ?? "Failed to send notification" };
  }

  async notifyTrackingUpdate(payload: TrackingUpdatePayload): Promise<void> {
    const settings = await this.settingsProvider.getSettings();
    const config = settings.notifications;

    if (!config.enabled || config.appriseUrls.length === 0) {
      return;
    }

    const previous = payload.previousResult;
    if (!previous) {
      return;
    }

    const changed = hasStatusChanged(previous, payload.result);
    const wasDelivered = isDelivered(previous);
    const nowDelivered = isDelivered(payload.result);
    const becameDelivered = !wasDelivered && nowDelivered;

    const shouldNotifyStatus = config.notifyOnStatusChange && changed;
    const shouldNotifyDelivered = config.notifyOnDelivered && becameDelivered;

    if (!shouldNotifyStatus && !shouldNotifyDelivered) {
      return;
    }

    const displayName =
      compact(payload.friendlyName) ??
      compact(payload.result.trackingNumber) ??
      payload.source.toUpperCase();
    const trackingNumber =
      compact(payload.result.trackingNumber) ??
      compact(payload.params.trackingNumber) ??
      "N/A";

    const previousStatus = `${previous.status.code}: ${previous.status.description}`;
    const nextStatus = `${payload.result.status.code}: ${payload.result.status.description}`;
    const statusLine = becameDelivered
      ? `Delivered update for ${displayName}`
      : `Status update for ${displayName}`;

    const title = becameDelivered
      ? `Paqq: ${displayName} delivered`
      : `Paqq: ${displayName} status changed`;
    const bodyLines = [
      statusLine,
      `Carrier: ${payload.source.toUpperCase()}`,
      `Tracking: ${trackingNumber}`,
      `From: ${previousStatus}`,
      `To: ${nextStatus}`,
    ];

    if (compact(payload.result.status.location)) {
      bodyLines.push(`Location: ${payload.result.status.location}`);
    }
    if (compact(payload.result.status.timestamp)) {
      bodyLines.push(`Timestamp: ${payload.result.status.timestamp}`);
    }

    const trackingUrl = buildTrackingUrl(payload);
    if (trackingUrl) {
      bodyLines.push(`URL: ${trackingUrl}`);
    }

    const result = await this.sendAppriseMessage(
      config.appriseUrls,
      title,
      bodyLines.join("\n")
    );
    if (!result.ok) {
      console.error("Apprise notification failed:", result.detail);
    }
  }

  async notifySourceHealthChange(payload: {
    source: string;
    status: "up" | "degraded" | "down" | "unknown";
    previousStatus: "up" | "degraded" | "down" | "unknown";
    report: {
      failingCount: number;
      watchedCount: number;
      lastError?: string;
      lastSuccessAt?: string;
      since?: string;
    };
  }): Promise<void> {
    const settings = await this.settingsProvider.getSettings();
    const config = settings.notifications;

    if (!config.enabled || config.appriseUrls.length === 0) {
      return;
    }

    const sourceName = payload.source.toUpperCase();
    const isDown = payload.status === "down";
    const title = isDown
      ? `Paqq: ${sourceName} source is down`
      : `Paqq: ${sourceName} source recovered`;

    const bodyLines = [
      isDown
        ? `Tracking source ${sourceName} appears to be down.`
        : `Tracking source ${sourceName} is working again.`,
      `Status: ${payload.previousStatus} -> ${payload.status}`,
      `Failing packages: ${payload.report.failingCount}/${payload.report.watchedCount}`,
    ];

    if (payload.report.lastSuccessAt) {
      bodyLines.push(`Last success: ${payload.report.lastSuccessAt}`);
    }
    if (isDown && payload.report.lastError) {
      bodyLines.push(`Last error: ${payload.report.lastError}`);
    }

    const result = await this.sendAppriseMessage(
      config.appriseUrls,
      title,
      bodyLines.join("\n")
    );
    if (!result.ok) {
      console.error("Source health notification failed:", result.detail);
    }
  }

  private async sendAppriseMessage(
    appriseUrls: string[],
    title: string,
    body: string
  ): Promise<{ ok: boolean; detail?: string }> {
    const script = `
import os
import sys
try:
    import apprise
except Exception as exc:
    sys.stderr.write(f"Unable to import apprise: {exc}\\n")
    sys.exit(2)

urls = [entry.strip() for entry in os.environ.get("PAQQ_APPRISE_URLS", "").splitlines() if entry.strip()]
if not urls:
    sys.stderr.write("No Apprise URLs provided\\n")
    sys.exit(3)

app = apprise.Apprise()
for entry in urls:
    app.add(entry)

ok = app.notify(
    title=os.environ.get("PAQQ_APPRISE_TITLE", "Paqq Notification"),
    body=os.environ.get("PAQQ_APPRISE_BODY", ""),
)
if not ok:
    sys.stderr.write("Apprise returned False\\n")
    sys.exit(1)
`.trim();

    try {
      const { stderr } = await execFileAsync(this.pythonBin, ["-c", script], {
        env: {
          ...process.env,
          PAQQ_APPRISE_URLS: appriseUrls.join("\n"),
          PAQQ_APPRISE_TITLE: title,
          PAQQ_APPRISE_BODY: body,
        },
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
      });

      const detail = compact(stderr);
      return detail ? { ok: true, detail } : { ok: true };
    } catch (error) {
      const err = error as Error & {
        stderr?: string;
        message?: string;
      };
      const detail = compact(err.stderr) ?? compact(err.message);
      return { ok: false, detail: detail ?? "Unknown notification error" };
    }
  }
}
