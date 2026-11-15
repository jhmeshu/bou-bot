import type { StoredMessage } from "../db.js";

/** A stored message with direction in/out — used for bounded history (FR-06). */
export type HistoryMessage = Pick<StoredMessage, "direction" | "body" | "created_at">;

export type Classification =
  | "none"
  | "shopping_interest"
  | "serious"
  | "emergency"
  | "human_request"
  | "identity_question";

export interface ClassifyResult {
  category: Classification;
  confidence: number; // 0..1
}

export interface ChatContext {
  recipientName: string;
  ownerName: string;
  incoming: string;
  history: HistoryMessage[];
}

/**
 * The LLM layer (PRD §7.4/7.5). `reply` generates warm conversation replies under
 * a constrained system prompt; `classify` detects intent/safety signals.
 */
export interface LlmProvider {
  readonly provider: "mock" | "anthropic";
  reply(ctx: ChatContext): Promise<string>;
  classify(currentMessage: string, recentHistory: HistoryMessage[]): Promise<ClassifyResult>;
}

export class LlmUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "LlmUnavailableError";
  }
}
