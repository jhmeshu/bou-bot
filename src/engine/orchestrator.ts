import type { AppConfig } from "../config.js";
import type { Db, Conversation, StoredMessage } from "../db.js";
import { assertTransition, type Actor, type ConversationState } from "../state.js";
import type { WaClient } from "../wa/types.js";
import { detectCommand, classifyMessage } from "./classifier.js";
import { AlertEngine } from "./alerts.js";
import { Messages } from "../i18n.js";
import type { LlmProvider } from "../llm/provider.js";
import { LlmUnavailableError } from "../llm/provider.js";
import { LlmRefusalError } from "../llm/anthropic.js";

/**
 * Conversation orchestrator (PRD §7.3) — the single gatekeeper between any
 * inbound WhatsApp message and any outbound message. Applies consent, state,
 * quiet/pause/takeover, and escalation rules BEFORE anything is sent.
 */
export interface InboundOutcome {
  action:
    | "duplicate_ignored"
    | "owner_command"
    | "consent_prompted"
    | "consent_confirmed"
    | "reply_sent"
    | "paused"
    | "stop_confirmed"
    | "stop_silent"
    | "escalated"
    | "shopping_paused"
    | "identity_answered"
    | "silent"
    | "delay_note_sent"
    | "resume_completed";
  detail?: string;
}

const DISCLOSURE_PROMPT_MIN_GAP_MS = 30 * 60 * 1000;

export class Orchestrator {
  readonly messages: Messages;
  private alerts: AlertEngine;

  constructor(
    private cfg: AppConfig,
    private db: Db,
    private wa: WaClient,
    private llm: LlmProvider,
  ) {
    this.messages = new Messages(cfg);
    this.alerts = new AlertEngine(cfg, db, wa);
  }

  /** Entry point for every inbound message (after webhook signature validation). */
  async handleInbound(input: { from: string; text: string; waMessageId: string; timestamp: Date }): Promise<InboundOutcome> {
    const conv = this.db.getOrCreateConversation(input.from);
    const stored = this.db.insertMessage({
      conversation_id: conv.id,
      direction: "in",
      wa_message_id: input.waMessageId,
      body: input.text,
      kind: "inbound",
      created_at: input.timestamp.toISOString(),
    });
    if (!stored) {
      // Duplicate webhook redelivery — never process twice (FR-13, acceptance criterion 8).
      this.db.audit("duplicate_inbound_ignored", "system", input.waMessageId);
      return { action: "duplicate_ignored" };
    }
    this.db.updateConversation(conv.id, {
      last_inbound_at: input.timestamp.toISOString(),
    });

    if (input.from === this.cfg.ownerPhone) return this.handleOwnerThread(conv, input.text);
    return this.handleRecipient(conv, stored, input);
  }

  // ------------------------------------------------------------------
  // Owner thread: /takeover /resume /pause /reinvite /status /help
  // ------------------------------------------------------------------

  private async handleOwnerThread(conv: Conversation, text: string): Promise<InboundOutcome> {
    const cmd = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    this.db.audit("owner_message", "owner", text.slice(0, 200));
    // Owner commands always act on the RECIPIENT's conversation — `conv` here is
    // just the owner's own message thread.
    const rc = this.db.getConversationByWaId(this.cfg.recipientPhone);
    if (!rc) {
      await this.sendOwnerRaw("ℹ️ রিসিপিয়েন্ট এখনো configure করা নাই (RECIPIENT_PHONE)।");
      return { action: "owner_command", detail: "no_recipient" };
    }
    const ack = (c: string, effect: string) => this.sendOwnerRaw(this.messages.ownerAck(c, effect));

    switch (cmd) {
      case "/takeover": {
        this.transition(rc, "OWNER_TAKEOVER", "owner", { resume_pending: 0, paused_for_owner: 0 });
        await ack("takeover", "বট এখন সম্পূর্ণ চুপ। তুমি নিজে উত্তর দাও।");
        return { action: "owner_command", detail: "takeover" };
      }
      case "/resume": {
        if (rc.state === "PAUSED_BY_OWNER") {
          this.transition(rc, "ACTIVE", "owner", { resume_pending: 0, paused_for_owner: 0 });
          await ack("resume", "বট সরাসরি চালু হয়েছে।");
          return { action: "owner_command", detail: "resume_active" };
        }
        if (rc.state === "ESCALATED" || rc.state === "OWNER_TAKEOVER") {
          // Two-phase resume — recipient's next message re-activates (Q8 default).
          this.db.updateConversation(rc.id, { resume_pending: 1, paused_for_owner: 0 });
          this.db.audit("owner_resume_pending", "owner", `state=${rc.state}`);
          await ack("resume", "চিহ্নিত করা হয়েছে — তার পরের মেসেজে বট সচেতনভাবে আবার শুরু করবে।");
          return { action: "owner_command", detail: "resume_pending" };
        }
        // ACTIVE etc. — just clears a shopping-interest pause (nothing else to resume).
        this.db.updateConversation(rc.id, { resume_pending: 0, paused_for_owner: 0 });
        this.db.audit("owner_pause_flag_cleared", "owner", "");
        await ack("resume", "বট চালু আছে; বিরতি চিহ্ন মুছে গেছে।");
        return { action: "owner_command", detail: "resume_flag_cleared" };
      }
      case "/pause": {
        this.transition(rc, "PAUSED_BY_OWNER", "owner");
        await ack("pause", "proactive ও automated মেসেজ বন্ধ।");
        return { action: "owner_command", detail: "pause" };
      }
      case "/reinvite": {
        this.transition(rc, "AWAITING_CONSENT", "owner", { resume_pending: 0, paused_for_owner: 0 });
        await this.sendRecipient(
          rc,
          this.messages.disclosureOnboarding(),
          "disclosure",
          "consent invitation after owner reinvite",
        );
        await ack("reinvite", "নতুন consent অনুরোধ পাঠানো হয়েছে — তার START-ই আবার চালু করবে।");
        return { action: "owner_command", detail: "reinvite" };
      }
      case "/status": {
        const today = new Date().toISOString().slice(0, 10);
        const sent = this.db.proactiveCountForDate(rc.id, today);
        await this.sendOwnerRaw(
          `📊 status: state=${rc.state} paused_for_owner=${rc.paused_for_owner ? "yes" : "no"} ` +
            `resume_pending=${rc.resume_pending ? "yes" : "no"} proactive_today=${sent}/${this.cfg.dailyProactiveCap} ` +
            `unresolved_alerts=${this.db.unresolvedAlerts().length}`,
        );
        return { action: "owner_command", detail: "status" };
      }
      case "/help": {
        await this.sendOwnerRaw(this.messages.ownerHelp());
        return { action: "owner_command", detail: "help" };
      }
      default:
        // Free-form owner text — he may be thinking out loud; never forwarded anywhere.
        this.db.audit("owner_note_ignored", "owner", text.slice(0, 120));
        return { action: "owner_command", detail: "note_ignored" };
    }
  }

  // ------------------------------------------------------------------
  // Recipient pipeline
  // ------------------------------------------------------------------

  private async handleRecipient(
    conv: Conversation,
    stored: StoredMessage,
    input: { from: string; text: string; waMessageId: string; timestamp: Date },
  ): Promise<InboundOutcome> {
    const text = input.text;

    // 1. STOP/PAUSE/START commands work in every state, before anything else (FR-07).
    const cmd = detectCommand(text);
    if (cmd === "stop") return this.doStop(conv);
    if (cmd === "pause") return this.doPause(conv);
    if (cmd === "start") return this.doStart(conv);

    switch (conv.state) {
      case "AWAITING_CONSENT":
        return this.doConsentPrompt(conv);
      case "ACTIVE":
        return this.doActive(conv, stored, text);
      case "PAUSED_BY_RECIPIENT":
        return this.doPausedByRecipient(conv, text);
      case "PAUSED_BY_OWNER":
        // Owner paused automation but may be away — serious messages still interrupt (PRD §4.5).
        return this.doPausedByRecipient(conv, text, "paused_by_owner");
      case "OWNER_TAKEOVER":
      case "ESCALATED":
        return this.doSupervised(conv, text);
      case "STOPPED":
        // Criterion 3: STOP disables all future automated messages. Total silence to her;
        // the owner still gets to know she wrote.
        this.db.audit("post_stop_inbound", "recipient", text.slice(0, 120));
        await this.alerts.notifyMinorIfDue(
          `ℹ️ bou-bot: তুমি STOP করার পরেও তার একটা মেসেজ এসেছে (bot silent): "${text.slice(0, 80)}"`,
        );
        return { action: "stop_silent" };
    }
  }

  private async doStop(conv: Conversation): Promise<InboundOutcome> {
    if (conv.state === "STOPPED") return { action: "silent" }; // already fully off — stay silent
    this.transition(conv, "STOPPED", "recipient", { resume_pending: 0, paused_for_owner: 0 });
    await this.sendRecipient(conv, this.messages.stopConfirm(), "stop_confirm", "STOP");
    this.db.audit("recipient_stopped", "recipient", "");
    await this.alerts.raise({
      conversationId: conv.id,
      severity: "normal",
      reason: "recipient STOP",
      triggerMessage: "STOP",
      extra: "তিনি সব বন্ধ করেছেন। আবার চালু করতে চাইলে /reinvite — তার নতুন consent লাগবে।",
    });
    return { action: "stop_confirmed" };
  }

  private async doPause(conv: Conversation): Promise<InboundOutcome> {
    if (conv.state !== "ACTIVE") return { action: "silent" };
    this.transition(conv, "PAUSED_BY_RECIPIENT", "recipient");
    await this.sendRecipient(conv, this.messages.pauseConfirm(), "pause_confirm", "PAUSE");
    return { action: "paused" };
  }

  private async doStart(conv: Conversation): Promise<InboundOutcome> {
    if (conv.state === "AWAITING_CONSENT") {
      this.transition(conv, "ACTIVE", "recipient");
      await this.sendRecipient(conv, this.messages.consentConfirmed(), "consent_confirm", "opt-in START");
      this.db.audit("recipient_opted_in", "recipient", "");
      return { action: "consent_confirmed" };
    }
    if (conv.state === "PAUSED_BY_RECIPIENT") {
      this.transition(conv, "ACTIVE", "recipient");
      await this.sendRecipient(conv, this.messages.resumeConfirm(), "resume_confirm", "unpause START");
      return { action: "resume_completed" };
    }
    if (conv.state === "ACTIVE") return { action: "silent" };
    // STOPPED / PAUSED_BY_OWNER / OWNER_TAKEOVER / ESCALATED: only the owner can
    // authorize re-enable (PRD §8). Stay silent to her, let the owner know.
    this.db.audit("start_request_suppressed", "recipient", `state=${conv.state}`);
    if (conv.state === "STOPPED") {
      await this.alerts.notifyMinorIfDue(
        `ℹ️ bou-bot: সে START লিখেছে (সেবা বন্ধ অবস্থায়)। চালু করতে চাইলে /reinvite পাঠাও।`,
      );
    }
    return { action: "silent" };
  }

  private async doConsentPrompt(conv: Conversation): Promise<InboundOutcome> {
    const last = conv.last_disclosure_prompt_at ? Date.parse(conv.last_disclosure_prompt_at) : 0;
    const gapOk = Date.now() - last > DISCLOSURE_PROMPT_MIN_GAP_MS;
    if (!gapOk) {
      this.db.audit("consent_prompt_suppressed", "system", "rate limited");
      return { action: "silent" };
    }
    await this.sendRecipient(conv, this.messages.disclosureOnboarding(), "disclosure", "consent prompt");
    this.db.updateConversation(conv.id, { last_disclosure_prompt_at: new Date().toISOString() });
    this.db.audit("consent_prompted", "system", "");
    return { action: "consent_prompted" };
  }

  private async doActive(conv: Conversation, stored: StoredMessage, text: string): Promise<InboundOutcome> {
    if (conv.paused_for_owner) {
      // Waiting on the owner's decision for a shopping-interest pause.
      const { result } = await classifyMessage(this.llm, text, this.historyBefore(conv, stored));
      if (result.category === "emergency" || result.category === "serious") {
        return this.doEscalate(conv, text, result.category === "emergency");
      }
      this.db.audit("shopping_pause_followup_logged", "system", text.slice(0, 120));
      return { action: "silent", detail: "awaiting owner decision" };
    }

    const { result, fastPathOnly } = await classifyMessage(this.llm, text, this.historyBefore(conv, stored));

    switch (result.category) {
      case "emergency":
        return this.doEscalate(conv, text, true);
      case "serious":
      case "human_request":
        return this.doEscalate(conv, text, false);
      case "identity_question":
        await this.sendRecipient(conv, this.messages.identityAnswer(), "identity_answer", "identity question");
        this.db.audit("identity_answered", "system", "");
        return { action: "identity_answered" };
      case "shopping_interest":
        return this.doShoppingPause(conv, text);
      case "none":
        return this.doReply(conv, stored, text, fastPathOnly);
    }
  }

  private async doReply(
    conv: Conversation,
    stored: StoredMessage,
    text: string,
    classifierDown: boolean,
  ): Promise<InboundOutcome> {
    let reply: string;
    try {
      reply = await this.generateReply(conv, text);
    } catch (e) {
      if (e instanceof LlmRefusalError) {
        // The model declined the content — treat as needing a human.
        this.db.audit("llm_refusal", "system", e.category ?? "");
        return this.doEscalate(conv, text, false);
      }
      if (e instanceof LlmUnavailableError) {
        this.db.audit("llm_unavailable", "system", e.message);
        await this.sendRecipient(conv, this.messages.delayNote(), "delay_note", "llm unavailable");
        return { action: "delay_note_sent" };
      }
      throw e;
    }
    if (classifierDown) this.db.audit("reply_without_classifier", "system", text.slice(0, 80));
    await this.sendRecipient(conv, reply, "reply", "ai reply");
    return { action: "reply_sent" };
  }

  private async doShoppingPause(conv: Conversation, text: string): Promise<InboundOutcome> {
    // FR-08: pause automated replies, alert the owner, never redirect/dismiss/interfere.
    this.db.updateConversation(conv.id, { paused_for_owner: 1 });
    this.db.audit("shopping_interest_paused", "system", text.slice(0, 160));
    await this.alerts.raise({
      conversationId: conv.id,
      severity: "normal",
      reason: "shopping-interest",
      triggerMessage: text,
      extra:
        "বট উত্তর বন্ধ রেখেছে — বিষয়টা তুমি ঠিক করবে। /takeover দিয়ে নিজে উত্তর দাও, অথবা /resume দিয়ে বট চালু।",
    });
    return { action: "shopping_paused" };
  }

  private async doEscalate(conv: Conversation, text: string, emergency: boolean): Promise<InboundOutcome> {
    // PRD §4.5: stop autonomous conversation, urgent alert, transparent holding message.
    this.transition(conv, "ESCALATED", "system", { resume_pending: 0, paused_for_owner: 0 });
    const holding = this.messages.escalationHolding(emergency);
    await this.sendRecipient(conv, holding, "holding", emergency ? "emergency escalation" : "escalation");
    this.db.audit("escalated", "system", `${emergency ? "EMERGENCY " : ""}${text.slice(0, 160)}`);
    await this.alerts.raise({
      conversationId: conv.id,
      severity: "urgent",
      reason: emergency ? "EMERGENCY" : "serious conversation",
      triggerMessage: text,
      extra: "বট কথা বন্ধ করে দিয়েছে ও তাকে জানিয়েছে তুমি জানতে পারবে। /takeover দিয়ে নিজে সামলাও; শেষ হলে /resume।",
    });
    return { action: "escalated" };
  }

  private async doPausedByRecipient(conv: Conversation, text: string, label = "paused_by_recipient"): Promise<InboundOutcome> {
    const { result } = await classifyMessage(this.llm, text, []);
    if (result.category === "emergency" || result.category === "serious") {
      // She asked for a pause, but safety wins — interrupt to alert the owner.
      return this.doEscalate(conv, text, result.category === "emergency");
    }
    this.db.audit(`${label}_silent`, "system", text.slice(0, 80));
    return { action: "silent" };
  }

  private async doSupervised(conv: Conversation, text: string): Promise<InboundOutcome> {
    // OWNER_TAKEOVER / ESCALATED / PAUSED_BY_OWNER: the bot never speaks (criterion 9).
    if (conv.resume_pending) {
      // Two-phase resume: her next message re-activates the assistant.
      this.transition(conv, "ACTIVE", "owner", { resume_pending: 0 });
      await this.sendRecipient(conv, this.messages.resumeConfirm(), "resume_confirm", "two-phase resume complete");
      return { action: "resume_completed" };
    }
    const { result } = await classifyMessage(this.llm, text, []);
    if (result.category === "emergency") {
      // Never resume autonomously, but an emergency follow-up must reach the owner NOW.
      this.db.audit("emergency_followup_under_supervision", "system", text.slice(0, 160));
      await this.alerts.raise({
        conversationId: conv.id,
        severity: "urgent",
        reason: "EMERGENCY follow-up",
        triggerMessage: text,
        extra: `বট চুপ আছে (${conv.state}) — কিন্তু এটা জরুরি। দেখো এখনই।`,
      });
      return { action: "escalated", detail: "followup_alert_only" };
    }
    this.db.audit("supervised_silent", "system", `state=${conv.state} text=${text.slice(0, 80)}`);
    return { action: "silent" };
  }

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  private historyBefore(conv: Conversation, current: StoredMessage) {
    return this.db
      .recentMessages(conv.id, 21)
      .reverse()
      .filter((m) => m.id !== current.id)
      .slice(-20)
      .map((m) => ({ direction: m.direction, body: m.body, created_at: m.created_at }));
  }

  private async generateReply(conv: Conversation, incoming: string): Promise<string> {
    const history = this.db.recentMessages(conv.id, 20).reverse();
    return this.llm.reply({
      recipientName: this.cfg.recipientName,
      ownerName: this.cfg.ownerName,
      incoming,
      history: history.map((m) => ({ direction: m.direction, body: m.body, created_at: m.created_at })),
    });
  }

  private async sendRecipient(
    conv: Conversation,
    body: string,
    kind: string,
    why: string,
  ): Promise<void> {
    const result = await this.wa.sendText(conv.wa_id, body);
    if (!result.ok) {
      this.db.audit("send_failed", "system", JSON.stringify({ kind, why, error: result.error }));
      console.error(`🚨 send to recipient failed (${kind}): ${result.error}`);
      return;
    }
    this.db.insertMessage({
      conversation_id: conv.id,
      direction: "out",
      wa_message_id: result.waMessageId ?? null,
      body,
      kind,
    });
    this.db.updateConversation(conv.id, {
      last_outbound_at: new Date().toISOString(),
      last_outbound_kind: kind,
    });
    this.db.audit("message_sent", "system", JSON.stringify({ kind, why, to: conv.wa_id }));
  }

  private async sendOwnerRaw(body: string): Promise<void> {
    if (!this.cfg.ownerPhone) return;
    const result = await this.wa.sendText(this.cfg.ownerPhone, body);
    if (result.ok) {
      const oc = this.db.getOrCreateConversation(`owner:${this.cfg.ownerPhone}`);
      this.db.updateConversation(oc.id, { state: "ACTIVE" });
      this.db.insertMessage({
        conversation_id: oc.id,
        direction: "out",
        wa_message_id: result.waMessageId ?? null,
        body,
        kind: "owner_ack",
      });
    }
  }

  private transition(
    conv: Conversation,
    to: ConversationState,
    actor: Actor,
    extra: Partial<Conversation> = {},
  ): void {
    assertTransition(conv.state, actor, to);
    this.db.updateConversation(conv.id, { state: to, ...extra });
    this.db.audit("state_changed", actor, `${conv.state} → ${to}`);
  }
}
