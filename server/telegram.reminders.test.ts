import { describe, expect, it } from "vitest";
import {
  TELEGRAM_REMINDER_STEPS,
  buildTelegramReminderDrafts,
  renderTelegramReminderMessage,
} from "./telegramReminders";
import { buildDefaultWelcomeMessage } from "./telegramWebhook";
import { replaceTelegramGroupUrlInText } from "./telegramGroupLink";

describe("telegram reminders", () => {
  it("définit les sept relances demandées avec des clés distinctes", () => {
    expect(TELEGRAM_REMINDER_STEPS.map((step) => step.key)).toEqual([
      "15m",
      "1h",
      "4h",
      "24h",
      "1w",
      "2w",
      "1m",
    ]);
  });

  it("rend correctement les placeholders des messages de relance", () => {
    const message = renderTelegramReminderMessage("Salut {first_name} → {group_url}", {
      firstName: "Karim",
      groupUrl: "https://t.me/+demo",
    });

    expect(message).toBe("Salut Karim → https://t.me/+demo\n\nUne question ? Écris-moi en direct : @prest_original");
  });

  it("construit un message de bienvenue vendeur avec lien du canal et contact direct", () => {
    const message = buildDefaultWelcomeMessage("https://t.me/+demo");

    expect(message).toContain("Bienvenue dans la team Prestige");
    expect(message).toContain("https://t.me/+demo");
    expect(message).toContain("@prest_original");
  });

  it("génère une file de sept jobs avec les bons délais et des messages différenciés", async () => {
    const startedAt = new Date("2026-04-20T10:00:00.000Z");

    const drafts = await buildTelegramReminderDrafts({
      telegramUserId: "123456",
      chatId: "123456",
      firstName: "Yassine",
      startedAt,
      groupUrlOverride: "https://mister-b.club/wa-go?u=123456",
    });

    expect(drafts).toHaveLength(7);
    expect(new Set(drafts.map((draft) => draft.reminderKey)).size).toBe(7);
    expect(new Set(drafts.map((draft) => draft.messageText)).size).toBe(7);

    const dueOffsets = drafts.map((draft) => draft.dueAt.getTime() - startedAt.getTime());
    expect(dueOffsets).toEqual(
      TELEGRAM_REMINDER_STEPS.map((step) => step.defaultDelayMin * 60 * 1000),
    );

    expect(drafts[0]?.messageText).toContain("chaîne WhatsApp Prestige");
    expect(drafts[0]?.messageText).toContain("Yassine");
    expect(drafts[0]?.messageText).toContain("/wa-go?u=123456");
    expect(drafts[0]?.messageText).toContain("@prest_original");
  });

  it("re-template d'une relance: un lien d'invite figé (ancien canal) est remplacé par le lien per-user frais, le contact direct survit", () => {
    // The reminder worker now re-applies replaceTelegramGroupUrlInText at send
    // time with the freshly-resolved per-user link, so a channel switch heals
    // the baked-in text. A baked OLD-channel invite must be swapped for the
    // fresh link while the @prest_original handle (not an invite link) stays.
    const bakedText =
      "Rejoins le groupe privé maintenant ici → https://t.me/+aoa4AB_A_rwyODhk\n\nUne question ? Écris-moi en direct : @prest_original";
    const freshPerUserLink = "https://t.me/+NEWchannelPerUserLink";

    const healed = replaceTelegramGroupUrlInText(bakedText, freshPerUserLink);

    expect(healed).toContain(freshPerUserLink);
    expect(healed).not.toContain("https://t.me/+aoa4AB_A_rwyODhk");
    expect(healed).toContain("@prest_original");
  });
});
