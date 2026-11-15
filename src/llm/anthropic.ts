import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import {
  LlmUnavailableError,
  type ChatContext,
  type Classification,
  type ClassifyResult,
  type HistoryMessage,
  type LlmProvider,
} from "./provider.js";
import { buildSystemPrompt } from "../engine/prompts.js";

const VALID: Classification[] = [
  "none",
  "shopping_interest",
  "serious",
  "emergency",
  "human_request",
  "identity_question",
];

const CLASSIFIER_PROMPT = `You are a safety and intent classifier for a WhatsApp AI assistant chatting with a consenting recipient in Bangla/Banglish/English.

Classify the CURRENT message, using recent history only for context. Respond with ONLY a JSON object:
{"category": "...", "confidence": 0.0-1.0}

Categories:
- "emergency": immediate danger — self-harm threats, medical emergency, accident, violence, fear for safety. Threats of self-harm or harm to others ALWAYS belong here.
- "serious": relationship conflict, distress, fear, grief, or an explicit request for an important/serious discussion with the account owner.
- "human_request": recipient asks to talk to the real account owner, or asks whether the sender is human/AI/robot.
- "identity_question": recipient asks if the sender is an AI, bot, or real person.
- "shopping_interest": recipient expresses wanting to buy, get, or receive a specific thing — e.g. "এটা কিনতে ইচ্ছা করছে", "জামাটা খুব পছন্দ হয়েছে, নিতে চাই", or hints they'd like something as a gift. A passing compliment with NO desire to acquire ("সুন্দর ব্যাগ") is NOT shopping_interest.
- "none": ordinary warm conversation — greetings, wellbeing, food, weather, small talk.

Prefer "serious" or "emergency" over "none" when genuinely uncertain about emotional weight (safety-first policy). Set confidence honestly; below 0.55 means uncertain.`;

export class AnthropicLlm implements LlmProvider {
  readonly provider = "anthropic" as const;
  private client: Anthropic;
  private chatModel: string;
  private classifierModel: string;
  private effort: AppConfig["llmEffort"];
  private maxReplyTokens: number;
  private ownerName: string;

  constructor(cfg: AppConfig) {
    this.client = new Anthropic({
      apiKey: cfg.anthropicApiKey || undefined, // falls back to env/ant profile
      timeout: cfg.llmTimeoutMs, // milliseconds (TS SDK)
      maxRetries: 1,
    });
    this.chatModel = cfg.chatModel;
    this.classifierModel = cfg.classifierModel;
    this.effort = cfg.llmEffort;
    this.maxReplyTokens = cfg.llmMaxReplyTokens;
    this.ownerName = cfg.ownerName;
  }

  async reply(ctx: ChatContext): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
      ...ctx.history.map((m) => ({
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        content: m.body,
      })),
      { role: "user", content: ctx.incoming },
    ];

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.chatModel,
        max_tokens: this.maxReplyTokens, // deliberately short WhatsApp replies
        system: buildSystemPrompt({ recipientName: ctx.recipientName, ownerName: ctx.ownerName }),
        // Opus 5.5 default effort is medium; chat does well at low — configurable.
        output_config: { effort: this.effort },
        messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        throw new LlmUnavailableError(`${e.status ?? "?"}: ${e.message}`);
      }
      throw new LlmUnavailableError((e as Error).message);
    }
    if (response.stop_reason === "refusal") {
      // The model declined — treat as needing a human rather than dropping the message.
      throw new LlmRefusalError(response.stop_details?.category ?? null);
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new LlmUnavailableError("empty reply");
    return text;
  }

  async classify(currentMessage: string, recentHistory: HistoryMessage[]): Promise<ClassifyResult> {
    const historyText =
      recentHistory.length > 0
        ? recentHistory
            .slice(-5)
            .map((m) => `${m.direction === "in" ? "SHE" : "AI"}: ${m.body}`)
            .join("\n") + "\n"
        : "";
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.classifierModel,
        max_tokens: 256, // classification output is a tiny JSON object
        system: CLASSIFIER_PROMPT,
        messages: [
          { role: "user", content: `Recent history:\n${historyText}\nCURRENT message to classify:\n${currentMessage}` },
        ],
      });
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        throw new LlmUnavailableError(`classifier ${e.status ?? "?"}: ${e.message}`);
      }
      throw new LlmUnavailableError((e as Error).message);
    }
    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = extractJson(raw);
    if (!parsed) throw new LlmUnavailableError("classifier returned unparseable output");
    const category = parsed.category;
    if (typeof category !== "string" || !(VALID as string[]).includes(category)) {
      throw new LlmUnavailableError(`unknown category: ${String(category)}`);
    }
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    return { category: category as Classification, confidence: Math.min(1, Math.max(0, confidence)) };
  }
}

export class LlmRefusalError extends LlmUnavailableError {
  constructor(readonly category: string | null) {
    super(`model refusal${category ? ` (${category})` : ""}`);
    this.name = "LlmRefusalError";
  }
}

function extractJson(text: string): { category?: string; confidence?: number } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as { category?: string; confidence?: number };
  } catch {
    return null;
  }
}
