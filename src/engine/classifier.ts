import type { Classification, ClassifyResult, HistoryMessage, LlmProvider } from "../llm/provider.js";

/**
 * Intent/safety classification (PRD §7.5).
 * Layer 1: deterministic keyword fast-path — catches explicit opt-out commands and
 *          unmistakable emergency terms instantly, even if the LLM is down.
 * Layer 2: LLM classifier for everything nuanced (shopping interest, serious topics).
 *
 * Safety NFR: when uncertain whether a conversation is serious, prefer escalation.
 */

const OPT_OUT_STOP = [
  "stop", "বন্ধ করো", "বন্ধ", "থামো", "বন্ধ কর", "অপশন অফ",
];
const OPT_OUT_PAUSE = ["pause", "বিরতি", "থামেন", "একটু থামো"];
const OPT_IN = ["start", "শুরু", "রাজি", "হ্যাঁ, রাজি", "ঠিক আছে, চালাও"];

const EMERGENCY_TERMS = [
  "আত্মহত্যা", "মরতে চাই", "মরতে ইচ্ছা", "মরে যাব", "মারা যাব", "মারা যাচ্ছি",
  "মরে যেতে", "বাঁচতে চাই না", "বাঁচতে ইচ্ছা করছে না", "আর বাঁচতে", "শেষ করে দিতে", "আত্মহত্যার",
  "bleeding", "রক্ত পড়ছে", "খুন", "আগুন লেগেছে", "দুর্ঘটনা হয়েছে", "অ্যাম্বুলেন্স", "হাসপাতালে ভর্তি",
  "suicide", "kill myself", "end my life", "want to die", "ambulance", "emergency দরকার",
  "খুব বেশি রক্ত", "হাসপাতালে নেওয়া",
];

const HUMAN_REQUEST_TERMS = [
  "তোমার মানুষ বলো", "মানুষের সাথে কথা", "সত্যিকারের মানুষ", "আসল মানুষ",
  "talk to", "give me", "put me", "let me talk",
];

const IDENTITY_TERMS = [
  "তুমি কি মানুষ", "তুমি মানুষ নাকি", "তুমি কে দারো", "তুমি কে?", "তুমি bot", "তুমি কি bot",
  "are you a bot", "are you human", "are you ai", "you are ai", "তুমি ai", "তুমি কি ai",
];

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

/** Deterministic fast-path. Returns a decision or null to defer to the LLM classifier. */
export function fastPathClassify(raw: string): Classification | null {
  const t = normalize(raw);
  if (EMERGENCY_TERMS.some((k) => t.includes(k))) return "emergency";
  if (IDENTITY_TERMS.some((k) => t.includes(k))) return "identity_question";
  if (HUMAN_REQUEST_TERMS.some((k) => t.includes(k)) && (t.includes("বাবু") || t.includes("জান") || t.includes("you") || t.includes("মানুষ"))) {
    return "human_request";
  }
  return null; // shopping/serious/none need the LLM
}

/** Deterministic opt-out/opt-in command detection (FR-01/FR-07) — checked BEFORE anything else. */
export function detectCommand(raw: string): "stop" | "pause" | "start" | null {
  const t = normalize(raw);
  // strip punctuation/zwnj so "stop!" and "বন্ধ করো!" match
  const clean = t.replace(/[.,!?:;""''​]/g, "").trim();
  if (OPT_OUT_STOP.includes(clean) || clean === "stop it" || clean === "please stop") return "stop";
  if (OPT_OUT_PAUSE.includes(clean)) return "pause";
  if (OPT_IN.includes(clean) || clean === "start") return "start";
  // exact short forms
  if (["stop", "pause", "start"].includes(clean)) return clean as "stop" | "pause" | "start";
  return null;
}

export interface ClassifyOutcome {
  result: ClassifyResult;
  /** true when the LLM classifier was unavailable and keywords carried the decision */
  fastPathOnly: boolean;
}

export async function classifyMessage(
  llm: LlmProvider,
  text: string,
  history: HistoryMessage[],
): Promise<ClassifyOutcome> {
  const fast = fastPathClassify(text);
  if (fast && (fast === "emergency" || fast === "identity_question")) {
    return { result: { category: fast, confidence: 0.95 }, fastPathOnly: true };
  }
  try {
    const llmResult = await llm.classify(text, history);
    // an LLM-detected emergency always wins; otherwise the deterministic fast-path wins
    if (llmResult.category === "emergency") return { result: llmResult, fastPathOnly: false };
    if (fast === "human_request") {
      return { result: { category: fast, confidence: Math.max(0.9, llmResult.confidence) }, fastPathOnly: false };
    }
    return { result: llmResult, fastPathOnly: false };
  } catch {
    // Classifier unavailable: keyword-only. Safety NFR — uncertain means no autonomous
    // reply for signals the keywords flag; plain messages proceed but flagged.
    if (fast === "human_request") return { result: { category: fast, confidence: 0.9 }, fastPathOnly: true };
    return { result: { category: "none", confidence: 0.4 }, fastPathOnly: true };
  }
}
