import { afterEach, describe, expect, it, vi } from "vitest";

describe("postMetaPayload response validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not mark a 200 response with zero accepted events as sent", async () => {
    vi.stubEnv("META_PIXEL_ID", "pixel-test");
    vi.stubEnv("META_CONVERSIONS_TOKEN", "token-test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ events_received: 0, messages: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { postMetaPayload } = await import("./metaCapi");

    const result = await postMetaPayload("evt-zero", {
      data: [{ event_name: "PageView", event_id: "evt-zero" }],
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.errorCode).toBe("zero_events_received");
    expect(result.errorMessage).toContain("accepted zero events");
  });

  it("accepts a normal Meta response with one received event", async () => {
    vi.stubEnv("META_PIXEL_ID", "pixel-test");
    vi.stubEnv("META_CONVERSIONS_TOKEN", "token-test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ events_received: 1, messages: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { postMetaPayload } = await import("./metaCapi");

    const result = await postMetaPayload("evt-one", {
      data: [{ event_name: "PageView", event_id: "evt-one" }],
    });

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });
});
