# bou-bot

A consent-based WhatsApp AI companion: occasional affectionate check-ins (Bangla/English),
warm replies to messages, honest AI identity at all times, and **human-first escalation** —
it pauses and alerts the account owner for shopping-interest signals, serious topics, and
emergencies rather than ever handling them autonomously.

Built from `doc/PRD: Consent-Based WhatsApp AI Companion` (v0.1) and
`doc/Implementation-Plan.md` (v0.2).

## Safety principles (non-negotiable, enforced in code)

1. **No message before explicit opt-in** — automation stays off until the recipient replies `START`.
2. **Honest identity** — every onboarding message, consent confirmation, check-in, and holding
   message states it is an AI assistant. Identity questions get a truthful deterministic answer.
3. **STOP is instant and total** — one word, all automation ends; only the owner can re-invite,
   and the recipient must opt in again.
4. **The owner decides** — shopping-interest signals pause the bot and alert the owner; the bot
   never redirects, dismisses, or influences. Emergencies and serious topics escalate immediately
   with a transparent holding message.
5. **No impersonation** — the reply system prompt forbids inventing the owner's actions,
   promises, or feelings (see `src/engine/prompts.ts`).

## Quickstart (no WhatsApp account needed)

```bash
npm install
npm run sim          # mock WhatsApp + mock LLM, http://localhost:3210
```

Then drive the simulator:

```bash
# She sends the first message -> bot answers with the AI disclosure + consent ask
curl -X POST localhost:3210/sim/inbound -H 'content-type: application/json' \
  -d '{"text":"কে এই নাম্বারে?"}'

curl -X POST localhost:3210/sim/inbound -H 'content-type: application/json' -d '{"text":"START"}'
curl -X POST localhost:3210/sim/inbound -H 'content-type: application/json' -d '{"text":"ভালো আছি!"}'
curl -X POST localhost:3210/sim/inbound -H 'content-type: application/json' -d '{"text":"এই জামাটা পছন্দ হয়েছে, কিনতে ইচ্ছা করছে"}'
curl -X POST localhost:3210/sim/inbound -H 'content-type: application/json' -d '{"from":"'"$OWNER"'","text":"/resume"}'

# Check what the bot sent
curl -s localhost:3210/sim/outbox | jq .
# Run one check-in scheduler tick
curl -X POST localhost:3210/sim/tick
# Control panel (alerts, pause/takeover/resume, audit log)
open http://localhost:3210/admin   # token: ADMIN_TOKEN
```

## Tests

```bash
npm test             # 49 tests: PRD acceptance criteria 1–11, state machine, scheduler, signatures
npm run build        # type check
```

## Architecture

```
Meta Cloud API ──webhook──▶ server.ts ──▶ Orchestrator (the single gatekeeper)
                             │                ├─ STOP/PAUSE/START fast-path (instant, any state)
                             │                ├─ consent gate (AWAITING_CONSENT → nothing sends)
                             │                ├─ classifier: emergency / serious / human_request /
                             │                │   identity / shopping_interest / none
                             │                ├─ state machine (PRD §8, authorization-checked)
                             │                └─ escalation → owner alert + holding message
                             ├─▶ CheckinScheduler (window, tz, daily cap, min interval,
                             │   unanswered-opener guard, idempotent slots)
                             ├─▶ AlertEngine (persist-first owner alerts, template fallback)
                             ├─▶ LlmProvider (anthropic | mock) — constrained system prompt,
                             │   bounded 20-message history
                             └─▶ SQLite (state, messages, alerts, audit, scheduler slots)
```

Key modules: `src/engine/orchestrator.ts` (policy pipeline), `src/engine/classifier.ts`
(keyword fast-path + LLM classification), `src/engine/scheduler.ts`, `src/engine/alerts.ts`,
`src/state.ts` (transition authorization), `src/i18n.ts` (all Bangla templates),
`src/llm/anthropic.ts` (Claude API), `src/wa/cloud.ts` (Meta Cloud API client).

## Going live (when the Meta setup is done)

Follow `doc/META-SETUP.md` step by step, then:

```bash
cp .env.example .env   # fill in every value
npm start
```

The webhook needs a public HTTPS URL — run `cloudflared tunnel --url http://localhost:3210`
(local-only hosting per plan decision D4) and register that URL in the Meta app dashboard.

## Configuration

All configuration lives in `.env` (see `.env.example` for every variable and its default):
messaging window + timezone, daily proactive cap, minimum interval, alert template,
LLM models (`LLM_CHAT_MODEL` default `claude-opus-5-5`, classifier `claude-haiku-5-5`),
check-in template names, and the signature line appended to proactive messages.
