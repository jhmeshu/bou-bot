import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { WaClient } from "../wa/types.js";
import { Messages } from "../i18n.js";

/**
 * Owner alert channel (PRD §7.7). Alerts are persisted FIRST — a failed
 * delivery is never a lost alert; it stays unresolved and visible in the
 * control panel until the owner sees it.
 */
export class AlertEngine {
  readonly messages: Messages;
  /** last "minor" owner notification, for rate-limiting pings */
  private lastMinorNotify = 0;

  constructor(
    private cfg: AppConfig,
    private db: Db,
    private wa: WaClient,
  ) {
    this.messages = new Messages(cfg);
  }

  async raise(opts: {
    conversationId: number;
    severity: "urgent" | "normal";
    reason: string;
    triggerMessage: string;
    extra?: string;
  }): Promise<void> {
    const alert = this.db.insertAlert({
      conversation_id: opts.conversationId,
      severity: opts.severity,
      reason: opts.reason,
      trigger_message: opts.triggerMessage,
    });
    this.db.audit(
      "alert_raised",
      "system",
      JSON.stringify({ alertId: alert.id, severity: opts.severity, reason: opts.reason }),
    );
    await this.notify(opts.reason, opts.triggerMessage, opts.extra ?? "");
  }

  private async notify(reason: string, trigger: string, extra: string): Promise<void> {
    const text = this.messages.ownerAlert(reason, trigger, extra);
    await this.deliverToOwner(text, reason);
  }

  /** Minor informational pings (e.g. inbound after STOP) — max one per hour. */
  async notifyMinorIfDue(text: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastMinorNotify < 60 * 60 * 1000) return;
    this.lastMinorNotify = now;
    await this.deliverToOwner(text, "info");
  }

  private async deliverToOwner(text: string, reason: string): Promise<void> {
    if (!this.cfg.ownerPhone) {
      console.warn(`⚠️ [owner-notify] OWNER_PHONE not configured — alert only in DB/control panel: ${reason}`);
      this.db.audit("owner_notify_skipped", "system", "OWNER_PHONE not configured");
      return;
    }
    let result = await this.wa.sendText(this.cfg.ownerPhone, text);
    if (!result.ok && result.needsTemplate) {
      // 24h free-form window closed — fall back to the approved utility template.
      result = await this.wa.sendTemplate(
        this.cfg.ownerPhone,
        this.cfg.ownerAlertTemplate,
        "bn",
        [reason.slice(0, 60), trigger_preview(text)],
      );
    }
    if (!result.ok) {
      console.error(`🚨 [owner-notify] FAILED to deliver alert (${reason}): ${result.error}`);
      this.db.audit("owner_notify_failed", "system", JSON.stringify({ reason, error: result.error }));
      return;
    }
    this.db.audit("owner_notified", "system", reason);
    // Persist into the owner thread so the control panel / tests can read the history.
    const oc = this.db.getOrCreateConversation(`owner:${this.cfg.ownerPhone}`);
    this.db.updateConversation(oc.id, { state: "ACTIVE" });
    this.db.insertMessage({
      conversation_id: oc.id,
      direction: "out",
      wa_message_id: result.waMessageId ?? null,
      body: text,
      kind: "owner_alert",
    });
  }
}

function trigger_preview(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("মেসেজ:")) ?? "";
  return line.replace("মেসেজ:", "").trim().slice(0, 120);
}
