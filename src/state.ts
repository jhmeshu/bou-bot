/**
 * Conversation state model — PRD §8.
 *
 * AWAITING_CONSENT, ACTIVE, PAUSED_BY_RECIPIENT, PAUSED_BY_OWNER,
 * OWNER_TAKEOVER, ESCALATED, STOPPED.
 *
 * Only an explicit, authorized action may move the assistant out of a
 * paused, takeover, escalated, or stopped state.
 */

export type ConversationState =
  | "AWAITING_CONSENT"
  | "ACTIVE"
  | "PAUSED_BY_RECIPIENT"
  | "PAUSED_BY_OWNER"
  | "OWNER_TAKEOVER"
  | "ESCALATED"
  | "STOPPED";

export type Actor = "recipient" | "owner" | "system";

const TRANSITIONS: Record<ConversationState, Partial<Record<Actor, ConversationState[]>>> = {
  AWAITING_CONSENT: {
    recipient: ["ACTIVE", "STOPPED"],
    owner: ["STOPPED", "PAUSED_BY_OWNER"],
    system: ["STOPPED"],
  },
  ACTIVE: {
    recipient: ["PAUSED_BY_RECIPIENT", "STOPPED"],
    owner: ["PAUSED_BY_OWNER", "OWNER_TAKEOVER", "STOPPED"],
    system: ["ESCALATED"],
  },
  PAUSED_BY_RECIPIENT: {
    recipient: ["ACTIVE", "STOPPED"],
    owner: ["ACTIVE", "OWNER_TAKEOVER", "STOPPED"],
    system: ["ESCALATED"], // safety can still interrupt a pause to alert the owner
  },
  PAUSED_BY_OWNER: {
    owner: ["ACTIVE", "OWNER_TAKEOVER", "STOPPED"],
    system: ["ESCALATED"],
  },
  OWNER_TAKEOVER: {
    owner: ["ACTIVE", "PAUSED_BY_OWNER", "STOPPED"],
    system: [], // the bot never leaves takeover on its own
  },
  ESCALATED: {
    owner: ["ACTIVE", "OWNER_TAKEOVER", "STOPPED"],
    system: [], // never resumes autonomously
  },
  STOPPED: {
    // STOP is terminal for automation. Owner /reinvite sends a fresh consent
    // invitation — the recipient must still opt in again before anything sends.
    owner: ["AWAITING_CONSENT"],
    recipient: [],
    system: [],
  },
};

export class TransitionError extends Error {
  constructor(from: ConversationState, actor: Actor, to: ConversationState) {
    super(`Illegal transition: ${from} --(${actor})--> ${to}`);
    this.name = "TransitionError";
  }
}

export function assertTransition(
  from: ConversationState,
  actor: Actor,
  to: ConversationState,
): void {
  const allowed = TRANSITIONS[from][actor] ?? [];
  if (!allowed.includes(to)) throw new TransitionError(from, actor, to);
}
