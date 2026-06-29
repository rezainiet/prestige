import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import {
  createMetaEventLog,
  getBotStartByTelegramUserId,
  getLatestUtmSessionByFunnelToken,
  getUtmSessionByToken,
  markBotStartJoinedIfFirst,
  recordEvent,
  resolveTelegramLinkage,
  updateMetaEventLog,
} from "./db";
import { log } from "./_core/logger";
import { buildSubscribePayload, postMetaPayload } from "./metaCapi";
import { skipPendingTelegramReminderJobs } from "./telegramReminders";
import { getWhatsAppChannelUrl, verifyWhatsAppRedirectSignature } from "./whatsappChannel";

const META_RETRY_DELAY_MS = 5 * 60 * 1000;

function firstQueryValue(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

function getRequestIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (forwardedStr) {
    const first = forwardedStr.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || null;
}

async function resolveLandingSession(sessionToken: string | null, funnelToken: string | null) {
  if (sessionToken) {
    const bySession = await getUtmSessionByToken(sessionToken);
    if (bySession) return bySession;
  }
  if (funnelToken) {
    return getLatestUtmSessionByFunnelToken(funnelToken);
  }
  return undefined;
}

function isPreviewBot(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return /(?:bot|crawler|spider|preview|facebookexternalhit|telegrambot|slackbot|discordbot|twitterbot|linkedinbot)/i.test(userAgent);
}

type PreparedWhatsAppClick = {
  eventId: string;
  telegramUserId: string;
  payload: Record<string, unknown>;
  isFirstClick: boolean;
};

/**
 * Validate and durably enqueue the click before redirecting. This small DB
 * cost closes the loss window where a process restart after the 302 could
 * previously drop both analytics and Meta delivery.
 */
async function prepareWhatsAppClick(args: {
  telegramUserId: string;
  sessionToken: string | null;
  funnelToken: string | null;
  signature: string | null;
  ip: string | null;
  userAgent: string | null;
}): Promise<PreparedWhatsAppClick | null> {
  const { telegramUserId } = args;
  const botStart = await getBotStartByTelegramUserId(telegramUserId);
  if (!botStart) {
    log.warn("waGo", "unknown_telegram_user_skipping_subscribe", {
      telegramUserId,
    });
    return null;
  }

  const signed = verifyWhatsAppRedirectSignature({
    telegramUserId,
    sessionToken: args.sessionToken,
    funnelToken: args.funnelToken,
    signature: args.signature,
  });
  const hasLegacyToken = Boolean(args.sessionToken || args.funnelToken);
  const legacyTokenMatch =
    !args.signature &&
    hasLegacyToken &&
    (!args.sessionToken || args.sessionToken === botStart.sessionToken) &&
    (!args.funnelToken || args.funnelToken === botStart.funnelToken);
  if (!signed && !legacyTokenMatch) {
    log.warn("waGo", "invalid_redirect_signature", { telegramUserId });
    return null;
  }

  // Signed links carry the authoritative visit. For an unsigned legacy link,
  // fall back to the current bot-start identity only when its tokens matched.
  const sessionToken = signed ? args.sessionToken : args.sessionToken || botStart.sessionToken || null;
  const funnelToken = signed ? args.funnelToken : args.funnelToken || botStart.funnelToken || null;
  const session = await resolveLandingSession(sessionToken, funnelToken);

  // First click only marks conversion state and cancels future reminders.
  // Meta emission below is deliberately not gated: every click subscribes.
  const isFirstClick = await markBotStartJoinedIfFirst(telegramUserId);
  if (isFirstClick) {
    await Promise.all([skipPendingTelegramReminderJobs(telegramUserId, "joined_group"), resolveTelegramLinkage(telegramUserId)]);
  }

  const epochSeconds = Math.floor(Date.now() / 1000);
  const eventId = `wa_sub_${telegramUserId}_${Date.now()}_${crypto.randomUUID()}`;
  const payload = buildSubscribePayload({
    eventId,
    eventTime: epochSeconds,
    telegramUserId,
    telegramUsername: botStart.telegramUsername || undefined,
    telegramFirstName: botStart.telegramFirstName || undefined,
    visitorId: session?.visitorId || undefined,
    fbclid: session?.fbclid || undefined,
    fbp: session?.fbp || undefined,
    sessionCreatedAt: session?.createdAt,
    utmSource: session?.utmSource || undefined,
    utmMedium: session?.utmMedium || undefined,
    utmCampaign: session?.utmCampaign || undefined,
    utmContent: session?.utmContent || undefined,
    sourceUrl: session?.landingPage || undefined,
    userAgent: session?.userAgent || args.userAgent || undefined,
    ipAddress: session?.ipAddress || args.ip || undefined,
    subscribeSource: "whatsapp",
  });

  await Promise.all([
    recordEvent({
      eventType: "whatsapp_click",
      eventSource: "bot_dm_redirect",
      eventId,
      visitorId: session?.visitorId || null,
      sessionToken,
      funnelToken,
      sourceUrl: session?.landingPage || null,
      userAgent: args.userAgent ? args.userAgent.slice(0, 512) : null,
      referrer: null,
      ip: args.ip ? args.ip.slice(0, 64) : null,
      country: null,
    }),
    createMetaEventLog({
      eventType: "Subscribe",
      eventScope: "whatsapp_subscribe",
      eventId,
      funnelToken,
      sessionToken,
      telegramUserId,
      requestPayloadJson: JSON.stringify(payload),
      status: "queued",
      retryable: 0,
      attemptCount: 0,
    }),
  ]);

  return { eventId, telegramUserId, payload, isFirstClick };
}

async function sendPreparedWhatsAppSubscribe(prepared: PreparedWhatsAppClick) {
  const { eventId, telegramUserId, payload, isFirstClick } = prepared;
  try {
    const metaResult = await postMetaPayload(eventId, payload);

    const status = metaResult.success ? "sent" : metaResult.retryable ? "retrying" : "failed";

    await updateMetaEventLog(eventId, {
      requestPayloadJson: metaResult.requestBody ? JSON.stringify(metaResult.requestBody) : null,
      responsePayloadJson: metaResult.responseBody ? JSON.stringify(metaResult.responseBody) : null,
      httpStatus: metaResult.httpStatus ?? null,
      status,
      errorCode: metaResult.errorCode ?? null,
      errorSubcode: metaResult.errorSubcode ?? null,
      errorMessage: metaResult.errorMessage ?? null,
      retryable: metaResult.retryable ? 1 : 0,
      attemptCount: 1,
      attemptedAt: new Date(),
      completedAt: metaResult.success ? new Date() : null,
      nextRetryAt: metaResult.retryable ? new Date(Date.now() + META_RETRY_DELAY_MS) : null,
    });

    log.info("waGo", "subscribe_fired", {
      telegramUserId,
      eventId,
      status,
      isFirstClick,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("waGo", "subscribe_unexpected_error", {
      telegramUserId,
      eventId,
      error: message,
    });
    await updateMetaEventLog(eventId, {
      status: "retrying",
      errorCode: "unexpected_error",
      errorMessage: message,
      retryable: 1,
      attemptCount: 1,
      attemptedAt: new Date(),
      nextRetryAt: new Date(Date.now() + META_RETRY_DELAY_MS),
    });
  }
}

export function setupWaGoRoute(app: Express) {
  app.head("/wa-go", async (_req: Request, res: Response) => {
    try {
      res.redirect(302, await getWhatsAppChannelUrl());
    } catch {
      res.status(503).end();
    }
  });

  app.get("/wa-go", async (req: Request, res: Response) => {
    const telegramUserId = firstQueryValue(req.query.u);
    const sessionToken = firstQueryValue(req.query.s);
    const funnelToken = firstQueryValue(req.query.f);
    const signature = firstQueryValue(req.query.k);
    const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;

    // Resolve the cached destination first. Attribution is durably enqueued
    // before the 302; the slower Meta network request remains off-path.
    let destination: string;
    try {
      destination = await getWhatsAppChannelUrl();
    } catch (error) {
      log.error("waGo", "destination_resolve_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).send("WhatsApp channel temporarily unavailable.");
      return;
    }

    if (!telegramUserId) {
      res.redirect(302, destination);
      log.warn("waGo", "missing_u_param_skipping_attribution");
      return;
    }

    if (isPreviewBot(userAgent)) {
      res.redirect(302, destination);
      log.info("waGo", "preview_bot_skipped", {
        userAgent: userAgent?.slice(0, 120),
      });
      return;
    }

    let prepared: PreparedWhatsAppClick | null = null;
    try {
      prepared = await prepareWhatsAppClick({
        telegramUserId,
        sessionToken,
        funnelToken,
        signature,
        ip: getRequestIp(req),
        userAgent,
      });
    } catch (error) {
      log.error("waGo", "enqueue_failed", {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    res.redirect(302, destination);
    if (prepared) {
      void sendPreparedWhatsAppSubscribe(prepared).catch((error) => {
        log.error("waGo", "async_send_failed", {
          telegramUserId,
          eventId: prepared?.eventId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });
}
