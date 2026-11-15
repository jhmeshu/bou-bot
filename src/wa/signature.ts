import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta webhook signature: x-hub-signature-256: "sha256=" + HMAC-SHA256(appSecret, rawBody).
 * Must be validated on every inbound webhook POST (FR-03, NFR security).
 */
export function verifySignature(
  rawBody: Buffer | string,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith("sha256=") || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = header.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
