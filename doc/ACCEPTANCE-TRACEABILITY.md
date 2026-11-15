# Acceptance Criteria Traceability — PRD §11 → tests

Automated suite: `npm test` (49 tests, all passing as of 2026-11-16).
Runtime: vitest, in-memory SQLite, mock WhatsApp + deterministic mock LLM.

| PRD §11 acceptance criterion | Verifying tests | Status |
|---|---|---|
| 1. No proactive message before recipient opt-in | acceptance.test.ts › "sends NO proactive message before recipient opt-in"; scheduler.test.ts › "no proactive at all before the recipient exists" | ✅ |
| 2. Onboarding clearly identifies the assistant as AI | "first contact receives a clear AI disclosure and consent request" (asserts "AI assistant" + START/STOP instructions); disclosure reminder, consent confirm, check-in signature line, holding message each re-assert identity | ✅ |
| 3. STOP disables all future automated messages immediately | "STOP confirms, stops state, and stays silent forever" (+ no checkins, silence on inbound, owner informed); "START after STOP does not reactivate" | ✅ |
| 4. No proactive during quiet hours / past daily cap | scheduler.test.ts › "blocks at window edges", "respects minimum interval", "different tz_date resets the daily cap"; acceptance.test.ts › "blocks check-ins outside the messaging window", "enforces the daily cap" | ✅ |
| 5. Purchase-interest message pauses + alerts owner | "pauses the bot and alerts the owner without answering her"; "stays silent while paused; owner /resume re-enables" | ✅ |
| 6. Serious/emergency message pauses + urgent alert | "escalates self-harm signals with emergency holding message" (urgent severity asserted; holding message = PRD §4.5.3 text + emergency-services encouragement + no-guarantee wording) | ✅ |
| 7. Direct request for the owner triggers takeover/escalation | "escalates a direct request to talk to the owner without emergency wording" | ✅ |
| 8. Duplicate webhook events do not create duplicate replies | "processes a redelivered message id only once" (unit) + live smoke: same Meta-format webhook POST twice → `duplicate_inbound_ignored` audit event | ✅ |
| 9. Owner can inspect alert and take over without competing bot messages | "bot stays completely silent during takeover"; "emergency follow-up during takeover alerts the owner immediately" (alert w/o autonomy); two-phase resume test | ✅ |
| 10. Assistant never claims to be the owner / fabricate | "answers identity questions truthfully via the deterministic template"; "gives the LLM a bounded history"; "system prompt embeds the PRD §9 policy" (NEVER pretend / never invent / never conceal / never purchases-promises-commitments / no guilt-pressure) | ✅ |
| 11. (audit/log requirements FR-11) | "records why messages were sent, paused, or escalated" + audit events asserted throughout (`state_changed`, `escalated`, `shopping_interest_paused`, `owner_notified`, `owner_notify_failed`) | ✅ |

## Additional regression coverage

- State machine authorization (PRD §8): `test/state.test.ts` — system never exits
  escalated/takeover/stopped; STOPPED re-opens only via owner-initiated re-consent.
- Webhook signature validation: `test/signature.test.ts` (tamper, wrong secret, malformed header).
- Classifier fast-path + LLM-unavailable fallback: `test/classifier.test.ts` (Bangla + English).
- Scheduler idempotency under overlapping ticks; timezone formatting (Asia/Dhaka UTC+6).

## Live-verified (simulator over HTTP, 2026-11-16)

Full journey driven against the running server in mock mode: first contact → disclosure →
opt-in → chat reply → shopping pause → owner `/resume` → emergency escalation → urgent
owner alert (with trigger + timestamp + takeover instructions) → webhook GET/POST →
admin API 401 without token → control panel HTML → scheduler tick refused in ESCALATED.

## Known untested-in-live conditions

- Real Meta Cloud API round-trip (no credentials on this machine yet — Phase 0).
- Real Claude API call (no `ANTHROPIC_API_KEY` configured here; SDK usage follows the
  official SDK patterns and is type-checked, but send/receive with a real key is pending).
