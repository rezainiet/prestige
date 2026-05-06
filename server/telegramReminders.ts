import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { botStarts, telegramReminderJobs } from "../drizzle/schema";
import { tryAcquireLease } from "./_core/leaderLease";
import { log } from "./_core/logger";
import {
  getDb,
  getSetting,
  getValidPersonalInviteLink,
  setBotStartPersonalInviteLink,
} from "./db";
import {
  buildJoinGroupKeyboard,
  createPersonalInviteLink,
  sendTelegramMessage,
} from "./telegramBot";
import {
  DEFAULT_TELEGRAM_GROUP_URL,
  getTelegramGroupUrl,
  replaceTelegramGroupUrlInText,
} from "./telegramGroupLink";

const WORKER_NAME = "telegram_reminders";

const TELEGRAM_DIRECT_CONTACT = "@Prestigeofficiel_bot";
const TELEGRAM_DIRECT_CONTACT_LINE = `Une question ? Écris-moi en direct : ${TELEGRAM_DIRECT_CONTACT}`;
const WORKER_INTERVAL_MS = 60_000;
const PROCESS_BATCH_SIZE = 25;

export const TELEGRAM_REMINDER_STEPS = [
  {
    key: "15m",
    settingKey: "telegram_reminder_15m_message",
    delaySettingKey: "telegram_reminder_15m_delay_min",
    label: "Reminder 1 (15 min)",
    description: "First reminder if not joined.",
    defaultDelayMin: 15,
    defaultTemplate: "Hey {firstName} 👋 Je viens de remarquer que tu n’avais pas encore rejoint le groupe privé Prestige 🌐 Tu vas adorer ce qu’on partage là-bas — ton accès t’attend toujours ici → {group_url}",
  },
  {
    key: "1h",
    settingKey: "telegram_reminder_1h_message",
    delaySettingKey: "telegram_reminder_1h_delay_min",
    label: "Reminder 2 (1 h)",
    description: "Second reminder if not joined.",
    defaultDelayMin: 60,
    defaultTemplate: "Petit message pour toi {firstName} ✨ Au cas où tu aurais loupé le lien tout à l’heure, voici l’accès direct au groupe privé Prestige 🌐 → {group_url}",
  },
  {
    key: "4h",
    settingKey: "telegram_reminder_4h_message",
    delaySettingKey: "telegram_reminder_4h_delay_min",
    label: "Reminder 3 (4 h)",
    description: "Third reminder if not joined.",
    defaultDelayMin: 4 * 60,
    defaultTemplate: "{firstName}, le groupe privé Prestige 🌐 est toujours ouvert pour toi 🔓 Ne loupe pas les nouveautés et le contenu exclusif — entre quand tu veux ici → {group_url}",
  },
  {
    key: "24h",
    settingKey: "telegram_reminder_24h_message",
    delaySettingKey: "telegram_reminder_24h_delay_min",
    label: "Reminder 4 (24 h)",
    description: "24h reminder after /start.",
    defaultDelayMin: 24 * 60,
    defaultTemplate: "Hello {firstName} ☀️ Petit rappel : ton accès au groupe privé Prestige 🌐 est encore actif. Si t’as eu un empêchement hier, voici le re-lien → {group_url}",
  },
  {
    key: "1w",
    settingKey: "telegram_reminder_1w_message",
    delaySettingKey: "telegram_reminder_1w_delay_min",
    label: "Reminder 5 (1 week)",
    description: "Weekly nudge if still not joined.",
    defaultDelayMin: 7 * 24 * 60,
    defaultTemplate: "Hey {firstName} 👋 Cette semaine on a partagé pas mal de choses sympas dans le groupe privé Prestige 🌐 Si tu veux découvrir, c’est toujours par ici → {group_url}",
  },
  {
    key: "2w",
    settingKey: "telegram_reminder_2w_message",
    delaySettingKey: "telegram_reminder_2w_delay_min",
    label: "Reminder 6 (2 weeks)",
    description: "Two-week nudge if still not joined.",
    defaultDelayMin: 14 * 24 * 60,
    defaultTemplate: "Salut {firstName} ! Ça fait deux semaines que ton accès au groupe privé Prestige 🌐 t’attend. Si t’es toujours partant·e, viens nous rejoindre → {group_url}",
  },
  {
    key: "1m",
    settingKey: "telegram_reminder_1m_message",
    delaySettingKey: "telegram_reminder_1m_delay_min",
    label: "Reminder 7 (1 month)",
    description: "Final monthly reminder.",
    defaultDelayMin: 30 * 24 * 60,
    defaultTemplate: "Dernier mot de ma part {firstName} 🔔 Si tu veux encore profiter du groupe privé Prestige 🌐 et du contenu réservé, ton accès est toujours valable ici → {group_url}",
  },
] as const;

export type TelegramReminderStep = (typeof TELEGRAM_REMINDER_STEPS)[number];

const REMINDER_DELAY_MIN = 1; // minutes
const REMINDER_DELAY_MAX = 60 * 24 * 365; // 1 year cap (sanity)

function parseDelayMinutes(raw: string | null, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.max(REMINDER_DELAY_MIN, Math.min(REMINDER_DELAY_MAX, Math.floor(parsed)));
  return clamped;
}

export function isValidReminderDelayMinutes(value: number) {
  return Number.isFinite(value) && value >= REMINDER_DELAY_MIN && value <= REMINDER_DELAY_MAX;
}

export const TELEGRAM_REMINDER_DELAY_BOUNDS = {
  min: REMINDER_DELAY_MIN,
  max: REMINDER_DELAY_MAX,
} as const;

type ReminderTemplateContext = {
  firstName?: string | null;
  groupUrl?: string;
};

type BuildReminderDraftsInput = {
  telegramUserId: string;
  chatId: string;
  firstName?: string | null;
  startedAt?: Date;
  // Optional per-user invite URL to bake into every reminder. Set this when
  // the /start handler has just minted a chat_join_request invite link for the
  // user — keeps reminders aligned with the welcome and avoids leaking the
  // static admin URL through reminder messages.
  groupUrlOverride?: string;
};

let workerStarted = false;
let workerInterval: NodeJS.Timeout | null = null;
let workerRunning = false;

export function renderTelegramReminderMessage(template: string, context: ReminderTemplateContext = {}) {
  const firstName = (context.firstName || "").trim() || "toi";
  const groupUrl = context.groupUrl || DEFAULT_TELEGRAM_GROUP_URL;

  // Rewrite literal Telegram invite URLs in the template to the per-user
  // groupUrl BEFORE running placeholder substitution. Without this, any
  // template that hardcodes a t.me/+inviteHash (legacy templates, the 15m
  // default, admin-edited messages) leaks that link into reminder messageText
  // — bypassing the per-user join-request flow we just wired up.
  const templateWithSwappedUrls = replaceTelegramGroupUrlInText(template, groupUrl);

  const renderedMessage = templateWithSwappedUrls
    .replaceAll("{first_name}", firstName)
    .replaceAll("{firstName}", firstName)
    .replaceAll("{group_url}", groupUrl)
    .replaceAll("{groupLink}", groupUrl)
    .replaceAll("{brand}", "Prestige")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();

  if (renderedMessage.includes(TELEGRAM_DIRECT_CONTACT)) {
    return renderedMessage;
  }

  return `${renderedMessage}\n\n${TELEGRAM_DIRECT_CONTACT_LINE}`.trim();
}

// Render the welcome message with the same variable substitution as reminders
// (first name + group URL aliases) AND apply the same URL-rewrite the
// admin's link-editor performs, so legacy welcome messages stored before this
// change still update when the group URL changes.
export function renderTelegramWelcomeMessage(template: string, context: ReminderTemplateContext = {}) {
  const groupUrl = context.groupUrl || DEFAULT_TELEGRAM_GROUP_URL;
  const firstName = (context.firstName || "").trim() || "toi";

  return template
    .replaceAll("{first_name}", firstName)
    .replaceAll("{firstName}", firstName)
    .replaceAll("{group_url}", groupUrl)
    .replaceAll("{groupLink}", groupUrl)
    .replaceAll("{brand}", "Prestige")
    .trim();
}

export type ResolvedReminderStep = TelegramReminderStep & {
  template: string;
  delayMs: number;
  delayMin: number;
};

export async function getResolvedReminderSteps(): Promise<ResolvedReminderStep[]> {
  return Promise.all(
    TELEGRAM_REMINDER_STEPS.map(async (step) => {
      const [storedTemplate, storedDelay] = await Promise.all([
        getSetting(step.settingKey),
        getSetting(step.delaySettingKey),
      ]);
      const delayMin = parseDelayMinutes(storedDelay, step.defaultDelayMin);
      return {
        ...step,
        template: storedTemplate || step.defaultTemplate,
        delayMin,
        delayMs: delayMin * 60 * 1000,
      } satisfies ResolvedReminderStep;
    }),
  );
}

export async function buildTelegramReminderDrafts(input: BuildReminderDraftsInput) {
  const startedAt = input.startedAt || new Date();
  const steps = await getResolvedReminderSteps();
  const groupUrl =
    input.groupUrlOverride && input.groupUrlOverride.trim().length > 0
      ? input.groupUrlOverride
      : await getTelegramGroupUrl();

  return steps.map((step) => ({
    telegramUserId: input.telegramUserId,
    chatId: input.chatId,
    reminderKey: step.key,
    messageText: renderTelegramReminderMessage(step.template, {
      firstName: input.firstName,
      groupUrl,
    }),
    dueAt: new Date(startedAt.getTime() + step.delayMs),
  }));
}

function mapLegacyReminderUpdate(reminderKey: string) {
  const now = new Date();

  if (reminderKey === "15m") {
    return {
      reminderSent: "sent" as const,
      reminderSentAt: now,
    };
  }

  if (reminderKey === "1h") {
    return {
      reminder2Sent: "sent" as const,
      reminder2SentAt: now,
    };
  }

  if (reminderKey === "4h") {
    return {
      reminder3Sent: "sent" as const,
      reminder3SentAt: now,
    };
  }

  return null;
}

async function markLegacyReminderSent(telegramUserId: string, reminderKey: string) {
  const db = await getDb();
  if (!db) return;

  const legacyUpdate = mapLegacyReminderUpdate(reminderKey);
  if (!legacyUpdate) return;

  await db.update(botStarts).set(legacyUpdate).where(eq(botStarts.telegramUserId, telegramUserId));
}

export async function scheduleTelegramReminderSequence(input: BuildReminderDraftsInput) {
  const db = await getDb();
  if (!db) return;

  const drafts = await buildTelegramReminderDrafts(input);

  // Delete + insert run inside a single transaction so two concurrent /start
  // events for the same user can't interleave their delete-then-insert and
  // produce duplicate reminder jobs (the previous flow was racy).
  await db.transaction(async (tx) => {
    await tx
      .delete(telegramReminderJobs)
      .where(
        and(
          eq(telegramReminderJobs.telegramUserId, input.telegramUserId),
          or(
            eq(telegramReminderJobs.status, "pending"),
            eq(telegramReminderJobs.status, "processing"),
            eq(telegramReminderJobs.status, "failed"),
          ),
        ),
      );

    await tx.insert(telegramReminderJobs).values(drafts);
  });
}

export async function skipPendingTelegramReminderJobs(
  telegramUserId: string,
  reason: "joined_group" | "bot_blocked" | "rescheduled" | "manual_skip",
) {
  const db = await getDb();
  if (!db) return;

  await db
    .update(telegramReminderJobs)
    .set({
      status: "skipped",
      skippedReason: reason,
      skippedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(telegramReminderJobs.telegramUserId, telegramUserId),
        or(eq(telegramReminderJobs.status, "pending"), eq(telegramReminderJobs.status, "processing")),
      ),
    );
}

async function getDueTelegramReminderJobs(limit = PROCESS_BATCH_SIZE) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(telegramReminderJobs)
    .where(and(eq(telegramReminderJobs.status, "pending"), lte(telegramReminderJobs.dueAt, new Date())))
    .orderBy(asc(telegramReminderJobs.dueAt), asc(telegramReminderJobs.id))
    .limit(limit);
}

async function markJobProcessing(jobId: number) {
  const db = await getDb();
  if (!db) return;

  await db
    .update(telegramReminderJobs)
    .set({
      status: "processing",
      attempts: sql`${telegramReminderJobs.attempts} + 1`,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(telegramReminderJobs.id, jobId));
}

async function markJobSent(jobId: number) {
  const db = await getDb();
  if (!db) return;

  await db
    .update(telegramReminderJobs)
    .set({
      status: "sent",
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(telegramReminderJobs.id, jobId));
}

async function markJobSkipped(jobId: number, reason: string) {
  const db = await getDb();
  if (!db) return;

  await db
    .update(telegramReminderJobs)
    .set({
      status: "skipped",
      skippedReason: reason,
      skippedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(telegramReminderJobs.id, jobId));
}

async function markJobFailed(jobId: number, reason?: string) {
  const db = await getDb();
  if (!db) return;

  await db
    .update(telegramReminderJobs)
    .set({
      status: "failed",
      skippedReason: reason || null,
      failedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(telegramReminderJobs.id, jobId));
}

async function markBotBlocked(telegramUserId: string) {
  const db = await getDb();
  if (!db) return;

  await db.update(botStarts).set({ botBlocked: 1 }).where(eq(botStarts.telegramUserId, telegramUserId));
}

async function getBotStartState(telegramUserId: string) {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select({
      telegramUserId: botStarts.telegramUserId,
      joinedAt: botStarts.joinedAt,
      botBlocked: botStarts.botBlocked,
    })
    .from(botStarts)
    .where(eq(botStarts.telegramUserId, telegramUserId))
    .limit(1);

  return rows[0] || null;
}

// Resolve the per-user invite URL for a reminder send. Prefer the cached
// personal link (minted at /start with creates_join_request=true). If it's
// expired or absent, regenerate before sending so the keyboard button always
// routes through the bot's chat_join_request gate. Returns null when no
// personal link can be obtained — caller will skip the inline button rather
// than ship the static admin URL, which would re-open the bypass.
async function resolveReminderInviteUrl(telegramUserId: string): Promise<string | null> {
  const cached = await getValidPersonalInviteLink(telegramUserId);
  if (cached) return cached;

  const channelId = process.env.TELEGRAM_CHANNEL_ID || "";
  if (!channelId) return null;

  const minted = await createPersonalInviteLink({ chatId: channelId, telegramUserId });
  if (!minted.ok) {
    log.warn("telegramReminders", "personal_invite_link_regenerate_failed", {
      telegramUserId,
      error: minted.error,
    });
    return null;
  }
  await setBotStartPersonalInviteLink(telegramUserId, minted.inviteLink, minted.expiresAt);
  log.info("telegramReminders", "personal_invite_link_regenerated", {
    telegramUserId,
    expiresAt: minted.expiresAt.toISOString(),
  });
  return minted.inviteLink;
}

export async function processDueTelegramReminderJobs() {
  const jobs = await getDueTelegramReminderJobs();

  for (const job of jobs) {
    await markJobProcessing(job.id);

    const botStartState = await getBotStartState(job.telegramUserId);

    if (!botStartState) {
      await markJobSkipped(job.id, "missing_bot_start");
      continue;
    }

    if (botStartState.joinedAt) {
      await markJobSkipped(job.id, "joined_group");
      continue;
    }

    if (botStartState.botBlocked) {
      await markJobSkipped(job.id, "bot_blocked");
      continue;
    }

    // Per-user resolution: cached link, else regenerate. The static admin URL
    // is intentionally never used here. messageText was already baked with
    // the correct personal URL at job-creation time; the inline button is
    // the second surface where a stale/static link could leak.
    const inviteUrl = await resolveReminderInviteUrl(job.telegramUserId);
    const sendOptions = inviteUrl ? { replyMarkup: buildJoinGroupKeyboard(inviteUrl) } : {};

    const result = await sendTelegramMessage(job.chatId, job.messageText, sendOptions);

    if (result.ok) {
      await markJobSent(job.id);
      await markLegacyReminderSent(job.telegramUserId, job.reminderKey);
      continue;
    }

    if (result.blocked) {
      await markBotBlocked(job.telegramUserId);
      await skipPendingTelegramReminderJobs(job.telegramUserId, "bot_blocked");
      await markJobFailed(job.id, result.description);
      continue;
    }

    await markJobFailed(job.id, result.description);
  }
}

export function startTelegramReminderWorker() {
  if (workerStarted) return;
  workerStarted = true;

  const run = async () => {
    if (workerRunning) return;
    workerRunning = true;

    try {
      const isLeader = await tryAcquireLease(WORKER_NAME);
      if (!isLeader) {
        log.info("telegramReminders", "skip_tick_not_leader");
        return;
      }
      await processDueTelegramReminderJobs();
    } catch (error) {
      log.error("telegramReminders", "worker_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      workerRunning = false;
    }
  };

  void run();
  workerInterval = setInterval(() => {
    void run();
  }, WORKER_INTERVAL_MS);
}

export function stopTelegramReminderWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  workerStarted = false;
  workerRunning = false;
}
