import { describe, it, expect } from "vitest";
import { verifySignature } from "../src/wa/signature.js";
import { createHmac } from "node:crypto";

const SECRET = "test-app-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("webhook signature validation", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account" });

  it("accepts a valid Meta signature", () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("rejects a wrong secret, missing header, and malformed header", () => {
    expect(verifySignature(body, sign(body), "other-secret")).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, "plain-text", SECRET)).toBe(false);
    expect(verifySignature(body, "sha256=", SECRET)).toBe(false);
  });
});
