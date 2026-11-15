import express from "express";
import type { Request, Response } from "express";
import type { Stack } from "./bootstrap.js";
import { verifySignature } from "./wa/signature.js";
import { controlPanelHtml } from "./web/control-panel.js";

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
      field?: string;
    }>;
  }>;
}

export function createServer(stack: Stack): express.Express {
  const { cfg, db, orchestrator, scheduler } = stack;
  const app = express();

  // Keep the raw body for HMAC signature verification, then parse JSON.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, wa: stack.wa.provider, llm: stack.llm.provider });
  });

  // --- Meta webhook ---

  app.get("/webhook", (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === cfg.waVerifyToken) {
      res.status(200).send(String(challenge ?? ""));
    } else {
      res.sendStatus(403);
    }
  });

  app.post("/webhook", (req: Request, res: Response) => {
    // Signature validation happens BEFORE any parsing/trust (NFR security).
    const raw = (req as Request & { rawBody: Buffer }).rawBody;
    if (cfg.waProvider === "cloud") {
      const sig = req.header("x-hub-signature-256");
      if (!verifySignature(raw ?? "", sig, cfg.waAppSecret)) {
        db.audit("webhook_signature_rejected", "system", "");
        res.sendStatus(401);
        return;
      }
    }
    res.sendStatus(200); // ack fast; process async so Meta never times out on us
    const body = req.body as MetaWebhookBody;
    void processWebhook(body).catch((e) => {
      console.error("webhook processing error:", e);
      db.audit("webhook_processing_error", "system", String(e));
    });
  });

  async function processWebhook(body: MetaWebhookBody): Promise<void> {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          if (!msg.from || !msg.id) continue;
          if (msg.type !== "text" || !msg.text?.body) {
            db.audit("non_text_message_ignored", "system", `type=${msg.type ?? "?"}`);
            continue;
          }
          const ts = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();
          await orchestrator.handleInbound({
            from: msg.from,
            text: msg.text.body,
            waMessageId: msg.id,
            timestamp: ts,
          });
        }
      }
    }
  }

  // --- admin auth ---

  const requireAdmin = (req: Request, res: Response, next: () => void) => {
    if (req.header("x-admin-token") !== cfg.adminToken) {
      res.sendStatus(401);
      return;
    }
    next();
  };

  app.get("/admin", (_req: Request, res: Response) => {
    res.type("html").send(controlPanelHtml());
  });

  app.get("/admin/api/status", requireAdmin, (_req: Request, res: Response) => {
    const conv = cfg.recipientPhone ? db.getConversationByWaId(cfg.recipientPhone) : undefined;
    const today = new Date().toISOString().slice(0, 10);
    res.json({
      recipient_state: conv?.state ?? "not_configured",
      paused_for_owner: conv?.paused_for_owner === 1,
      resume_pending: conv?.resume_pending === 1,
      proactive_today: conv ? db.proactiveCountForDate(conv.id, today) : 0,
      daily_cap: cfg.dailyProactiveCap,
      window: `${cfg.windowStart}–${cfg.windowEnd} (${cfg.recipientTimezone})`,
      unresolved_alerts: db.unresolvedAlerts().length,
      provider: { wa: stack.wa.provider, llm: stack.llm.provider },
    });
  });

  app.get("/admin/api/alerts", requireAdmin, (_req: Request, res: Response) => {
    res.json({ alerts: db.allAlerts(100) });
  });

  app.post("/admin/api/alerts/:id/resolve", requireAdmin, (req: Request, res: Response) => {
    db.resolveAlert(Number(req.params.id));
    db.audit("alert_resolved", "owner", String(req.params.id));
    res.json({ ok: true });
  });

  app.get("/admin/api/audit", requireAdmin, (_req: Request, res: Response) => {
    res.json({ audit: db.recentAudit(200) });
  });

  // Dashboard buttons run the same owner-command pipeline as WhatsApp /commands.
  app.post("/admin/api/command", requireAdmin, (req: Request, res: Response) => {
    const cmd = String((req.body as { cmd?: string }).cmd ?? "");
    if (!["pause", "takeover", "resume", "reinvite"].includes(cmd)) {
      res.status(400).json({ error: "unknown command" });
      return;
    }
    const from = cfg.ownerPhone || "admin-local";
    void orchestrator
      .handleInbound({
        from,
        text: `/${cmd}`,
        waMessageId: `admin-${Date.now()}`,
        timestamp: new Date(),
      })
      .then(() => res.json({ ok: true }));
  });

  // --- simulator (mock WhatsApp mode only) ---

  if (cfg.waProvider === "mock") {
    app.post("/sim/inbound", (req: Request, res: Response) => {
      const { from, text } = (req.body ?? {}) as { from?: string; text?: string };
      void orchestrator
        .handleInbound({
          from: from || cfg.recipientPhone || "880000000000",
          text: String(text ?? ""),
          waMessageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          timestamp: new Date(),
        })
        .then((outcome) => res.json(outcome));
    });

    app.get("/sim/outbox", (_req: Request, res: Response) => {
      const conv = db.getConversationByWaId(`sim_outbox:${cfg.recipientPhone || "880000000000"}`);
      const owner = cfg.ownerPhone ? db.getConversationByWaId(`sim_outbox:${cfg.ownerPhone}`) : undefined;
      const msgs = [
        ...(conv ? db.recentMessages(conv.id, 50).reverse() : []),
        ...(owner ? db.recentMessages(owner.id, 50).reverse() : []),
      ];
      res.json({ outbox: msgs });
    });

    app.get("/sim/conversation", (_req: Request, res: Response) => {
      const conv = cfg.recipientPhone ? db.getConversationByWaId(cfg.recipientPhone) : undefined;
      res.json(
        conv ?? {
          state: "AWAITING_CONSENT",
          note: "no conversation yet — POST /sim/inbound to start",
        },
      );
    });

    app.post("/sim/tick", async (_req: Request, res: Response) => {
      const r = await scheduler.tick();
      res.json(r);
    });

    app.post("/sim/reset", (_req: Request, res: Response) => {
      db.sqlite.exec("DELETE FROM messages; DELETE FROM alerts; DELETE FROM audit; DELETE FROM scheduler_log; DELETE FROM conversations;");
      res.json({ ok: true });
    });
  }

  return app;
}
