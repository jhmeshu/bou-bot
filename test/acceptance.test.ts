import { describe, it, expect, beforeEach } from "vitest";
import { makeStack, inbound, toRecipient, toOwner, recipientState, OWNER, RECIP, dhakaTime } from "./helpers.js";
import type { Stack } from "../src/bootstrap.js";
import type { AppConfig } from "../src/config.js";
import { MockLlm } from "../src/llm/mock.js";

let stack: Stack & { cfg: AppConfig };

/** Mock LLM that also detects shopping-interest phrasing (LLM classifier role in production). */
function stackWithShopping(): Stack & { cfg: AppConfig; llm: MockLlm } {
  const s = makeStack();
  const llm = s.llm as MockLlm;
  const base = llm.classify.bind(llm);
  llm.classify = async (text: string) => {
    if (/কিনতে|নিতে চাই|উপহার/.test(text)) return { category: "shopping_interest" as const, confidence: 0.85 };
    return base(text);
  };
  return s as Stack & { cfg: AppConfig; llm: MockLlm };
}

async function optIn(s = stack): Promise<void> {
  await inbound(s, "START", { at: dhakaTime(9, 0) }); // 09:00 — consent confirm is not window-bound
}

beforeEach(() => {
  stack = makeStack();
});

describe("AC1+AC2: consent gate and AI disclosure", () => {
  it("sends NO proactive message before recipient opt-in", async () => {
    await inbound(stack, "কে এই নাম্বারে?"); // she exists but hasn't opted in
    const r = await stack.scheduler.tick(dhakaTime(12, 0));
    expect(r.sent).toBe(false);
    expect(r.reason).toContain("state=AWAITING_CONSENT");
    expect(toRecipient(stack).filter((m) => m.kind === "checkin")).toHaveLength(0);
  });

  it("first contact receives a clear AI disclosure and consent request", async () => {
    await inbound(stack, "কে এই নাম্বারে?");
    const msgs = toRecipient(stack);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("AI assistant");
    expect(msgs[0]!.body).toContain("START");
    expect(msgs[0]!.body).toContain("STOP");
    expect(recipientState(stack)).toBe("AWAITING_CONSENT");
  });

  it("re-prompts are rate-limited (no nagging)", async () => {
    await inbound(stack, "কে?");
    await inbound(stack, "হ্যালো কে এটা?");
    expect(toRecipient(stack)).toHaveLength(1); // second prompt suppressed
  });

  it("explicit opt-in activates the assistant and confirms", async () => {
    await inbound(stack, "START");
    expect(recipientState(stack)).toBe("ACTIVE");
    const msgs = toRecipient(stack);
    expect(msgs.at(-1)!.body).toContain("সম্মতি");
    expect(msgs.at(-1)!.body).toContain("AI"); // identity re-stated on consent
  });
});

describe("AC3: STOP disables everything immediately", () => {
  it("STOP confirms, stops state, and stays silent forever", async () => {
    await optIn();
    await inbound(stack, "STOP");
    expect(recipientState(stack)).toBe("STOPPED");
    expect(toRecipient(stack).at(-1)!.body).toContain("বন্ধ");

    // No reply to anything she says afterwards
    await inbound(stack, "আরে ফিরে আসো!");
    expect(toRecipient(stack).filter((m) => m.kind !== "stop_confirm").every((m) => m.body !== "আরে ফিরে আসো!")).toBe(true);
    expect(toRecipient(stack).at(-1)!.kind).toBe("stop_confirm");

    // No proactive message either
    const r = await stack.scheduler.tick(dhakaTime(12, 0));
    expect(r.sent).toBe(false);
    expect(r.reason).toContain("state=STOPPED");

    // The owner is informed
    expect(toOwner(stack).some((m) => m.body.includes("STOP"))).toBe(true);
  });

  it("START after STOP does not reactivate — only the owner can reinvite", async () => {
    await optIn();
    await inbound(stack, "STOP");
    await inbound(stack, "START");
    expect(recipientState(stack)).toBe("STOPPED");
    expect(toRecipient(stack).at(-1)!.kind).toBe("stop_confirm");

    await inbound(stack, "/reinvite", { from: OWNER });
    expect(recipientState(stack)).toBe("AWAITING_CONSENT");
    expect(toRecipient(stack).at(-1)!.body).toContain("AI assistant"); // fresh consent invitation
    await inbound(stack, "START");
    expect(recipientState(stack)).toBe("ACTIVE");
  });
});

describe("AC4: quiet hours and daily cap (FR-04, FR-05)", () => {
  it("blocks check-ins outside the messaging window", async () => {
    await optIn();
    // 22:00 Dhaka — after 21:00 window end
    const r = await stack.scheduler.tick(dhakaTime(22, 0));
    expect(r.sent).toBe(false);
    expect(r.reason).toContain("outside_window");
  });

  it("sends inside the window", async () => {
    await optIn();
    const r = await stack.scheduler.tick(dhakaTime(12, 0));
    expect(r.sent).toBe(true);
    const msg = toRecipient(stack).at(-1)!;
    expect(msg.kind).toBe("checkin");
    expect(msg.body).toContain("AI assistant"); // identity line on proactive messages
  });

  it("enforces the daily cap", async () => {
    await optIn();
    await stack.scheduler.tick(dhakaTime(10, 5));
    // she replies, so openers may continue
    await inbound(stack, "ভালো আছি! তুমি কেমন আছো?", { at: dhakaTime(10, 6) });
    await stack.scheduler.tick(dhakaTime(14, 10));
    await inbound(stack, "হুম ভালো", { at: dhakaTime(14, 11) });
    await stack.scheduler.tick(dhakaTime(18, 15));
    await inbound(stack, "এখন বাসায়", { at: dhakaTime(18, 16) });
    const r = await stack.scheduler.tick(dhakaTime(20, 30));
    expect(r.sent).toBe(false);
    expect(r.reason).toContain("daily_cap_reached");
    expect(toRecipient(stack).filter((m) => m.kind === "checkin")).toHaveLength(3);
  });

  it("does not open while she has an unanswered opener outstanding", async () => {
    await optIn();
    await stack.scheduler.tick(dhakaTime(11, 0));
    const r = await stack.scheduler.tick(dhakaTime(15, 30)); // no reply in between
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("unanswered_opener_outstanding");
  });
});

describe("AC5 + FR-08: shopping-interest pause and owner alert", () => {
  it("pauses the bot and alerts the owner without answering her", async () => {
    const s = stackWithShopping();
    await optIn(s);
    const before = toRecipient(s).length;
    const outcome = await inbound(s, "এই জামাটা খুব পছন্দ হয়েছে, মনে হচ্ছে কিনতে");
    expect(outcome.action).toBe("shopping_paused");
    expect(recipientState(s)).toBe("ACTIVE");
    expect(s.db.getConversationByWaId(RECIP)?.paused_for_owner).toBe(1);
    expect(toRecipient(s).length).toBe(before); // silent — no auto-reply
    const ownerMsgs = toOwner(s);
    expect(ownerMsgs.some((m) => m.body.includes("shopping-interest") && m.body.includes("জামাটা"))).toBe(true);
    expect(s.db.unresolvedAlerts()).toHaveLength(1);
  });

  it("stays silent while paused; owner /resume re-enables", async () => {
    const s = stackWithShopping();
    await optIn(s);
    await inbound(s, "এটা কিনতে ইচ্ছা করছে");
    await inbound(s, "কিনবো নাকি কিনবো না বলো না");
    expect(toRecipient(s).filter((m) => m.kind === "reply")).toHaveLength(0);
    await inbound(s, "/resume", { from: OWNER });
    expect(s.db.getConversationByWaId(RECIP)?.paused_for_owner).toBe(0);
    const outcome = await inbound(s, "ভালো তো বলো তো");
    expect(outcome.action).toBe("reply_sent");
  });
});

describe("AC6+AC7: escalation of serious/emergency/human-request (FR-09)", () => {
  it("escalates self-harm signals with emergency holding message", async () => {
    await optIn();
    const outcome = await inbound(stack, "আমি আর পারছি না, মরতে চাই");
    expect(outcome.action).toBe("escalated");
    expect(recipientState(stack)).toBe("ESCALATED");
    const holding = toRecipient(stack).at(-1)!.body;
    expect(holding).toContain("AI assistant"); // transparent identity (PRD 4.5.3)
    expect(holding).toContain("জরুরি সেবা"); // emergency services encouragement
    expect(holding).toContain("নিশ্চিত করে না"); // no guarantee-of-help implication
    const alerts = stack.db.unresolvedAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("urgent");
    expect(toOwner(stack).some((m) => m.body.includes("মরতে চাই"))).toBe(true);
  });

  it("escalates a direct request to talk to the owner without emergency wording", async () => {
    await optIn();
    const outcome = await inbound(stack, "আমি মানুষের সাথে কথা বলতে চাই এখন");
    expect(outcome.action).toBe("escalated");
    expect(recipientState(stack)).toBe("ESCALATED");
    expect(stack.db.unresolvedAlerts()[0]!.severity).toBe("urgent");
  });

  it("does NOT escalate ordinary conversation", async () => {
    await optIn();
    const outcome = await inbound(stack, "আজ অফিসে খুব কাজ ছিল, ক্লান্ত লাগছে");
    expect(outcome.action).toBe("reply_sent");
    expect(recipientState(stack)).toBe("ACTIVE");
  });

  it("escalation silences the bot until the owner resumes (two-phase)", async () => {
    await optIn();
    await inbound(stack, "আমি মানুষের সাথে কথা বলতে চাই");
    await inbound(stack, "ওয়ালা ইকুম বলছি শুনছো?"); // follow-up while escalated
    expect(toRecipient(stack).at(-1)!.kind).not.toBe("reply");

    await inbound(stack, "/takeover", { from: OWNER });
    expect(recipientState(stack)).toBe("OWNER_TAKEOVER");

    await inbound(stack, "/resume", { from: OWNER });
    expect(recipientState(stack)).toBe("OWNER_TAKEOVER"); // still silent...

    const outcome = await inbound(stack, "আবার কথা বলবে?"); // her next message completes resume
    expect(outcome.action).toBe("resume_completed");
    expect(recipientState(stack)).toBe("ACTIVE");
    expect(toRecipient(stack).at(-1)!.body).toContain("আবার চালু");
  });

  it("emergency follow-up during takeover alerts the owner immediately", async () => {
    await optIn();
    await inbound(stack, "আমি মানুষের সাথে কথা বলতে চাই");
    await inbound(stack, "/takeover", { from: OWNER });
    const alertsBefore = stack.db.unresolvedAlerts().length;
    await inbound(stack, "আমার খারাপ লাগছে খুব, মরে যাব বোধহয়");
    const alerts = stack.db.unresolvedAlerts();
    expect(alerts.length).toBe(alertsBefore + 1);
    expect(alerts[0]!.severity).toBe("urgent");
    expect(recipientState(stack)).toBe("OWNER_TAKEOVER"); // still not autonomous
  });
});

describe("AC8: duplicate webhook protection (FR-13)", () => {
  it("processes a redelivered message id only once", async () => {
    await optIn();
    const outcome1 = await inbound(stack, "কি করছো?", { id: "wamid.fixed-1" });
    const outcome2 = await inbound(stack, "কি করছো?", { id: "wamid.fixed-1" });
    expect(outcome1.action).toBe("reply_sent");
    expect(outcome2.action).toBe("duplicate_ignored");
    expect(toRecipient(stack).filter((m) => m.kind === "reply")).toHaveLength(1);
  });
});

describe("AC9: owner takeover produces zero competing bot messages", () => {
  it("bot stays completely silent during takeover", async () => {
    await optIn();
    await inbound(stack, "/takeover", { from: OWNER });
    expect(recipientState(stack)).toBe("OWNER_TAKEOVER");
    for (const text of ["হ্যালো?", "এই তো কথা", "তুমি কি আছো"]) {
      const outcome = await inbound(stack, text);
      expect(outcome.action).toBe("silent");
    }
    expect(toRecipient(stack).filter((m) => m.kind === "reply" || m.kind === "holding")).toHaveLength(0);
  });
});

describe("AC10: no impersonation — reply context and prompt bounds", () => {
  it("gives the LLM a bounded history (max 20 messages) and the incoming text", async () => {
    await optIn();
    for (let i = 0; i < 30; i++) await inbound(stack, `মেসেজ নাম্বার ${i}`);
    const llm = stack.llm as MockLlm;
    const lastCall = llm.replyCalls.at(-1)!;
    expect(lastCall.history.length).toBeLessThanOrEqual(20);
    expect(lastCall.incoming).toBe("মেসেজ নাম্বার 29");
    expect(lastCall.ownerName).toBe(stack.cfg.ownerName);
  });

  it("answers identity questions truthfully via the deterministic template", async () => {
    await optIn();
    const outcome = await inbound(stack, "তুমি কি মানুষ নাকি robot?");
    expect(outcome.action).toBe("identity_answered");
    const answer = toRecipient(stack).at(-1)!.body;
    expect(answer).toContain("AI assistant");
    expect(answer).toContain("মানুষ না");
  });

  it("system prompt embeds the PRD §9 policy", async () => {
    const { buildSystemPrompt } = await import("../src/engine/prompts.js");
    const p = buildSystemPrompt({ recipientName: "জান", ownerName: "Janibul" });
    expect(p).toContain("NEVER pretend to be Janibul");
    expect(p).toContain("NEVER invent facts");
    expect(p).toContain("NEVER conceal");
    expect(p).toContain("Never make purchases, promises, financial commitments");
    expect(p).toContain("guilt, pressure");
  });
});

describe("AC11: audit trail (FR-11)", () => {
  it("records why messages were sent, paused, or escalated", async () => {
    await optIn();
    await stack.scheduler.tick(dhakaTime(12, 0));
    await inbound(stack, "আজ দুপুরে ভাত খেয়েছো?", { at: dhakaTime(12, 5) });
    const events = stack.db.recentAudit(100).map((a) => a.event);
    expect(events).toContain("recipient_opted_in");
    expect(events).toContain("checkin_sent");
    expect(events).toContain("message_sent");
  });
});

describe("edge cases", () => {
  it("scheduler is idempotent under overlapping ticks", async () => {
    await optIn();
    const now = dhakaTime(12, 0);
    const [a, b] = await Promise.all([stack.scheduler.tick(now), stack.scheduler.tick(now)]);
    expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1);
  });

  it("PAUSE keyword pauses; START resumes", async () => {
    await optIn();
    await inbound(stack, "PAUSE");
    expect(recipientState(stack)).toBe("PAUSED_BY_RECIPIENT");
    expect(toRecipient(stack).at(-1)!.body).toContain("বিরতি");
    await stack.scheduler.tick(dhakaTime(12, 0));
    expect(toRecipient(stack).filter((m) => m.kind === "checkin")).toHaveLength(0);
    await inbound(stack, "START");
    expect(recipientState(stack)).toBe("ACTIVE");
  });

  it("owner /pause and dashboard-style commands route through the same pipeline", async () => {
    await optIn();
    await inbound(stack, "/pause", { from: OWNER });
    expect(recipientState(stack)).toBe("PAUSED_BY_OWNER");
    await inbound(stack, "/resume", { from: OWNER });
    expect(recipientState(stack)).toBe("ACTIVE"); // paused-by-owner resumes directly
    await inbound(stack, "/takeover", { from: OWNER });
    expect(recipientState(stack)).toBe("OWNER_TAKEOVER");
  });

  it("messages she sends while paused-by-owner stay silent; emergency interrupts", async () => {
    await optIn();
    await inbound(stack, "/pause", { from: OWNER });
    const outcome = await inbound(stack, "আমার বোনের দুর্ঘটনা হয়েছে!");
    expect(outcome.action).toBe("escalated");
    expect(recipientState(stack)).toBe("ESCALATED");
    expect(stack.db.unresolvedAlerts()[0]!.severity).toBe("urgent");
  });
});
