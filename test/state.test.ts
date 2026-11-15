import { describe, it, expect } from "vitest";
import { assertTransition, TransitionError } from "../src/state.js";

describe("conversation state machine (PRD §8)", () => {
  it("allows recipient opt-in from AWAITING_CONSENT", () => {
    expect(() => assertTransition("AWAITING_CONSENT", "recipient", "ACTIVE")).not.toThrow();
  });

  it("recipient can pause/stop an ACTIVE conversation", () => {
    expect(() => assertTransition("ACTIVE", "recipient", "PAUSED_BY_RECIPIENT")).not.toThrow();
    expect(() => assertTransition("ACTIVE", "recipient", "STOPPED")).not.toThrow();
  });

  it("system may escalate but never resume", () => {
    expect(() => assertTransition("ACTIVE", "system", "ESCALATED")).not.toThrow();
    expect(() => assertTransition("ESCALATED", "system", "ACTIVE")).toThrow(TransitionError);
    expect(() => assertTransition("OWNER_TAKEOVER", "system", "ACTIVE")).toThrow(TransitionError);
    expect(() => assertTransition("STOPPED", "system", "ACTIVE")).toThrow(TransitionError);
  });

  it("only the owner exits takeover/paused-owner/stopped states", () => {
    expect(() => assertTransition("OWNER_TAKEOVER", "owner", "ACTIVE")).not.toThrow();
    expect(() => assertTransition("PAUSED_BY_OWNER", "owner", "ACTIVE")).not.toThrow();
    expect(() => assertTransition("STOPPED", "owner", "AWAITING_CONSENT")).not.toThrow();
    expect(() => assertTransition("STOPPED", "recipient", "ACTIVE")).toThrow(TransitionError);
    expect(() => assertTransition("ESCALATED", "recipient", "ACTIVE")).toThrow(TransitionError);
  });

  it("STOPPED only re-opens via owner-initiated re-consent", () => {
    expect(() => assertTransition("STOPPED", "owner", "ACTIVE")).toThrow(TransitionError);
    assertTransition("STOPPED", "owner", "AWAITING_CONSENT");
  });
});
