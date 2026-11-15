import type { Classification, ClassifyResult, ChatContext, LlmProvider } from "./provider.js";
import { fastPathClassify } from "../engine/classifier.js";

/**
 * Deterministic mock LLM for tests + simulator. Classification routes through the
 * same keyword fast-path as production; replies are fixed warm Bangla strings so
 * assertions are stable.
 */
export class MockLlm implements LlmProvider {
  readonly provider = "mock" as const;
  replyCalls: ChatContext[] = [];

  async reply(ctx: ChatContext): Promise<string> {
    this.replyCalls.push(ctx);
    return `একদম ভালো লাগছে শুনে! 😊 (mock reply to: "${ctx.incoming.slice(0, 40)}")`;
  }

  async classify(currentMessage: string): Promise<ClassifyResult> {
    // Shopping-interest is an LLM-classifier judgement in production; the mock
    // mirrors it with keywords so the simulator demonstrates the pause flow.
    if (/কিনতে|নিতে চাই|উপহার|buy|purchase/i.test(currentMessage)) {
      return { category: "shopping_interest", confidence: 0.85 };
    }
    const fast = fastPathClassify(currentMessage);
    if (fast) return { category: fast, confidence: 0.9 };
    return { category: "none" satisfies Classification, confidence: 0.7 };
  }
}
