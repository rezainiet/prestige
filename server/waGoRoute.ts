import type { Express, Request, Response } from "express";
import {
  createMetaEventLog,
  getBotStartByTelegramUserId,
  getLatestUtmSessionByFunnelToken,
  getUtmSessionByToken,
  markBotStartJoinedIfFirst,
  recordEvent,
  updateMetaEventLog,
} from "./db";
import { log } from "./_core/logger";
import { fireWhatsAppLeadEvent } from "./metaCapi";
import { skipPendingTelegramReminderJobs } from "./telegramReminders";
import { getWhatsAppChannelUrl } from "./whatsappChannel";

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

/**
 * Fire-and-forget work that runs AFTER the 302 has been sent. Nothing here is
 * allowed to throw into the request — the user has already been redirected.
 */
async function processWhatsAppClick(args: {
  telegramUserId: string;
  sessionToken: string | null;
  funnelToken: string | null;
  ip: string | null;
  userAgent: string | null;
}) {
  const { telegramUserId } = args;

  const [botStart, session] = await Promise.all([
    getBotStartByTelegramUserId(telegramUserId),
    resolveLandingSession(args.sessionToken, args.funnelToken),
  ]);

  const sessionToken = args.sessionToken || botStart?.sessionToken || session?.sessionToken || null;
  const funnelToken = args.funnelToken || botStart?.funnelToken || session?.funnelToken || null;

  // Always record the raw click for analytics, regardless of first/repeat.
  await recordEvent({
    eventType: "whatsapp_click",
    eventSource: "bot_dm_redirect",
    visitorId: session?.visitorId || null,
    sessionToken,
    funnelToken,
    userAgent: args.userAgent ? args.userAgent.slice(0, 512) : null,
    referrer: null,
    ip: args.ip ? args.ip.slice(0, 64) : null,
    country: null,
  });

  // First click only — atomic guard makes this safe under double-clicks and
  // Telegram in-app prefetching.
  const isFirstClick = await markBotStartJoinedIfFirst(telegramUserId);
  if (!isFirstClick) {
    log.info("waGo", "repeat_click_no_lead", { telegramUserId });
    return;
  }

  await skipPendingTelegramReminderJobs(telegramUserId, "joined_group");

  const epochSeconds = Math.floor(Date.now() / 1000);
  const eventId = `wa_click_${telegramUserId}_${epochSeconds}`;

  await createMetaEventLog({
    eventType: "Lead",
    eventScope: "whatsapp_click",
    eventId,
    funnelToken,
    sessionToken,
    telegramUserId,
    status: "queued",
    retryable: 0,
    attemptCount: 0,
  });

  try {
    const metaResult = await fireWhatsAppLeadEvent({
      eventId,
      eventTime: epochSeconds,
      telegramUserId,
      telegramUsername: botStart?.telegramUsername || undefined,
      telegramFirstName: botStart?.telegramFirstName || undefined,
      visitorId: session?.visitorId || undefined,
      fbclid: session?.fbclid || undefined,
      fbp: session?.fbp || undefined,
      sessionCreatedAt: session?.createdAt,
      utmSource: session?.utmSource || undefined,
      utmMedium: session?.utmMedium || undefined,
      utmCampaign: session?.utmCampaign || undefined,
      utmContent: session?.utmContent || undefined,
      sourceUrl: session?.landingPage || undefined,
      // Prefer the landing session's browser IP/UA (shared with PageView /
      // Subscribe for match quality); fall back to this redirect request's
      // own IP/UA, which is still a real user signal.
      userAgent: session?.userAgent || args.userAgent || undefined,
      ipAddress: session?.ipAddress || args.ip || undefined,
    });

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

    log.info("waGo", "lead_fired", { telegramUserId, eventId, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("waGo", "lead_unexpected_error", { telegramUserId, eventId, error: message });
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
  app.get("/wa-go", async (req: Request, res: Response) => {
    const telegramUserId = firstQueryValue(req.query.u);
    const sessionToken = firstQueryValue(req.query.s);
    const funnelToken = firstQueryValue(req.query.f);

    // STEP 1: redirect immediately from the in-process cache. No DB/CAPI work
    // touches the response path so latency stays ~RTT.
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

    res.redirect(302, destination);

    // STEP 2: fire-and-forget. The user is already gone; never block or throw.
    if (!telegramUserId) {
      log.warn("waGo", "missing_u_param_skipping_attribution");
      return;
    }

    void processWhatsAppClick({
      telegramUserId,
      sessionToken,
      funnelToken,
      ip: getRequestIp(req),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    }).catch((error) => {
      log.error("waGo", "async_processing_failed", {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
