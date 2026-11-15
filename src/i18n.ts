import type { AppConfig } from "./config.js";

/**
 * All user-visible message templates. Bangla-first with English code-switching (FR-12).
 * AI identity disclosure is mandatory in onboarding and present wherever appropriate (FR-02, PRD §9).
 */
export class Messages {
  constructor(private cfg: AppConfig) {}

  /** First contact / consent invitation. Must clearly identify the assistant as AI (FR-01, FR-02). */
  disclosureOnboarding(): string {
    return (
      `আসসালামু আলাইকুম ${this.cfg.recipientName}! 🌸\n\n` +
      `আমি ${this.cfg.ownerName}-এর **AI assistant** (${process.env.npm_package_name ?? "bou-bot"})। ` +
      `আমি মানুষ না — আমি একটা AI প্রোগ্রাম, যেটা ${this.cfg.ownerName}-এর অনুমতিতে মাঝে মাঝে তোমার খোঁজখবর রাখতে পারে আর তোমার মেসেজের উত্তর দিতে পারে।\n\n` +
      `যদি তুমি রাজি থাকো, "START" লিখে রিপ্লাই দাও — তারপরই আমি মেসেজ দিতে পারব।\n` +
      `যেকোনো সময় "STOP" লিখলে সব বন্ধ হয়ে যাবে, আর "PAUSE" লিখলে সাময়িক বিরতি হবে।\n\n` +
      `তোমার সম্মতি ছাড়া আমি কোনো মেসেজ পাঠাব না। ❤️`
    );
  }

  consentConfirmed(): string {
    return (
      `আপনার সম্মতি পেয়েছি, ধন্যবাদ ${this.cfg.recipientName}! ❤️\n` +
      `এখন থেকে আমি — ${this.cfg.ownerName}-এর AI assistant — মাঝে মাঝে তোমার খোঁজ রাখব, ` +
      `আর তুমি মেসেজ লিখলে উত্তর দেব। মনে রেখো: আমি AI, ${this.cfg.ownerName} না।\n` +
      `"STOP" বললে সব বন্ধ, "PAUSE" বললে বিরতি — যেকোনো সময়।`
    );
  }

  /** Re-prompt when recipient messages while consent is still pending (rate-limited by caller). */
  disclosureReminder(): string {
    return (
      `একটু মনে করিয়ে দিচ্ছি 😊 আমি ${this.cfg.ownerName}-এর AI assistant — সম্মতি ছাড়া কথা শুরু করতে পারি না। ` +
      `রাজি থাকলে "START" লিখো, আর না চাইলে কিছু করতে হবে না — আমি আর গিয়েগি।`
    );
  }

  pauseConfirm(): string {
    return `ঠিক আছে, বিরতি নিচ্ছি। 😊 আবার শুরু করতে চাইলে "START" লিখো — তার আগে আমি কোনো মেসেজ দেব না।`;
  }

  stopConfirm(): string {
    return (
      `বুঝেছি। এখনই সব বন্ধ করছি — আর কোনো মেসেজ পাঠাব না। যদি কখনো ${this.cfg.ownerName}-এর AI assistant-এর সেবা আবার চাও, ` +
      `সে তোমাকে নতুন করে অনুমতি চাইবে। যত্নে থেকো ❤️`
    );
  }

  resumeConfirm(): string {
    return `আবার চালু হয়ে গেছি! 😊 মনে করিয়ে দিচ্ছি — আমি AI assistant, ${this.cfg.ownerName} না। কেমন আছো?`;
  }

  /**
   * Transparent holding message sent to the recipient on escalation (PRD §4.5.3).
   * `emergency` adds encouragement to contact local emergency services / a trusted
   * person, without implying the alert guarantees help.
   */
  escalationHolding(emergency: boolean): string {
    const base =
      `এটা গুরুত্বপূর্ণ বিষয়। আমি AI assistant—এখানে তোমার সঙ্গে মানুষের মতো সিদ্ধান্ত নেওয়া ঠিক হবে না। ` +
      `আমি এখনই ${this.cfg.ownerName}-কে জানাচ্ছি।`;
    if (emergency) {
      return (
        base +
        `\n\nযদি এখনই বিপদ বা জরুরি সাহায্যের প্রয়োজন হয়, অনুগ্রহ করে সরাসরি জরুরি সেবা (পুলিশ/অ্যাম্বুলেন্স) বা ` +
        `আশেপাশের কোনো বিশ্বস্ত মানুষের সঙ্গে যোগাযোগ করো — আমার জানানো নিশ্চিত করে না যে সাহায্য আসবে।`
      );
    }
    return base;
  }

  identityAnswer(): string {
    return (
      `সত্যি কথা বলি 😊 আমি ${this.cfg.ownerName}-এর AI assistant — মানুষ না। ` +
      `${this.cfg.ownerName} ব্যস্ত থাকলে আমি তাঁর অনুমতিতে তোমার সঙ্গে কথা বলি, ` +
      `আর গুরুত্বপূর্ণ কিছু হলে সরাসরি তাঁকে জানিয়ে দিই।`
    );
  }

  /** LLM/provider failed — transparent delay note (NFR latency). */
  delayNote(): string {
    return `উত্তর দিতে একটু সময় লাগছে — একটা ছোটখাটো টেকনিক্যাল সমস্যা। একটু পরে আবার লিখলে ভালো হয়।`;
  }

  ownerAlert(reason: string, trigger: string, extra: string): string {
    return (
      `🔔 bou-bot ALERT (${reason})\n\n` +
      `সময়: ${new Date().toLocaleString("en-GB", { timeZone: this.cfg.recipientTimezone })}\n` +
      `মেসেজ: "${trigger}"\n` +
      (extra ? `\n${extra}\n` : "") +
      `\nAI উত্তর বন্ধ আছে। নিজে উত্তর দিতে চাইলে এখানে লিখো, ` +
      `তারপর /takeover পাঠিয়ো (বট পুরো চুপ হয়ে যাবে)। আবার চালু করতে /resume। স্ট্যাটাস দেখতে /status।`
    );
  }

  ownerAck(cmd: string, effect: string): string {
    return `✅ /${cmd} — ${effect}`;
  }

  ownerHelp(): string {
    return (
      `bou-bot owner commands:\n` +
      `/status — বর্তমান অবস্থা\n` +
      `/takeover — বট সম্পূর্ণ চুপ (তুমি নিজে উত্তর দাও)\n` +
      `/resume — বট আবার চালু (তার পরের তার মেসেজে সে সচেতন হবে)\n` +
      `/pause — proactive মেসেজ বন্ধ\n` +
      `/reinvite — নতুন করে consent চাওয়া (STOP-এর পরে)\n` +
      `/help — এই লিস্ট`
    );
  }

  /** Proactive check-in text (mock mode / audit trail). Signature line keeps AI identity visible (FR-02). */
  checkinText(text: string): string {
    return `${text}\n${this.cfg.signatureLine}`;
  }
}
