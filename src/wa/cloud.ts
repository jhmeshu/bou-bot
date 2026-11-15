import type { AppConfig } from "../config.js";
import { WaApiError, type SendResult, type WaClient } from "./types.js";

interface GraphErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
  };
}

/**
 * Official WhatsApp Cloud API client (FR-03: approved platform, no session scraping).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
export class CloudWaClient implements WaClient {
  readonly provider = "cloud" as const;

  constructor(private cfg: AppConfig) {
    if (!cfg.waPhoneNumberId || !cfg.waAccessToken) {
      throw new Error("CloudWaClient requires WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN");
    }
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    return this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    });
  }

  async sendTemplate(
    to: string,
    templateName: string,
    lang: string,
    bodyParams: string[],
  ): Promise<SendResult> {
    return this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: lang },
        ...(bodyParams.length > 0
          ? {
              components: [
                {
                  type: "body",
                  parameters: bodyParams.map((text) => ({ type: "text", text })),
                },
              ],
            }
          : {}),
      },
    });
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    const url = `https://graph.facebook.com/${this.cfg.waGraphVersion}/${this.cfg.waPhoneNumberId}/messages`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.waAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return { ok: false, error: `network: ${(e as Error).message}` };
    }
    const text = await res.text();
    if (!res.ok) {
      let code: number | null = null;
      let message = text;
      try {
        const body = JSON.parse(text) as GraphErrorBody;
        code = body.error?.code ?? null;
        message = body.error?.message ?? text;
      } catch {
        /* keep raw text */
      }
      return {
        ok: false,
        error: message,
        ...(code !== null ? { errorCode: code } : {}),
        ...(code === 131047 ? { needsTemplate: true } : {}),
      };
    }
    try {
      const body = JSON.parse(text) as {
        messages?: Array<{ id?: string }>;
      };
      return { ok: true, waMessageId: body.messages?.[0]?.id };
    } catch {
      return { ok: true };
    }
  }
}
