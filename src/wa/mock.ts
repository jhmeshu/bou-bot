import type { Db } from "../db.js";
import type { SendResult, WaClient } from "./types.js";

/**
 * Mock WhatsApp client for local simulation + tests. Every outbound lands in
 * the `messages` table as kind='sim_outbox' on a synthetic conversation and is
 * echoed to stdout — the simulator/control-panel reads it from there.
 */
export class MockWaClient implements WaClient {
  readonly provider = "mock" as const;
  private seq = 0;

  constructor(private db: Db) {}

  async sendText(to: string, body: string): Promise<SendResult> {
    return this.record(to, body);
  }

  async sendTemplate(to: string, templateName: string, _lang: string, bodyParams: string[]): Promise<SendResult> {
    return this.record(to, `[template:${templateName}] ${bodyParams.join(" ")}`);
  }

  private record(to: string, body: string): SendResult {
    const id = `sim-${Date.now()}-${++this.seq}`;
    let conv = this.db.getConversationByWaId(`sim_outbox:${to}`);
    if (!conv) {
      conv = this.db.getOrCreateConversation(`sim_outbox:${to}`);
      this.db.updateConversation(conv.id, { state: "ACTIVE" });
    }
    // Transport echo only — wa_message_id stays NULL so it can never collide with
    // the caller's own persisted row for the same logical message (UNIQUE index).
    this.db.insertMessage({
      conversation_id: conv.id,
      direction: "out",
      wa_message_id: null,
      body,
      kind: "sim_outbox",
    });
    console.log(`\n📱 [sim] → ${to} (id ${id}):\n${body}\n`);
    return { ok: true, waMessageId: id };
  }
}
