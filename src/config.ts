import "dotenv/config";

function str(key: string, def: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? def : v;
}
function int(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Config ${key} must be a number, got: ${v}`);
  return n;
}

export interface CheckinTemplate {
  /** Meta-approved template name, e.g. checkin_1 */
  name: string;
  /** The human-readable Bangla text of the template body (used in mock mode + audit) */
  text: string;
}

const CHECKIN_TEXTS: string[] = [
  "জান, কেমন আছো? আজকের দিনটা কেমন যাচ্ছে?",
  "খেয়েছো? নিজের খেয়াল রেখো।",
  "আজ তোমার দিনটা ভালো কাটুক ❤️",
  "একটু বিরতি নিয়েছো? সারাদিন কাজ করে ক্লান্ত লাগলে পানি খেয়ো।",
  "আজ কি মিষ্টি কিছু খেয়েছো? না খেলে একটু খেয়ো, মন ভালো হয়ে যাবে।",
];

function checkinTemplates(): CheckinTemplate[] {
  const names = str("CHECKIN_TEMPLATES", "checkin_1,checkin_2,checkin_3")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Pair each approved template name with a text variant (mock/simulator uses the text).
  return names.map((name, i) => ({
    name,
    text: CHECKIN_TEXTS[i % CHECKIN_TEXTS.length]!,
  }));
}

export interface AppConfig {
  port: number;
  adminToken: string;
  dbPath: string;

  waProvider: "mock" | "cloud";
  waPhoneNumberId: string;
  waAccessToken: string;
  waAppSecret: string;
  waVerifyToken: string;
  waGraphVersion: string;
  waBotNumber: string;

  ownerPhone: string;
  ownerName: string;
  ownerAlertTemplate: string;

  recipientPhone: string;
  recipientName: string;
  recipientTimezone: string;
  windowStart: string;
  windowEnd: string;
  dailyProactiveCap: number;
  minProactiveIntervalHours: number;
  activeConversationMins: number;
  staleInboundMins: number;

  llmProvider: "mock" | "anthropic";
  anthropicApiKey: string;
  chatModel: string;
  classifierModel: string;
  llmEffort: "low" | "medium" | "high" | "xhigh" | "max";
  llmTimeoutMs: number;
  llmMaxReplyTokens: number;

  checkinTemplates: CheckinTemplate[];
  checkinLang: string;
  signatureLine: string;
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const cfg: AppConfig = {
    port: int("PORT", 3210),
    adminToken: str("ADMIN_TOKEN", "dev-admin-token"),
    dbPath: str("DB_PATH", "./data/bou-bot.db"),

    waProvider: str("WA_PROVIDER", "mock") === "cloud" ? "cloud" : "mock",
    waPhoneNumberId: str("WA_PHONE_NUMBER_ID", ""),
    waAccessToken: str("WA_ACCESS_TOKEN", ""),
    waAppSecret: str("WA_APP_SECRET", ""),
    waVerifyToken: str("WA_VERIFY_TOKEN", "dev-verify-token"),
    waGraphVersion: str("WA_GRAPH_VERSION", "v23.0"),
    waBotNumber: str("WA_BOT_NUMBER", ""),

    ownerPhone: str("OWNER_PHONE", ""),
    ownerName: str("OWNER_NAME", "Janibul"),
    ownerAlertTemplate: str("OWNER_ALERT_TEMPLATE", "owner_alert"),

    recipientPhone: str("RECIPIENT_PHONE", ""),
    recipientName: str("RECIPIENT_NAME", "জান"),
    recipientTimezone: str("RECIPIENT_TIMEZONE", "Asia/Dhaka"),
    windowStart: str("MSG_WINDOW_START", "10:00"),
    windowEnd: str("MSG_WINDOW_END", "21:00"),
    dailyProactiveCap: int("DAILY_PROACTIVE_CAP", 3),
    minProactiveIntervalHours: int("MIN_PROACTIVE_INTERVAL_HOURS", 4),
    activeConversationMins: int("ACTIVE_CONVERSATION_MINS", 30),
    staleInboundMins: int("STALE_INBOUND_MINS", 15),

    llmProvider: str("LLM_PROVIDER", "mock") === "anthropic" ? "anthropic" : "mock",
    anthropicApiKey: str("ANTHROPIC_API_KEY", ""),
    chatModel: str("LLM_CHAT_MODEL", "claude-opus-5-5"),
    classifierModel: str("LLM_CLASSIFIER_MODEL", "claude-haiku-5-5"),
    llmEffort: str("LLM_EFFORT", "low") as AppConfig["llmEffort"],
    llmTimeoutMs: int("LLM_TIMEOUT_MS", 20000),
    llmMaxReplyTokens: int("LLM_MAX_REPLY_TOKENS", 1024),

    checkinTemplates: checkinTemplates(),
    checkinLang: str("CHECKIN_LANG", "bn"),
    signatureLine: str("SIGNATURE_LINE", "— আপনার AI assistant 🤖"),
  };
  // restore caller's environment (tests set overrides transiently)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return cfg;
}
