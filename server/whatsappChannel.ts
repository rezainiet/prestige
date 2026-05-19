import { getSetting } from "./db";
import { log } from "./_core/logger";
import { getTelegramGroupUrl } from "./telegramGroupLink";

// Admin-editable site_settings key. When present it overrides the env var so
// the WhatsApp destination can be rotated without a redeploy.
export const WHATSAPP_CHANNEL_URL_SETTING_KEY = "whatsapp_channel_url";

// Refresh the in-process cache at most this often. The /wa-go redirect reads
// this cache so the 302 latency is ~RTT (no DB hit on the hot path).
const CACHE_TTL_MS = 30_000;

type CachedUrl = { value: string; fetchedAt: number };
let cache: CachedUrl | null = null;
let inflight: Promise<string> | null = null;

function envWhatsAppUrl(): string {
  return (process.env.WHATSAPP_CHANNEL_URL || "").trim();
}

async function resolveWhatsAppChannelUrl(): Promise<string> {
  // 1. site_settings (admin-editable, highest precedence).
  try {
    const fromSettings = (await getSetting(WHATSAPP_CHANNEL_URL_SETTING_KEY))?.trim();
    if (fromSettings) return fromSettings;
  } catch (error) {
    log.warn("whatsappChannel", "site_setting_lookup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. Environment variable.
  const fromEnv = envWhatsAppUrl();
  if (fromEnv) return fromEnv;

  // 3. Safe default: never break the redirect. Send users to the Telegram
  // group so the click still lands somewhere useful, and warn loudly so the
  // misconfiguration is visible in logs.
  const fallback = await getTelegramGroupUrl();
  log.warn("whatsappChannel", "no_whatsapp_url_configured_falling_back_to_telegram", {
    settingKey: WHATSAPP_CHANNEL_URL_SETTING_KEY,
    fallback,
  });
  return fallback;
}

/**
 * Resolve the WhatsApp channel destination, served from a ~30s in-process
 * cache so the /wa-go redirect never blocks on the DB. On a cold cache the
 * first caller resolves and every concurrent caller awaits the same promise;
 * once warm, a stale entry is returned immediately and refreshed in the
 * background so no request ever pays the lookup latency.
 */
export async function getWhatsAppChannelUrl(): Promise<string> {
  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  if (cache) {
    // Warm but stale: serve the old value now, refresh in the background.
    if (!inflight) {
      inflight = resolveWhatsAppChannelUrl()
        .then((value) => {
          cache = { value, fetchedAt: Date.now() };
          return value;
        })
        .catch((error) => {
          log.warn("whatsappChannel", "background_refresh_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return cache?.value ?? "";
        })
        .finally(() => {
          inflight = null;
        });
    }
    return cache.value;
  }

  // Cold cache: everyone awaits the same resolve.
  if (!inflight) {
    inflight = resolveWhatsAppChannelUrl()
      .then((value) => {
        cache = { value, fetchedAt: Date.now() };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Test/admin hook — drop the cache so the next read re-resolves. */
export function resetWhatsAppChannelUrlCache() {
  cache = null;
  inflight = null;
}

function redirectBase(): string {
  const explicit = (process.env.WHATSAPP_REDIRECT_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railway) {
    const withScheme = /^https?:\/\//i.test(railway) ? railway : `https://${railway}`;
    return withScheme.replace(/\/+$/, "");
  }

  const appBase = (process.env.APP_BASE_URL || "").trim();
  return appBase.replace(/\/+$/, "");
}

/**
 * Build the per-user WhatsApp redirect URL shipped in the welcome DM and every
 * reminder: {BASE}/wa-go?u={telegramUserId}&s={sessionToken}&f={funnelToken}.
 * Session/funnel tokens are carried through so the async Lead can reconstruct
 * attribution (fbp/fbc/UTMs) from the original landing session.
 */
export function buildWhatsAppRedirectUrl(args: {
  telegramUserId: string | number;
  sessionToken?: string | null;
  funnelToken?: string | null;
}): string {
  const base = redirectBase();
  const params = new URLSearchParams();
  params.set("u", String(args.telegramUserId));
  if (args.sessionToken) params.set("s", args.sessionToken);
  if (args.funnelToken) params.set("f", args.funnelToken);
  return `${base}/wa-go?${params.toString()}`;
}
