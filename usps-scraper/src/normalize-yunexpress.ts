import { ShipmentInfo, ShipmentStatus } from "./types.js";

export interface YunexpressTrackEventDetail {
  ProcessLocation?: string;
  ProcessCity?: string;
  CreatedOn?: string;
  ProcessDate?: string;
  ProcessContent?: string;
  TrackingStatus?: number;
}

export interface YunexpressTrackInfo {
  WaybillNumber?: string;
  TrackingNumber?: string;
  DestinationCountryCode?: string;
  OriginCountryCode?: string;
  TrackingStatus?: number;
  CreatedOn?: string;
  LastTrackEvent?: YunexpressTrackEventDetail;
  TrackEventDetails?: YunexpressTrackEventDetail[];
  EstimatedDeliveryFromDate?: string | null;
  EstimatedDeliveryToDate?: string | null;
  EstimatedArrivalDate?: string | null;
}

export interface YunexpressTrackData {
  TrackStatus?: string;
}

export interface YunexpressResult {
  Id?: string;
  Status?: number;
  TrackInfo?: YunexpressTrackInfo;
  TrackData?: YunexpressTrackData;
}

export interface YunexpressQueryResponse {
  ResultList?: YunexpressResult[];
}

function compact(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Event timestamps come back as naive ISO strings (no zone). Pin them to UTC so
// the output is deterministic and independent of the server's local timezone.
function toIsoTimestamp(value: string | undefined | null): string | undefined {
  const trimmed = compact(value);
  if (!trimmed) return undefined;

  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
  const candidate = hasZone
    ? trimmed
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)
    ? `${trimmed}Z`
    : trimmed;

  const parsed = Date.parse(candidate);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return trimmed;
}

function statusCodeFromYunexpress(
  numericStatus: number | undefined,
  trackStatus: string | undefined,
  description: string
): string {
  const haystack = `${trackStatus ?? ""} ${description}`.toLowerCase();

  if (numericStatus === 50 || haystack.includes("delivered")) {
    return "5";
  }
  if (haystack.includes("out for delivery")) {
    return "4";
  }
  if (
    haystack.includes("transit") ||
    haystack.includes("arrived") ||
    haystack.includes("departed") ||
    haystack.includes("flight") ||
    haystack.includes("clearance") ||
    haystack.includes("facility") ||
    haystack.includes("delivery centre") ||
    haystack.includes("delivery center") ||
    haystack.includes("local carrier") ||
    haystack.includes("outbound") ||
    haystack.includes("pick")
  ) {
    return "3";
  }
  if (
    haystack.includes("information received") ||
    haystack.includes("order") ||
    haystack.includes("label") ||
    haystack.includes("pending")
  ) {
    return "2";
  }
  return "1";
}

function normalizeEvent(
  event: YunexpressTrackEventDetail,
  trackStatus: string | undefined
): ShipmentStatus | null {
  const description = compact(event.ProcessContent);
  if (!description) {
    return null;
  }

  const timestamp =
    toIsoTimestamp(event.CreatedOn) ?? toIsoTimestamp(event.ProcessDate);
  if (!timestamp) {
    return null;
  }

  const location = compact(event.ProcessLocation) ?? compact(event.ProcessCity);
  const code = statusCodeFromYunexpress(
    event.TrackingStatus,
    trackStatus,
    description
  );

  return {
    code,
    description,
    timestamp,
    location,
  };
}

export function normalizeYunexpressTracking(
  trackingNumber: string,
  trackingUrl: string,
  payload: YunexpressQueryResponse
): ShipmentInfo {
  const results = Array.isArray(payload.ResultList) ? payload.ResultList : [];
  if (results.length === 0) {
    throw new Error("YunExpress has no information for this tracking number");
  }

  const matching =
    results.find(
      (entry) => compact(entry.Id)?.toUpperCase() === trackingNumber.toUpperCase()
    ) ?? results[0];

  const info = matching.TrackInfo;
  const trackStatus = compact(matching.TrackData?.TrackStatus);
  const rawEvents = Array.isArray(info?.TrackEventDetails)
    ? info!.TrackEventDetails
    : [];

  const events = rawEvents
    .map((event) => normalizeEvent(event, trackStatus))
    .filter((event): event is ShipmentStatus => event !== null)
    .sort((left, right) => {
      const l = Date.parse(left.timestamp);
      const r = Date.parse(right.timestamp);
      if (!Number.isNaN(l) && !Number.isNaN(r)) {
        return r - l;
      }
      return right.timestamp.localeCompare(left.timestamp);
    });

  if (events.length === 0) {
    throw new Error("YunExpress has no information for this tracking number");
  }

  const numericStatus =
    typeof matching.Status === "number"
      ? matching.Status
      : info?.TrackingStatus;

  const lastEvent = info?.LastTrackEvent;
  const latest = events[0];
  const statusDescription =
    compact(lastEvent?.ProcessContent) ?? latest.description;
  const statusTimestamp =
    toIsoTimestamp(lastEvent?.ProcessDate) ??
    toIsoTimestamp(lastEvent?.CreatedOn) ??
    latest.timestamp;
  const statusLocation =
    compact(lastEvent?.ProcessLocation) ?? latest.location;
  const statusCode = statusCodeFromYunexpress(
    numericStatus,
    trackStatus,
    statusDescription
  );

  const estimatedDelivery =
    toIsoTimestamp(info?.EstimatedDeliveryToDate) ??
    toIsoTimestamp(info?.EstimatedDeliveryFromDate) ??
    toIsoTimestamp(info?.EstimatedArrivalDate);

  return {
    trackingNumber: compact(info?.WaybillNumber) ?? compact(matching.Id) ?? trackingNumber,
    trackingUrl,
    carrier: "yunexpress",
    status: {
      code: statusCode,
      description: statusDescription,
      timestamp: statusTimestamp,
      location: statusLocation,
    },
    estimatedDelivery,
    events,
  };
}
