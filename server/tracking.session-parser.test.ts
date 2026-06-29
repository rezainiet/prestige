import { beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

function buildCreateSessionResponse() {
  return [
    {
      result: {
        data: {
          json: {
            success: true,
            sessionToken: "session_123",
            telegramBotUrl:
              "https://t.me/Maxime1_bot?start=Z3JvdXA6ZGV2UlBrUUUyTnIzV2I1aDZpREtpWllnSXZyTmx4cTU",
            telegramDeepLink:
              "tg://resolve?domain=Maxime1_bot&start=Z3JvdXA6ZGV2UlBrUUUyTnIzV2I1aDZpREtpWllnSXZyTmx4cTU",
            payload: "Z3JvdXA6ZGV2UlBrUUUyTnIzV2I1aDZpREtpWllnSXZyTmx4cTU",
          },
        },
      },
    },
  ];
}

describe("tracking session parser", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("reads telegramBotUrl from result.data.json and preserves the exact start payload link", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => buildCreateSessionResponse(),
      }),
    );

    vi.stubGlobal("window", {
      sessionStorage,
      localStorage,
      location: {
        href: "https://www.mister-b.club/?fbclid=test_fbclid",
        search: "?fbclid=test_fbclid",
      },
    });

    vi.stubGlobal("document", {
      referrer: "https://facebook.com/",
      cookie: "",
      visibilityState: "visible",
      addEventListener: vi.fn(),
    });

    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "iPhone" },
      configurable: true,
    });

    const tracking = await import("../client/src/lib/tracking");
    const session = await tracking.ensureTrackingSession();

    expect(session?.telegramBotUrl).toBe(
      "https://t.me/Maxime1_bot?start=Z3JvdXA6ZGV2UlBrUUUyTnIzV2I1aDZpREtpWllnSXZyTmx4cTU",
    );
    // The active key is v4 (no longer mirrored to legacy keys; reads still
    // fall back to v3/v2 for in-flight sessions across the deploy boundary).
    expect(sessionStorage.getItem("misterb_tracking_session_v4")).toContain("?start=");
  });

  it("waits for createSession and markTelegramClick before resolving the Telegram group click helper", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    // The Telegram-group CTA click is no longer the conversion: the Lead now
    // fires server-side on the /wa-go redirect. trackTelegramGroupClick no
    // longer posts a 'lead' tracking.record. The fetch order is now:
    //   1) /api/trpc/tracking.createSession
    //   2) /api/trpc/tracking.markTelegramClick
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => buildCreateSessionResponse(),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ result: { data: { json: { success: true } } } }],
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      sessionStorage,
      localStorage,
      clarity: vi.fn(),
      location: {
        href: "https://mister-b.club/?utm_source=fb&utm_medium=paid&fbclid=test_fbclid",
        search: "?utm_source=fb&utm_medium=paid&fbclid=test_fbclid",
      },
    });

    vi.stubGlobal("document", {
      referrer: "https://facebook.com/",
      cookie: "_fbp=fb.1.1777129000000.1234567890",
      visibilityState: "visible",
      addEventListener: vi.fn(),
    });

    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
      configurable: true,
    });

    const tracking = await import("../client/src/lib/tracking");
    const session = await tracking.trackTelegramGroupClick("telegram_group_cta");

    expect(session?.sessionToken).toBe("session_123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/trpc/tracking.createSession?batch=1");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/trpc/tracking.markTelegramClick?batch=1");

    // No 'lead' tracking.record is emitted any more.
    expect(
      fetchMock.mock.calls.some((call) => String(call?.[0]).includes("tracking.record")),
    ).toBe(false);

    const markClickPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(markClickPayload[0].json.sessionToken).toBe("session_123");
    expect(markClickPayload[0].json.source).toBe("telegram_group_cta");
  });

  it("creates a fresh session when the same tab arrives through a different campaign", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    sessionStorage.setItem(
      "misterb_tracking_session_v4",
      JSON.stringify({
        sessionToken: "session_old",
        funnelToken: "funnel_shared",
        telegramBotUrl: "https://t.me/Prestigeofficiel_bot?start=old",
        telegramDeepLink: "tg://resolve?domain=Prestigeofficiel_bot&start=old",
        payload: "old",
        attributionKey: JSON.stringify([
          ["utm_source", "old_source"],
          ["utm_campaign", "old_campaign"],
        ]),
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => [
        {
          result: {
            data: {
              json: {
                sessionToken: "session_new",
                funnelToken: "funnel_shared",
                telegramBotUrl: "https://t.me/Prestigeofficiel_bot?start=new",
                telegramDeepLink: "tg://resolve?domain=Prestigeofficiel_bot&start=new",
                payload: "new",
              },
            },
          },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      sessionStorage,
      localStorage,
      location: {
        href: "https://mister-b.club/?utm_source=new_source&utm_campaign=new_campaign",
        search: "?utm_source=new_source&utm_campaign=new_campaign",
      },
    });
    vi.stubGlobal("document", {
      referrer: "https://facebook.com/",
      cookie: "",
      visibilityState: "visible",
      addEventListener: vi.fn(),
    });
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "iPhone" },
      configurable: true,
    });

    const tracking = await import("../client/src/lib/tracking");
    const session = await tracking.ensureTrackingSession();

    expect(session?.sessionToken).toBe("session_new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const createPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(createPayload[0].json.utmSource).toBe("new_source");
    expect(createPayload[0].json.utmCampaign).toBe("new_campaign");
    expect(createPayload[0].json.funnelToken).toBe("funnel_shared");
  });
});
