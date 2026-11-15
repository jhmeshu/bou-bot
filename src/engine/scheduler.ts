import type { AppConfig } from "../config.js";
import type { Db, Conversation } from "../db.js";
import type { WaClient } from "../wa/types.js";

/**
 * Proactive check-in scheduler (PRD §4.2). Sends ONLY when every guard passes:
 * state ACTIVE, not paused-for-owner, inside the approved window (recipient's
 * timezone), under the daily cap, above the minimum interval, no active
 * conversation, and no unanswered opener outstanding. Idempotent via
 * scheduler_log slots (FR-13).
 */
export class CheckinScheduler {
  private tickRunning = false;

  constructor(
    private cfg: AppConfig,
    private db: Db,
    private wa: WaClient,
  ) {}

  async tick(now: Date = new Date()): Promise<{ sent: boolean; reason: string }> {
    if (this.tickRunning) return { sent: false, reason: "tick_overlapping" };
    this.tickRunning = true;
    try {
      return await this.trySendCheckin(now);
    } finally {
      this.tickRunning = false;
    }
  }

  private async trySendCheckin(now: Date): Promise<{ sent: boolean; reason: string }> {
    const cfg = this.cfg;
    const conv = cfg.recipientPhone ? this.db.getConversationByWaId(cfg.recipientPhone) : undefined;
    if (!conv) return { sent: false, reason: "no_recipient_configured" };
    if (conv.state !== "ACTIVE") return { sent: false, reason: `state=${conv.state}` };
    if (conv.paused_for_owner) return { sent: false, reason: "paused_for_owner" };
    if (conv.resume_pending) return { sent: false, reason: "resume_pending" };

    const tzDate = tzDateStr(now, cfg.recipientTimezone);
    const sentToday = this.db.proactiveCountForDate(conv.id, tzDate);
    if (sentToday >= cfg.dailyProactiveCap) {
      return { sent: false, reason: `daily_cap_reached (${sentToday}/${cfg.dailyProactiveCap})` };
    }

    const localTime = tzTimeStr(now, cfg.recipientTimezone);
    if (!withinWindow(localTime, cfg.windowStart, cfg.windowEnd)) {
      return { sent: false, reason: `outside_window (${localTime}, window ${cfg.windowStart}–${cfg.windowEnd})` };
    }

    if (conv.last_proactive_at) {
      const hours = (now.getTime() - Date.parse(conv.last_proactive_at)) / 3_600_000;
      if (hours < cfg.minProactiveIntervalHours) {
        return { sent: false, reason: `min_interval (${hours.toFixed(1)}h < ${cfg.minProactiveIntervalHours}h)` };
      }
    }

    // PRD 4.2.4: no opener while a conversation is active...
    const lastInbound = conv.last_inbound_at ? Date.parse(conv.last_inbound_at) : 0;
    const lastOutbound = conv.last_outbound_at ? Date.parse(conv.last_outbound_at) : 0;
    if (now.getTime() - lastInbound < cfg.activeConversationMins * 60_000) {
      return { sent: false, reason: "conversation_active" };
    }
    // ...or while she hasn't replied to the latest check-in (only openers count;
    // confirmations and replies don't put the bot in "waiting for her" state).
    if (conv.last_outbound_kind === "checkin" && lastOutbound > lastInbound) {
      return { sent: false, reason: "unanswered_opener_outstanding" };
    }

    // Claim a deterministic slot before sending (webhook-redelivery / double-tick safety).
    const slot = sentToday + 1;
    const dedupKey = `proactive:${conv.id}:${tzDate}:${slot}`;
    if (!this.db.claimSchedulerSlot(dedupKey, "")) {
      return { sent: false, reason: "slot_already_claimed" };
    }

    const template = cfg.checkinTemplates[sentToday % cfg.checkinTemplates.length]!;
    // Mock mode composes text + signature; Cloud mode sends the pre-approved
    // template body (signature is baked into the approved template content).
    const composed =
      this.wa.provider === "cloud"
        ? template.text
        : `${template.text}\n${cfg.signatureLine}`;
    const result =
      this.wa.provider === "cloud"
        ? await this.wa.sendTemplate(conv.wa_id, template.name, cfg.checkinLang, [])
        : await this.wa.sendText(conv.wa_id, composed);

    if (!result.ok) {
      this.db.audit("checkin_send_failed", "system", JSON.stringify({ template: template.name, error: result.error }));
      return { sent: false, reason: `send_failed: ${result.error}` };
    }

    this.db.insertMessage({
      conversation_id: conv.id,
      direction: "out",
      wa_message_id: result.waMessageId ?? null,
      body: composed,
      kind: "checkin",
      tz_date: tzDate,
    });
    this.db.updateConversation(conv.id, {
      last_proactive_at: now.toISOString(),
      last_outbound_at: now.toISOString(),
      last_outbound_kind: "checkin",
    });
    this.db.audit("checkin_sent", "system", JSON.stringify({ template: template.name, slot }));
    return { sent: true, reason: `checkin via ${template.name}` };
  }
}

// --- timezone helpers ---

export function tzDateStr(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // YYYY-MM-DD
}

export function tzTimeStr(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d); // HH:MM (may carry a leading zero-padded 24h format)
}

/** Inclusive start, exclusive end. String compare is safe for zero-padded HH:MM. */
export function withinWindow(time: string, start: string, end: string): boolean {
  const normalized = normalizeHhMm(time);
  return normalized >= normalizeHhMm(start) && normalized < normalizeHhMm(end);
}

function normalizeHhMm(s: string): string {
  const [h, m] = s.split(":");
  return `${String(Number(h)).padStart(2, "0")}:${String(Number(m)).padStart(2, "0")}`;
}

export type { Conversation };
