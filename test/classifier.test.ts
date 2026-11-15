import { describe, it, expect } from "vitest";
import { detectCommand, fastPathClassify, classifyMessage } from "../src/engine/classifier.js";
import { MockLlm } from "../src/llm/mock.js";

describe("opt-out/opt-in command detection (FR-01, FR-07)", () => {
  it("recognizes STOP in English and Bangla", () => {
    expect(detectCommand("STOP")).toBe("stop");
    expect(detectCommand("stop!")).toBe("stop");
    expect(detectCommand("বন্ধ করো")).toBe("stop");
    expect(detectCommand("বন্ধ")).toBe("stop");
    expect(detectCommand("থামো")).toBe("stop");
  });

  it("recognizes PAUSE and START variants", () => {
    expect(detectCommand("pause")).toBe("pause");
    expect(detectCommand("বিরতি")).toBe("pause");
    expect(detectCommand("START")).toBe("start");
    expect(detectCommand("শুরু")).toBe("start");
    expect(detectCommand("রাজি")).toBe("start");
  });

  it("does not misfire on ordinary messages", () => {
    expect(detectCommand("স্টপ করে বললাম কিন্তু দাম দেখে কিনলাম")).toBeNull();
    expect(detectCommand("আমি শুরু করেছিলাম নতুন চাকরি")).toBeNull();
    expect(detectCommand("কেমন আছো?")).toBeNull();
  });
});

describe("emergency fast-path", () => {
  it("escalates self-harm and medical emergencies instantly", () => {
    expect(fastPathClassify("আমি আর পারছি না, মরতে চাই")).toBe("emergency");
    expect(fastPathClassify("there was an accident, we need an ambulance")).toBe("emergency");
    expect(fastPathClassify("আমার খালার দুর্ঘটনা হয়েছে")).toBe("emergency");
  });

  it("flags identity questions", () => {
    expect(fastPathClassify("তুমি কি মানুষ?")).toBe("identity_question");
    expect(fastPathClassify("are you a bot?")).toBe("identity_question");
  });

  it("leaves ordinary chat to the LLM", () => {
    expect(fastPathClassify("আজ বৃষ্টি হচ্ছে খুব")).toBeNull();
    expect(fastPathClassify("খেয়েছো?")).toBeNull();
  });
});

describe("classifyMessage with LLM unavailable", () => {
  it("falls back to keywords and flags fastPathOnly", async () => {
    const broken = new MockLlm();
    broken.classify = async () => {
      throw new Error("api down");
    };
    const r = await classifyMessage(broken, "আমি মারা যাব", []);
    expect(r.result.category).toBe("emergency");
    expect(r.fastPathOnly).toBe(true);
    const plain = await classifyMessage(broken, "সব ভালো তাই?", []);
    expect(plain.result.category).toBe("none");
    expect(plain.fastPathOnly).toBe(true);
  });
});
