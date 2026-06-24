import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSetting = vi.fn();
vi.mock("./db", () => ({
  getSetting: (key: string) => getSetting(key),
}));

import {
  TELEGRAM_CHANNEL_ID_SETTING_KEY,
  getTelegramChannelId,
  validateTelegramChannelId,
} from "./telegramChannel";

describe("validateTelegramChannelId", () => {
  it("accepts a well-formed -100 channel id", () => {
    expect(validateTelegramChannelId("-1003843266944")).toEqual({
      ok: true,
      value: "-1003843266944",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(validateTelegramChannelId("  -1003843266944  ")).toEqual({
      ok: true,
      value: "-1003843266944",
    });
  });

  it("rejects an empty value", () => {
    const result = validateTelegramChannelId("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects an invite URL pasted into the field", () => {
    const result = validateTelegramChannelId("https://t.me/+8jUUZz-SG6IxNDNk");
    expect(result.ok).toBe(false);
  });

  it("rejects a positive / non -100 id", () => {
    expect(validateTelegramChannelId("3843266944").ok).toBe(false);
    expect(validateTelegramChannelId("-3843266944").ok).toBe(false);
  });

  it("rejects an @handle", () => {
    expect(validateTelegramChannelId("@Official_Prestige").ok).toBe(false);
  });
});

describe("getTelegramChannelId", () => {
  const ORIGINAL_ENV = process.env.TELEGRAM_CHANNEL_ID;

  beforeEach(() => {
    getSetting.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TELEGRAM_CHANNEL_ID;
    else process.env.TELEGRAM_CHANNEL_ID = ORIGINAL_ENV;
  });

  it("prefers the DB setting over the env var", async () => {
    process.env.TELEGRAM_CHANNEL_ID = "-1000000000001";
    getSetting.mockResolvedValue("-1009999999999");
    await expect(getTelegramChannelId()).resolves.toBe("-1009999999999");
    expect(getSetting).toHaveBeenCalledWith(TELEGRAM_CHANNEL_ID_SETTING_KEY);
  });

  it("falls back to the env var when no DB setting exists", async () => {
    process.env.TELEGRAM_CHANNEL_ID = "-1000000000001";
    getSetting.mockResolvedValue(null);
    await expect(getTelegramChannelId()).resolves.toBe("-1000000000001");
  });

  it("ignores a blank DB setting and falls back to env", async () => {
    process.env.TELEGRAM_CHANNEL_ID = "-1000000000001";
    getSetting.mockResolvedValue("   ");
    await expect(getTelegramChannelId()).resolves.toBe("-1000000000001");
  });
});
