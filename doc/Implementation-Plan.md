# Implementation Plan: bou-bot (Consent-Based WhatsApp AI Companion)

Status: **v0.3 — Phases 1–6 built & tested (49 tests passing); Phase 0 awaits owner actions**
Date: 16 November 2026 (overnight build; see doc/HANDOFF-2026-11-16.md)
Source: `doc/PRD: Consent-Based WhatsApp AI Companion` (v0.1, 10 Nov 2026)

---

## 1. Product summary

A WhatsApp AI assistant that sends occasional affectionate check-ins (Bangla/English) to one
consenting recipient, replies warmly to inbound messages, and **always prioritizes honesty
(clear AI identity), recipient consent, and escalation-to-human over autonomous behavior**.
The owner is alerted — never bypassed — when the recipient shows shopping interest, raises
serious topics, or asks for a human.

## 2. Blocking decisions (PRD §13)

| # | Decision | Confirmed choice | Status |
|---|----------|------------------|--------|
| D1 | Recipient consent model | **Wife knows it's AI; explicit opt-in via WhatsApp before first automated message** | ✅ Confirmed 16 Nov |
| D2 | WhatsApp integration | **Meta WhatsApp Cloud API** (official, dedicated Business number) | ✅ Confirmed 16 Nov |
| D3 | Owner alert channel | **WhatsApp via a second Cloud API-registered number** (see note below) | ✅ Confirmed 16 Nov |
| D4 | Architecture | **Custom backend (Node.js/TypeScript + SQLite) running only on this machine** | ✅ Confirmed 16 Nov |

D3 note: the simplest variant is alerts sent *from the bot's own number* to your personal
WhatsApp (one Meta app, one number). A separate alert number requires a second Meta app
registration. Alerts/replies in either thread follow the same Cloud API rules (free-form within
24h of the owner's last message; otherwise an approved utility template). We will start with
alerts from the bot number and only add a second number if you want the threads separated.

## 3. Key technical constraints (PRD gaps + decision implications)

WhatsApp Cloud API rules that shape the design:
- **Number migration warning (D2):** a number registered to the Cloud API **can no longer be
  used in the regular WhatsApp app**. The bot needs a dedicated number/SIM that is not your
  personal WhatsApp. Register it via Meta Business Platform (free tier available; per-message
  pricing applies after free tier).
- **Business-initiated messages require pre-approved templates.** Proactive check-ins outside a
  24-hour reply window must use approved message templates (marketing/utility category).
  → Phase 1 includes submitting 3–5 check-in template variants for Meta approval; approval is
  a schedule risk and may constrain tone ("জান … ❤️" may not pass review).
- **Replies within the 24-hour window are free-form** — normal conversation is unaffected.

Local-only hosting implications (D4):
- Meta's webhooks need a **public HTTPS URL** → run a `cloudflared` named tunnel (free, stable
  URL) from this machine and register that URL as the webhook endpoint. (ngrok free tier
  rotates URLs; not suitable.)
- **Machine sleep/reboot = bot offline.** Mitigations: process manager (pm2/systemd user
  service), disable automatic sleep while on AC power, uptime alert sent to the owner thread
  if the service restarts. Meta retries webhook deliveries (with backoff) while we are down,
  so inbound messages are not lost — but dedup and staleness handling become critical
  (`FR-13`, plus: don't auto-reply to messages older than ~15 minutes unless safety-classified).
- LLM and Cloud API calls are outbound-only, so no inbound firewall changes needed.

## 4. Riskiest assumptions (assumption-mapping pass)

| Assumption | Type | Severity if wrong | Test first |
|---|---|---|---|
| Recipient genuinely consents and prefers AI check-ins to silence | Ethical / desirable | Fatal — product shouldn't exist | D1 conversation, Phase 2 consent flow |
| Meta approves our check-in templates & business use case | Feasible | High — no proactive messaging | Submit templates early (Phase 1) |
| Classifier reliably separates "casual compliment" from "want to buy" | Feasible | Medium — annoying false-pause loops | Phase 4 eval set of 30–50 labeled Bangla messages |
| LLM replies sound natural in Bangla-English code-switching without impersonating the owner | Feasible / ethical | High — breaks trust | Phase 3 prompt evals |
| Recipient doesn't confuse AI replies with the owner's own words | Ethical | High | Disclosure in onboarding + periodic in-chat reminder |

## 5. Phased plan

### Phase 0 — Decisions & external setup (blocking, ~days depending on Meta)
- ~~Confirm D1–D4~~ ✅ Done 16 Nov.
- Acquire a dedicated SIM/number for the bot (must not be your personal WhatsApp — see §3).
- Create Meta Business account + developer app; register the bot number for Cloud API.
- Register the owner's number to receive alerts and send takeover commands (thread with bot
  number; add a second Cloud API number only if thread separation is wanted later).
- Verify template policy fit for the desired tone; draft 3–5 check-in templates.
- Prepare the local runtime: Node LTS, `cloudflared` named tunnel, pm2/systemd user service.
- **Exit criteria:** Meta app live; bot number on Cloud API; tunnel URL stable; consent flow
  with wife agreed and scheduled (formal opt-in still happens in Phase 2).

### Phase 1 — Foundation
- Repo scaffolding: TypeScript service, config via env/secrets manager, SQLite.
- Webhook endpoint: signature validation, webhook redelivery dedup (`FR-13`),
  stale-inbound policy (>15 min old → log + hold, don't auto-reply).
- DB schema: conversation state machine (PRD §8), consent, prefs, message refs, audit log.
- Submit check-in message templates to Meta; submit utility template for alerts.
- **Exit criteria:** signed webhooks accepted through the tunnel; every inbound message stored
  once; state machine persisted; service survives reboot via process manager.

### Phase 2 — Consent & guardrails (safety before intelligence)
- Onboarding disclosure flow; automation `disabled until recipient opts in` (`FR-01`, `FR-02`).
- `PAUSE` / `STOP` keyword handling, immediate effect (`FR-07`).
- Quiet hours, messaging window, daily cap + minimum interval (`FR-04`, `FR-05`).
- Idempotent scheduler with dedup keys (`FR-13`).
- **Exit criteria:** acceptance criteria 1, 3, 4, 8 pass in automated tests.

### Phase 3 — Conversation engine
- Constrained system prompt (PRD §9 policy encoded verbatim), bounded history window (`FR-06`).
- Bangla/English code-switching, configurable tone (`FR-12`).
- Transparent fallback message on LLM/provider failure (NFR latency).
- Periodic AI-identity reminder cadence in long conversations.
- **Exit criteria:** reply quality eval set passes; no fabricated owner-facts in evals; criteria 2, 10 hold.

### Phase 4 — Detection & escalation
- Intent/safety classifier over inbound messages: shopping-interest, serious/emergency,
  explicit human-request, opt-out commands (`FR-08`, `FR-09`).
- LLM-assisted classification + keyword fast-path for STOP/PAUSE/emergency terms.
- Escalation flow: stop bot → urgent owner alert → transparent recipient holding message (PRD §4.5).
- Tuning set: 30–50 labeled sample Bangla messages; prefer escalation on uncertainty (NFR safety).
- **Exit criteria:** criteria 5, 6, 7 pass on the labeled set.

### Phase 5 — Owner controls & observability
- WhatsApp alert thread (owner ↔ bot number) + takeover/resume commands (`FR-10`):
  `/takeover` → bot fully silent; `/resume` → automation restored per consent rules.
- Control panel (minimal web UI): pause, take over, review alerts, resume.
- Event log: delivery, failure, pause, escalation + *why* (`FR-11`).
- **Exit criteria:** criterion 9 passes — owner takeover produces zero competing bot messages.

### Phase 6 — Hardening & acceptance
- Failure drills: webhook redelivery storm, provider outage, LLM timeout, clock/timezone edge cases.
- Full acceptance run against PRD §11 criteria 1–11, documented.
- Privacy pass: retention limits, access restriction, secrets audit.

## 6. Defaults for remaining open questions (confirm or override)

| PRD §12 | Default |
|---|---|
| Q3 Check-in frequency | 2–3/day, owner-configurable, within 10:00–21:00 recipient-local |
| Q4 Language/tone | Bangla-primary with natural English code-switching; "জান" + light emoji only if templates approve |
| Q5 Shopping rule | Alert on *any* product compliment (owner prefers noise over missed signals — safer default) |
| Q7 Serious-topic threshold | Escalate on conflict/distress/urgent; light emotional chat stays with AI |
| Q8 Takeover/resume | Owner sends `/takeover` in the WhatsApp alert thread → bot fully silent until owner sends `/resume` **and** recipient's next message confirms session restart |
| Q9 History window | Last 20 messages + rolling summary, never full history (privacy NFR) |

## 7. Explicitly out of scope (PRD §10)

Purchases/payments, images/voice/calls, relationship advice, third-party contact,
impersonation of the owner. These stay out of MVP; revisit only with new PRD version.
