import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ConversationState } from "./state.js";

export interface Conversation {
  id: number;
  wa_id: string;
  state: ConversationState;
  /** owner /resume issued; recipient's next non-STOP message re-activates */
  resume_pending: number;
  /** shopping-interest pause: bot silent until owner decides */
  paused_for_owner: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  /** kind of the most recent outbound (checkin|reply|...) — scheduler decisions need it */
  last_outbound_kind: string | null;
  last_proactive_at: string | null;
  last_disclosure_prompt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: number;
  conversation_id: number;
  direction: "in" | "out";
  wa_message_id: string | null;
  body: string;
  kind: string; // inbound | reply | checkin | disclosure | holding | stop_confirm | owner_alert | owner_ack | delay_note
  tz_date: string | null; // recipient-local date for proactive cap counting
  created_at: string;
}

export interface AlertRow {
  id: number;
  conversation_id: number;
  severity: "urgent" | "normal";
  reason: string;
  trigger_message: string;
  created_at: string;
  resolved_at: string | null;
}

export interface AuditRow {
  id: number;
  event: string;
  actor: string;
  detail: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'AWAITING_CONSENT',
  resume_pending INTEGER NOT NULL DEFAULT 0,
  paused_for_owner INTEGER NOT NULL DEFAULT 0,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  last_outbound_kind TEXT,
  last_proactive_at TEXT,
  last_disclosure_prompt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  wa_message_id TEXT UNIQUE,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  tz_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  severity TEXT NOT NULL CHECK (severity IN ('urgent','normal')),
  reason TEXT NOT NULL,
  trigger_message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduler_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

export class Db {
  readonly sqlite: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.sqlite.exec(SCHEMA);
  }

  // --- conversations ---

  getOrCreateConversation(waId: string, now = new Date().toISOString()): Conversation {
    const existing = this.sqlite
      .prepare("SELECT * FROM conversations WHERE wa_id = ?")
      .get(waId) as unknown as Conversation | undefined;
    if (existing) return existing;
    this.sqlite
      .prepare(
        "INSERT INTO conversations (wa_id, state, created_at, updated_at) VALUES (?, 'AWAITING_CONSENT', ?, ?)",
      )
      .run(waId, now, now);
    return this.sqlite
      .prepare("SELECT * FROM conversations WHERE wa_id = ?")
      .get(waId) as unknown as Conversation;
  }

  getConversationByWaId(waId: string): Conversation | undefined {
    return this.sqlite.prepare("SELECT * FROM conversations WHERE wa_id = ?").get(waId) as
      | Conversation
      | undefined;
  }

  updateConversation(id: number, fields: Partial<Conversation>, now = new Date().toISOString()): void {
    const keys = Object.keys(fields).filter((k) => k !== "id");
    if (keys.length === 0) return;
    const setSql = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => fields[k as keyof Conversation] as string | number | null);
    this.sqlite
      .prepare(`UPDATE conversations SET ${setSql}, updated_at = ? WHERE id = ?`)
      .run(...values, now, id);
  }

  // --- messages ---

  /**
   * Persist a message. Returns null if a message with the same wa_message_id
   * already exists (webhook redelivery dedup — acceptance criterion 8).
   */
  insertMessage(
    m: Omit<StoredMessage, "id" | "created_at" | "tz_date"> & {
      created_at?: string;
      tz_date?: string | null;
    },
  ): StoredMessage | null {
    const created = m.created_at ?? new Date().toISOString();
    try {
      const res = this.sqlite
        .prepare(
          `INSERT INTO messages (conversation_id, direction, wa_message_id, body, kind, tz_date, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.conversation_id, m.direction, m.wa_message_id ?? null, m.body, m.kind, m.tz_date ?? null, created);
      return {
        id: Number(res.lastInsertRowid),
        conversation_id: m.conversation_id,
        direction: m.direction,
        wa_message_id: m.wa_message_id ?? null,
        body: m.body,
        kind: m.kind,
        tz_date: m.tz_date ?? null,
        created_at: created,
      };
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) return null; // duplicate delivery
      throw e;
    }
  }

  recentMessages(conversationId: number, limit = 20): StoredMessage[] {
    return this.sqlite
      .prepare(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(conversationId, limit) as unknown as StoredMessage[];
  }

  proactiveCountForDate(conversationId: number, tzDate: string): number {
    const row = this.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND kind = 'checkin' AND tz_date = ?",
      )
      .get(conversationId, tzDate) as { n: number };
    return row.n;
  }

  // --- alerts ---

  insertAlert(a: {
    conversation_id: number;
    severity: "urgent" | "normal";
    reason: string;
    trigger_message: string;
  }): AlertRow {
    const now = new Date().toISOString();
    const res = this.sqlite
      .prepare(
        "INSERT INTO alerts (conversation_id, severity, reason, trigger_message, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(a.conversation_id, a.severity, a.reason, a.trigger_message, now);
    return {
      id: Number(res.lastInsertRowid),
      conversation_id: a.conversation_id,
      severity: a.severity,
      reason: a.reason,
      trigger_message: a.trigger_message,
      created_at: now,
      resolved_at: null,
    };
  }

  resolveAlert(id: number): void {
    this.sqlite
      .prepare("UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL")
      .run(new Date().toISOString(), id);
  }

  unresolvedAlerts(): AlertRow[] {
    return this.sqlite
      .prepare("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC")
      .all() as unknown as AlertRow[];
  }

  allAlerts(limit = 50): AlertRow[] {
    return this.sqlite
      .prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as AlertRow[];
  }

  // --- audit ---

  audit(event: string, actor: string, detail = ""): void {
    this.sqlite
      .prepare("INSERT INTO audit (event, actor, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(event, actor, detail, new Date().toISOString());
  }

  recentAudit(limit = 100): AuditRow[] {
    return this.sqlite
      .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as AuditRow[];
  }

  // --- scheduler idempotency ---

  claimSchedulerSlot(dedupKey: string, detail = ""): boolean {
    try {
      this.sqlite
        .prepare("INSERT INTO scheduler_log (dedup_key, detail, created_at) VALUES (?, ?, ?)")
        .run(dedupKey, detail, new Date().toISOString());
      return true;
    } catch {
      return false; // slot already claimed — duplicate tick protection (FR-13)
    }
  }
}
