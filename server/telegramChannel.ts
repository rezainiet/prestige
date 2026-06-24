import { getSetting } from "./db";

// The numeric Telegram channel id the bot mints per-user invite links from
// (createPersonalInviteLink) and approves chat_join_requests into. This is the
// REAL lever that decides which channel the funnel routes users to — the
// `telegram_group_url` setting is only cosmetic copy. We let admins override the
// env var at runtime (DB setting wins) so switching channels no longer requires
// a redeploy.
export const TELEGRAM_CHANNEL_ID_SETTING_KEY = "telegram_channel_id";

export type TelegramChannelIdValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

// Bot API supergroup/channel ids are `-100` followed by the internal id. We
// require that exact shape so a stray invite URL or @handle pasted into the
// field is rejected before it silently breaks every /start.
const TELEGRAM_CHANNEL_ID_RE = /^-100\d{6,}$/;

export function validateTelegramChannelId(rawValue: string): TelegramChannelIdValidation {
  const trimmed = (rawValue || "").trim();
  if (!trimmed) {
    return { ok: false, error: "Channel ID is required." };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: "Channel ID must not contain whitespace." };
  }
  if (!TELEGRAM_CHANNEL_ID_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        "Channel ID must look like -100xxxxxxxxxx (the bot's numeric channel id, not an invite link). Forward a channel message to @getidsbot to find it.",
    };
  }
  return { ok: true, value: trimmed };
}

// Read process.env at call time (not module load) so tests and runtime pick up
// the current value without an import-order trap. DB setting overrides env.
function envChannelId(): string {
  return (process.env.TELEGRAM_CHANNEL_ID || "").trim();
}

export async function getTelegramChannelId(): Promise<string> {
  const fromSettings = (await getSetting(TELEGRAM_CHANNEL_ID_SETTING_KEY))?.trim();
  if (fromSettings) return fromSettings;
  return envChannelId();
}
