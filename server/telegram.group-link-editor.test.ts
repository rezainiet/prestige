import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceTelegramGroupUrlInText } from "./telegramGroupLink";
import { buildWhatsAppRedirectUrl, validateChannelUrl, verifyWhatsAppRedirectSignature } from "./whatsappChannel";

const dashboardSource = fs.readFileSync(path.resolve(import.meta.dirname, "../client/src/pages/Dashboard.tsx"), "utf-8");
const routerSource = fs.readFileSync(path.resolve(import.meta.dirname, "./routers.ts"), "utf-8");

describe("telegram group link editor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts WhatsApp and Telegram channels but rejects unrelated hosts", () => {
    expect(validateChannelUrl("https://whatsapp.com/channel/0029Vb60PxI7YSd5pqwOq82R")).toEqual({
      ok: true,
      value: "https://whatsapp.com/channel/0029Vb60PxI7YSd5pqwOq82R",
    });
    expect(validateChannelUrl("https://t.me/prestige_channel").ok).toBe(true);
    expect(validateChannelUrl("https://example.com/channel/nope").ok).toBe(false);
  });

  it("replaces placeholders and legacy Telegram links with the newest group URL", () => {
    const nextUrl = "https://t.me/new_private_group";

    expect(replaceTelegramGroupUrlInText("Join here -> {group_url}", nextUrl)).toContain(nextUrl);
    expect(replaceTelegramGroupUrlInText("Join here -> https://t.me/+sdIa7KNoIbNjMTg0 and keep going", nextUrl)).toBe(
      `Join here -> ${nextUrl} and keep going`,
    );
    expect(replaceTelegramGroupUrlInText("Old joinchat link https://telegram.me/joinchat/legacyHash and ok", nextUrl)).toBe(
      `Old joinchat link ${nextUrl} and ok`,
    );
    expect(replaceTelegramGroupUrlInText("Old WhatsApp https://whatsapp.com/channel/0029OldChannel", nextUrl)).toBe(
      `Old WhatsApp ${nextUrl}`,
    );
  });

  it("preserves bot and contact handles that are not invite links", () => {
    // Replacing every t.me URL would clobber the @MAXIME_SPECIALISTEM contact
    // line, the Misternb_bot deeplink, etc. Only invite-style URLs should be
    // rewritten when the group URL setting changes.
    const nextUrl = "https://t.me/+brand_new_invite";
    const stored = "Welcome! Join https://t.me/+old_invite — questions? https://t.me/MisterBNMB or https://t.me/Misternb_bot?start=abc";

    const out = replaceTelegramGroupUrlInText(stored, nextUrl);

    expect(out).toContain(nextUrl);
    expect(out).toContain("https://t.me/MisterBNMB");
    expect(out).toContain("https://t.me/Misternb_bot?start=abc");
    expect(out).not.toContain("https://t.me/+old_invite");
  });

  it("adds a dashboard control for editing a WhatsApp or Telegram channel link", () => {
    expect(dashboardSource).toContain("Channel link editor");
    expect(dashboardSource).toContain("channel-url");
    expect(dashboardSource).toContain("Save latest changes");
    expect(dashboardSource).toContain('key: "whatsapp_channel_url"');
  });

  it("syncs pending bot content immediately when the Telegram group link setting is saved", () => {
    expect(routerSource).toContain("TELEGRAM_GROUP_URL_SETTING_KEY");
    expect(routerSource).toContain("syncTelegramGroupUrlContent");
    expect(routerSource).toContain("input.key === TELEGRAM_GROUP_URL_SETTING_KEY");
  });

  it("signs personal redirect attribution and rejects token tampering", () => {
    vi.stubEnv("WHATSAPP_REDIRECT_BASE_URL", "https://funnel.example");
    vi.stubEnv("WHATSAPP_REDIRECT_SIGNING_SECRET", "test-signing-secret");
    const url = new URL(
      buildWhatsAppRedirectUrl({
        telegramUserId: "123",
        sessionToken: "session-1",
        funnelToken: "funnel-1",
      }),
    );
    const signature = url.searchParams.get("k");

    expect(signature).toBeTruthy();
    expect(
      verifyWhatsAppRedirectSignature({
        telegramUserId: "123",
        sessionToken: "session-1",
        funnelToken: "funnel-1",
        signature,
      }),
    ).toBe(true);
    expect(
      verifyWhatsAppRedirectSignature({
        telegramUserId: "123",
        sessionToken: "tampered",
        funnelToken: "funnel-1",
        signature,
      }),
    ).toBe(false);
  });
});
