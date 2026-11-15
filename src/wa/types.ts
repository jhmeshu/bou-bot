/** WhatsApp integration layer — Cloud API (approved provider, FR-03) + mock for local simulation. */

export interface SendResult {
  ok: boolean;
  waMessageId?: string;
  /** true when Meta rejected because the 24h free-form window is closed (needs template) */
  needsTemplate?: boolean;
  error?: string;
  /** Meta error code, when present (e.g. 131047 = re-engagement required) */
  errorCode?: number;
}

export interface WaClient {
  readonly provider: "mock" | "cloud";
  /** Free-form text message (allowed within 24h of the counterpart's last message). */
  sendText(to: string, body: string): Promise<SendResult>;
  /** Pre-approved template message (required for business-initiated contact outside the window). */
  sendTemplate(
    to: string,
    templateName: string,
    lang: string,
    bodyParams: string[],
  ): Promise<SendResult>;
}

export interface InboundText {
  from: string; // wa id (phone digits)
  text: string;
  waMessageId: string;
  timestamp: Date;
}

export class WaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: number | null,
  ) {
    super(message);
    this.name = "WaApiError";
  }
}

/** Meta error 131047: re-engagement required — free-form window closed. */
export function isReEngagementError(e: unknown): boolean {
  return e instanceof WaApiError && e.errorCode === 131047;
}
