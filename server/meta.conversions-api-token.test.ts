import { describe, expect, it } from "vitest";

const EXPECTED_PIXEL_ID = "603715665407285";

describe("META credentials", () => {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CONVERSIONS_TOKEN;
  const hasMetaCreds = Boolean(pixelId && token);

  it.skipIf(!hasMetaCreds)(
    "expose un pixel configuré et permet un appel léger à l'API Graph Meta",
    async () => {
      expect(pixelId).toBeTruthy();
      expect(pixelId).toBe(EXPECTED_PIXEL_ID);
      expect(token).toBeTruthy();

      const response = await fetch(
        `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(token as string)}`,
      );

      const payload = await response.json();

      expect(response.ok).toBe(true);
      expect(payload).toHaveProperty("id");
    },
    20_000,
  );
});
