import { describe, expect, it } from "vitest";
import {
  normalizeYunexpressTracking,
  type YunexpressQueryResponse,
} from "../src/normalize-yunexpress.js";

const TRACKING_URL =
  "https://www.yuntrack.com/parcelTracking?id=YT2521800703039536";

describe("normalizeYunexpressTracking", () => {
  it("maps a YunExpress Track/Query payload into Paqq shipment shape", () => {
    const raw: YunexpressQueryResponse = {
      ResultList: [
        {
          Id: "YT2521800703039536",
          Status: 50,
          TrackInfo: {
            WaybillNumber: "YT2521800703039536",
            DestinationCountryCode: "DE",
            OriginCountryCode: "CN",
            TrackingStatus: 50,
            LastTrackEvent: {
              ProcessDate: "2025-08-18T10:14:33",
              ProcessContent: "Delivered. , Evidence",
              ProcessLocation: "Nürnberg (DE)",
              TrackingStatus: 50,
            },
            TrackEventDetails: [
              {
                ProcessLocation: "",
                CreatedOn: "2025-08-06T11:14:02",
                ProcessContent: "Shipment information received",
              },
              {
                ProcessLocation: "Mainland China, CN",
                CreatedOn: "2025-08-09T16:04:51",
                ProcessContent: "Shipment is in transit to next facility",
              },
              {
                ProcessLocation: "Nürnberg (DE)",
                CreatedOn: "2025-08-18T05:34:57",
                ProcessContent: "Out for delivery.",
              },
              {
                ProcessLocation: "Nürnberg (DE)",
                CreatedOn: "2025-08-18T10:14:33",
                ProcessContent: "Delivered. , Evidence",
              },
            ],
          },
          TrackData: {
            TrackStatus: "Delivered",
          },
        },
      ],
    };

    const result = normalizeYunexpressTracking(
      "YT2521800703039536",
      TRACKING_URL,
      raw
    );

    expect(result.carrier).toBe("yunexpress");
    expect(result.trackingNumber).toBe("YT2521800703039536");
    expect(result.trackingUrl).toBe(TRACKING_URL);
    expect(result.status.code).toBe("5");
    expect(result.status.description).toContain("Delivered");
    expect(result.status.location).toBe("Nürnberg (DE)");
    expect(result.events).toHaveLength(4);
    // Events are sorted newest first.
    expect(result.events[0].description).toContain("Delivered");
    expect(result.events[result.events.length - 1].description).toBe(
      "Shipment information received"
    );
    // Naive timestamps are pinned to UTC.
    expect(result.events[0].timestamp).toBe("2025-08-18T10:14:33.000Z");
  });

  it("maps an in-transit event to status code 3", () => {
    const raw: YunexpressQueryResponse = {
      ResultList: [
        {
          Id: "YT0000000000000001",
          Status: 30,
          TrackInfo: {
            WaybillNumber: "YT0000000000000001",
            TrackEventDetails: [
              {
                ProcessLocation: "LIEGE, AVALON, BE",
                CreatedOn: "2025-08-11T08:44:55",
                ProcessContent: "Arrived at sort facility",
              },
            ],
          },
          TrackData: { TrackStatus: "In Transit" },
        },
      ],
    };

    const result = normalizeYunexpressTracking(
      "YT0000000000000001",
      TRACKING_URL,
      raw
    );
    expect(result.status.code).toBe("3");
    expect(result.events).toHaveLength(1);
  });

  it("throws when the result list is empty", () => {
    expect(() =>
      normalizeYunexpressTracking("YT2521800703039536", TRACKING_URL, {
        ResultList: [],
      })
    ).toThrow("YunExpress has no information for this tracking number");
  });

  it("throws when there are no usable events", () => {
    const raw: YunexpressQueryResponse = {
      ResultList: [
        {
          Id: "YT2521800703039536",
          Status: 0,
          TrackInfo: { WaybillNumber: "YT2521800703039536", TrackEventDetails: [] },
        },
      ],
    };

    expect(() =>
      normalizeYunexpressTracking("YT2521800703039536", TRACKING_URL, raw)
    ).toThrow("YunExpress has no information for this tracking number");
  });
});
