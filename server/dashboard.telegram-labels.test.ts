import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(new URL("../client/src/pages/Dashboard.tsx", import.meta.url), "utf8");

describe("Dashboard channel labels", () => {
  it("shows channel-link clicks separately from direct Telegram contact", () => {
    expect(dashboardSource).toContain('whatsapp_click: "Channel link click"');
    expect(dashboardSource).toContain('title="Clics lien canal"');
    expect(dashboardSource).toContain('title="Start bot"');
    expect(dashboardSource).toContain('title="Abonnés canal"');
    expect(dashboardSource).toContain('title="Contact direct"');
    expect(dashboardSource).toContain('>Clic canal</th>');
    expect(dashboardSource).toContain('>Contact direct</th>');
  });

  it("ne conserve plus les anciens libellés WhatsApp dans les zones principales du dashboard", () => {
    expect(dashboardSource).not.toContain('title="WhatsApp Clicks"');
    expect(dashboardSource).not.toContain('>WhatsApp</th>');
    expect(dashboardSource).not.toContain('whatsapp_click: "WhatsApp click"');
  });
});
