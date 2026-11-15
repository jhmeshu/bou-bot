# Meta WhatsApp Setup — Phase 0 walkthrough

Time: ~1–2 hours of clicks + possible Meta business verification wait.
Everything below is a human task (your identity, your SIM) — the code is ready and waiting.

## 1. Get a dedicated number (⚠️ important)

A number registered with the **WhatsApp Business Platform (Cloud API) can no longer be used
in the regular WhatsApp app**. Buy a new SIM / use a spare number — NOT your personal
WhatsApp, and NOT your wife's number (the bot messages her).

## 2. Meta Business account + app

1. Go to <https://business.facebook.com> → create a Business Portfolio (name it e.g. "bou-bot").
2. Go to <https://developers.facebook.com> → Create App → type **Business**.
3. In the app dashboard, add the **WhatsApp** product.
4. WhatsApp → API Setup: add your dedicated number as the "From" number (it will appear
   under your business, not the test number).
   - The **test number** Meta gives you for free can message up to 5 recipient numbers —
     good enough for the first days of testing before your own number is fully live.
5. Note down: **Phone number ID** (`WA_PHONE_NUMBER_ID`), and create a **permanent access
   token** (Business Settings → Users → System Users → create admin system user → add
   `whatsapp_business_messaging` permission → generate token). That token is `WA_ACCESS_TOKEN`.
6. App Settings → Basic: copy **App secret** → `WA_APP_SECRET`.

## 3. Add your wife as a recipient (consent first!)

- Test number: add her number in "To" recipients (she gets an invite code).
- Own number: Cloud API business-initiated messaging requires the recipient's opt-in —
  which is exactly what the bot's onboarding flow collects and stores. Per the PRD,
  **she must know it's an AI assistant and opt in before anything is sent** — the bot will
  not send a single automated message until she replies START to the disclosure.

## 4. Create the message templates (Business-initiated messages need approval)

WhatsApp → Message Templates → Create:

### a) 3 check-in templates (category: MARKETING or UTILITY — start with UTILITY; review tends to pass utility faster)

Name each exactly as in `.env` (`CHECKIN_TEMPLATES=checkin_1,checkin_2,checkin_3`), language **Bangla (bn)**.
Template content = the exact final text. Suggested (keep the AI-identity line — FR-02):

- checkin_1: `জান, কেমন আছো? আজকের দিনটা কেমন যাচ্ছে? — আপনার AI assistant 🤖`
- checkin_2: `খেয়েছো? নিজের খেয়াল রেখো। — আপনার AI assistant 🤖`
- checkin_3: `আজ তোমার দিনটা ভালো কাটুক ❤️ — আপনার AI assistant 🤖`

⚠️ Meta reviews template content: overly intimate phrasing may be rejected. If a template
is rejected, soften it and resubmit — the scheduler picks up whatever names are in `.env`.

### b) 1 owner-alert template (category: UTILITY, language bn, name must match `OWNER_ALERT_TEMPLATE`, default `owner_alert`)

Body with two variables:

```
🔔 bou-bot ALERT ({{1}})
মেসেজ: {{2}}
বট উত্তর বন্ধ আছে। নিজে সামলাতে /takeover, আবার চালু করতে /resume।
```

## 5. Webhook (the tunnel — local-only hosting, plan decision D4)

Meta needs a public HTTPS URL that reaches this machine.

```bash
# install cloudflared: https://developers.cloudflare.com/cloudflare/one-connections/tunnels/
cloudflared tunnel --url http://localhost:3210
# → prints a stable-ish https URL like https://xxxx.trycloudflare.com
```

Free quick-tunnels change URL on restart; for a stable URL create a named tunnel
(`cloudflared tunnel create bou-bot`) — recommended so you never re-register the webhook.

In the Meta app dashboard → WhatsApp → Configuration:

1. Callback URL: `<tunnel-url>/webhook`
2. Verify token: any string → same value in `WA_VERIFY_TOKEN` (the server answers the
   `hub.challenge` handshake automatically).
3. Webhook fields: subscribe to **messages**.
4. After saving, Meta immediately validates GET `/webhook` — the server must be running.

## 6. Fill `.env` and start

```bash
cp .env.example .env
# fill: WA_PROVIDER=cloud, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_APP_SECRET,
#       WA_VERIFY_TOKEN, WA_BOT_NUMBER, OWNER_PHONE, RECIPIENT_PHONE
# LLM:  LLM_PROVIDER=anthropic + your own ANTHROPIC_API_KEY (console.anthropic.com)
npm start
```

## 7. Keep it running (machine may sleep/reboot)

```bash
npm i -g pm2
pm2 start "npm start" --name bou-bot && pm2 save && pm2 startup
```

Also disable automatic sleep while on AC power (Settings → Power). Meta retries webhook
deliveries for a while when the machine is offline — messages are not lost, and the
stale-inbound policy (config `STALE_INBOUND_MINS`, default 15 min) prevents very late
awkward auto-replies.

## 8. Cost notes

- Cloud API: per-message pricing (~$0.005–0.03 per delivered conversation depending on
  category/country; utility templates are cheapest). Check current rates in the dashboard.
- Claude API: pay per token; `LLM_CHAT_MODEL` default claude-opus-5-5, classifier
  claude-haiku-5-5 (cheap). Lower cost option: set `LLM_CHAT_MODEL=claude-haiku-5-5`.

## 9. First live session (checklist)

1. `npm start` + tunnel up → `/health` returns `{"ok":true,"wa":"cloud","llm":"anthropic"}`.
2. She texts anything to the bot number → she receives the AI disclosure.
3. She texts `START` → consent confirmed (audit: `recipient_opted_in`).
4. Try `PAUSE`, `STOP`, a shopping phrase, a serious phrase — confirm alerts land on your WhatsApp.
5. `/status`, `/takeover`, `/resume` from your own WhatsApp.
