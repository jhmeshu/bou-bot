import { describe, it, expect, beforeEach } from "vitest";
import { makeStack, inbound, toRecipient, dhakaTime } from "./helpers.js";
import { withinWindow, tzDateStr, tzTimeStr } from "../src/engine/scheduler.js";
import type { Stack } from "../src/bootstrap.js";
import type { AppConfig } from "../src/config.js";

let stack: Stack & { cfg: AppConfig };

beforeEach(() => {
  stack = makeStack();
});

describe("timezone helpers", () => {
  it("formats Dhaka date/time correctly (UTC+6)", () => {
    const d = new Date("2026-11-16T04:30:00Z"); // 10:30 Dhaka
    expect(tzTimeStr(d, "Asia/Dhaka")).toBe("10:30");
    expect(tzDateStr(d, "Asia/Dhaka")).toBe("2026-11-16");
    expect(tzTimeStr(d, "UTC")).toBe("04:30");
    expect(tzDateStr(d, "UTC")).toBe("2026-11-16");
  });

  it("window boundaries: inclusive start, exclusive end", () => {
    expect(withinWindow("10:00", "10:00", "21:00")).toBe(true);
    expect(withinWindow("09:59", "10:00", "21:00")).toBe(false);
    expect(withinWindow("21:00", "10:00", "21:00")).toBe(false);
    expect(withinWindow("20:59", "10:00", "21:00")).toBe(true);
    expect(withinWindow("12:30", "10:00", "21:00")).toBe(true);
  });
});

describe("FR-04/FR-05 scheduling guards", () => {
  it("no proactive at all before the recipient exists", async () => {
    const r = await stack.scheduler.tick(dhakaTime(12, 0));
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("no_recipient_configured");
  });

  it("blocks at window edges", async () => {
    await inbound(stack, "START", { at: dhakaTime(9, 0) });
    const early = await stack.scheduler.tick(dhakaTime(9, 59));
    expect(early.reason).toContain("outside_window");
    const ok = await stack.scheduler.tick(dhakaTime(10, 0));
    expect(ok.sent).toBe(true);
    const late = await stack.scheduler.tick(dhakaTime(21, 0));
    expect(late.sent).toBe(false);
    expect(late.reason).toContain("outside_window");
  });

  it("respects minimum interval between check-ins", async () => {
    await inbound(stack, "START", { at: dhakaTime(9, 0) });
    await stack.scheduler.tick(dhakaTime(10, 0));
    await inbound(stack, "হুম ভালো", { at: dhakaTime(10, 1) });
    const soon = await stack.scheduler.tick(dhakaTime(12, 30)); // 2.5h later
    expect(soon.reason).toContain("min_interval");
    const enough = await stack.scheduler.tick(dhakaTime(14, 1)); // 4h+ later
    expect(enough.sent).toBe(true);
  });

  it("different tz_date resets the daily cap", async () => {
    await inbound(stack, "START", { at: dhakaTime(9, 0) });
    await stack.scheduler.tick(dhakaTime(10, 0));
    await inbound(stack, "ভালো", { at: dhakaTime(10, 1) });
    await stack.scheduler.tick(dhakaTime(14, 5));
    await inbound(stack, "ভালো", { at: dhakaTime(14, 6) });
    await stack.scheduler.tick(dhakaTime(18, 10));
    await inbound(stack, "ভালো", { at: dhakaTime(18, 11) });
    const capped = await stack.scheduler.tick(dhakaTime(20, 0));
    expect(capped.reason).toContain("daily_cap_reached");
    // next day: cap resets, window still applies
    const tomorrow = await stack.scheduler.tick(dhakaTime(10, 0, 1));
    expect(tomorrow.sent).toBe(true);
    expect(toRecipient(stack).filter((m) => m.kind === "checkin")).toHaveLength(4);
  });

  it("conversation-active guard blocks openers within 30 minutes of her message", async () => {
    await inbound(stack, "START", { at: dhakaTime(9, 0) });
    await inbound(stack, "এই তো বলছি সময় কোথায় যায়", { at: dhakaTime(11, 50) });
    const r = await stack.scheduler.tick(dhakaTime(12, 10)); // 20 min after her message
    expect(r.reason).toBe("conversation_active");
    const later = await stack.scheduler.tick(dhakaTime(12, 30)); // 40 min after
    expect(later.sent).toBe(true);
  });
});
