import { loadConfig, type AppConfig } from "../src/config.js";
import { buildStack, type Stack } from "../src/bootstrap.js";

export const OWNER = "8801000000001";
export const RECIP = "8801000000002";

export function makeStack(overrides: Record<string, string> = {}): Stack & { cfg: AppConfig } {
  const cfg = loadConfig({
    OWNER_PHONE: OWNER,
    RECIPIENT_PHONE: RECIP,
    ADMIN_TOKEN: "test-token",
    DB_PATH: ":memory:",
    ACTIVE_CONVERSATION_MINS: "30",
    STALE_INBOUND_MINS: "15",
    ...overrides,
  });
  const stack = buildStack(cfg);
  return stack as Stack & { cfg: AppConfig };
}

/** Simulate an inbound recipient message; returns orchestrator outcome. */
export function inbound(
  stack: Stack,
  text: string,
  opts: { from?: string; id?: string; at?: Date } = {},
) {
  return stack.orchestrator.handleInbound({
    from: opts.from ?? RECIP,
    text,
    waMessageId: opts.id ?? `wamid-${Math.random().toString(36).slice(2)}`,
    timestamp: opts.at ?? new Date(),
  });
}

/** All simulated outbound messages (recipient + owner threads, oldest first). */
export function outbox(stack: Stack): { body: string; kind: string; conversation_id: number }[] {
  const rows = stack.db.sqlite
    .prepare(
      `SELECT m.body, m.kind, m.conversation_id FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.wa_id LIKE 'sim_outbox:%' ORDER BY m.id ASC`,
    )
    .all() as unknown as { body: string; kind: string; conversation_id: number }[];
  return rows;
}

/** Outbox messages addressed to the recipient only (outbound orchestrator rows, true kinds). */
export function toRecipient(stack: Stack) {
  const conv = stack.db.getConversationByWaId(RECIP);
  return conv
    ? stack.db.recentMessages(conv.id, 200).reverse().filter((m) => m.direction === "out")
    : [];
}

/** Outbox messages addressed to the owner only (owner thread rows: acks + alerts). */
export function toOwner(stack: Stack) {
  const conv = stack.db.getConversationByWaId(`owner:${OWNER}`);
  return conv
    ? stack.db.recentMessages(conv.id, 200).reverse().filter((m) => m.direction === "out")
    : [];
}

export function recipientState(stack: Stack): string {
  return stack.db.getConversationByWaId(RECIP)?.state ?? "(none)";
}

/** Dhaka is UTC+6. A UTC instant that reads as hh:mm recipient-local. */
export function dhakaTime(h: number, m: number, dayOffsetDays = 0): Date {
  const base = new Date();
  const dhakaNow = new Date(base.getTime() + 6 * 3600_000);
  const day = new Date(
    Date.UTC(
      dhakaNow.getUTCFullYear(),
      dhakaNow.getUTCMonth(),
      dhakaNow.getUTCDate() + dayOffsetDays,
      h - 6,
      m,
    ),
  );
  return day;
}
