import { TrackingSource } from "../base";
import { ShipmentInfo } from "../../schemas/shipment";

export class YunexpressSource extends TrackingSource {
  constructor(env: Record<string, string>) {
    super({
      name: "yunexpress",
      icon: "yunexpress.webp",
      requiredFields: ["trackingNumber"],
      baseUrl:
        env.YUNEXPRESS_SCRAPER_URL ??
        env.USPS_SCRAPER_URL ??
        "http://127.0.0.1:8790",
      apiKey: env.YUNEXPRESS_SCRAPER_TOKEN,
    });
  }

  async getTracking(
    params: Record<string, string>,
    env: Record<string, string>
  ): Promise<ShipmentInfo> {
    const baseUrl = (
      env.YUNEXPRESS_SCRAPER_URL ??
      env.USPS_SCRAPER_URL ??
      this.config.baseUrl
    ).replace(/\/$/, "");
    const token = (env.YUNEXPRESS_SCRAPER_TOKEN ?? this.config.apiKey) as
      | string
      | undefined;

    const parsedTimeoutMs = Number(env.YUNEXPRESS_SCRAPER_TIMEOUT_MS ?? "300000");
    const timeoutMs =
      Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
        ? parsedTimeoutMs
        : 300000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/track/yunexpress`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(token ? { "x-yunexpress-scraper-token": token } : {}),
        },
        body: JSON.stringify({
          trackingNumber: params.trackingNumber,
          timeoutMs,
        }),
        signal: controller.signal,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data?.error ?? `YunExpress scraper request failed (${response.status})`
        );
      }

      if (!data || !data.trackingNumber || !data.status || !data.events) {
        throw new Error("YunExpress scraper returned an invalid payload");
      }

      return {
        trackingNumber: data.trackingNumber,
        trackingUrl:
          data.trackingUrl ??
          `https://www.yuntrack.com/parcelTracking?id=${encodeURIComponent(
            params.trackingNumber
          )}`,
        carrier: "yunexpress",
        status: {
          code: String(data.status.code),
          description: String(data.status.description),
          timestamp: String(data.status.timestamp),
          location: data.status.location
            ? String(data.status.location)
            : undefined,
        },
        estimatedDelivery: data.estimatedDelivery
          ? String(data.estimatedDelivery)
          : undefined,
        events: Array.isArray(data.events)
          ? data.events.map((event: any) => ({
              code: String(event.code ?? ""),
              description: String(event.description ?? ""),
              timestamp: String(event.timestamp ?? ""),
              location: event.location ? String(event.location) : undefined,
            }))
          : [],
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
