import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  createMetaEventLog: vi.fn().mockResolvedValue(undefined),
  getBotStartByTelegramUserId: vi.fn().mockResolvedValue({
    telegramUserId: "123",
    telegramUsername: "prestige_user",
    telegramFirstName: "Ada",
    sessionToken: "session-1",
    funnelToken: "funnel-1",
  }),
  getLatestUtmSessionByFunnelToken: vi.fn().mockResolvedValue(undefined),
  getUtmSessionByToken: vi.fn().mockResolvedValue({
    sessionToken: "session-1",
    funnelToken: "funnel-1",
    visitorId: "visitor-1",
    landingPage: "https://example.com/",
  }),
  markBotStartJoinedIfFirst: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
  recordEvent: vi.fn().mockResolvedValue(undefined),
  resolveTelegramLinkage: vi.fn().mockResolvedValue(undefined),
  updateMetaEventLog: vi.fn().mockResolvedValue(undefined),
}));

const postMetaPayload = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    success: true,
    eventId: "ignored",
    httpStatus: 200,
    requestBody: { data: [{ event_name: "Subscribe" }] },
    responseBody: { events_received: 1 },
    retryable: false,
  }),
);
const buildSubscribePayload = vi.hoisted(() =>
  vi.fn((data: any) => ({
    data: [{ event_name: "Subscribe", event_id: data.eventId }],
  })),
);
const verifyWhatsAppRedirectSignature = vi.hoisted(() => vi.fn().mockReturnValue(true));
const skipPendingTelegramReminderJobs = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./db", () => dbMocks);
vi.mock("./metaCapi", () => ({ buildSubscribePayload, postMetaPayload }));
vi.mock("./telegramReminders", () => ({ skipPendingTelegramReminderJobs }));
vi.mock("./whatsappChannel", () => ({
  getWhatsAppChannelUrl: vi.fn().mockResolvedValue("https://whatsapp.com/channel/0029Vb60PxI7YSd5pqwOq82R"),
  verifyWhatsAppRedirectSignature,
}));

import { setupWaGoRoute } from "./waGoRoute";

describe("/wa-go", () => {
  let server: ReturnType<express.Express["listen"]> | null = null;

  afterEach(async () => {
    vi.clearAllMocks();
    dbMocks.markBotStartJoinedIfFirst.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    verifyWhatsAppRedirectSignature.mockReturnValue(true);
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      server = null;
    }
  });

  it("redirects immediately and records a distinct Subscribe for every click", async () => {
    const app = express();
    setupWaGoRoute(app);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const url = `http://127.0.0.1:${address.port}/wa-go?u=123&s=session-1&f=funnel-1`;

    const first = await fetch(url, { redirect: "manual" });
    const second = await fetch(url, { redirect: "manual" });

    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("https://whatsapp.com/channel/0029Vb60PxI7YSd5pqwOq82R");
    expect(second.status).toBe(302);

    await vi.waitFor(() => expect(postMetaPayload).toHaveBeenCalledTimes(2));

    expect(dbMocks.recordEvent).toHaveBeenCalledTimes(2);
    expect(dbMocks.createMetaEventLog).toHaveBeenCalledTimes(2);
    expect(skipPendingTelegramReminderJobs).toHaveBeenCalledTimes(1);
    expect(dbMocks.resolveTelegramLinkage).toHaveBeenCalledTimes(1);

    const eventIds = dbMocks.createMetaEventLog.mock.calls.map(([entry]) => entry.eventId);
    expect(new Set(eventIds).size).toBe(2);
    expect(eventIds.every((eventId) => /^wa_sub_123_\d+_[0-9a-f-]{36}$/.test(eventId))).toBe(true);
    expect(dbMocks.createMetaEventLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eventType: "Subscribe",
        eventScope: "whatsapp_subscribe",
        requestPayloadJson: expect.stringContaining('"event_name":"Subscribe"'),
        status: "queued",
      }),
    );
    expect(buildSubscribePayload).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        telegramUserId: "123",
        subscribeSource: "whatsapp",
      }),
    );
  });

  it("does not count HEAD requests or link-preview bots as subscriptions", async () => {
    const app = express();
    setupWaGoRoute(app);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const url = `http://127.0.0.1:${address.port}/wa-go?u=123&s=session-1&f=funnel-1&k=signed`;

    const head = await fetch(url, { method: "HEAD", redirect: "manual" });
    const preview = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "facebookexternalhit/1.1" },
    });

    expect(head.status).toBe(302);
    expect(preview.status).toBe(302);
    expect(dbMocks.recordEvent).not.toHaveBeenCalled();
    expect(dbMocks.createMetaEventLog).not.toHaveBeenCalled();
    expect(postMetaPayload).not.toHaveBeenCalled();
  });

  it("redirects but does not attribute a tampered signed link", async () => {
    verifyWhatsAppRedirectSignature.mockReturnValue(false);
    const app = express();
    setupWaGoRoute(app);
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    const response = await fetch(`http://127.0.0.1:${address.port}/wa-go?u=123&s=tampered&f=funnel-1&k=invalid`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(dbMocks.recordEvent).not.toHaveBeenCalled();
    expect(dbMocks.createMetaEventLog).not.toHaveBeenCalled();
    expect(postMetaPayload).not.toHaveBeenCalled();
  });
});
