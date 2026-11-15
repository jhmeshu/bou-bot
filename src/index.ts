import { loadConfig } from "./config.js";
import { buildStack } from "./bootstrap.js";
import { createServer } from "./server.js";

const cfg = loadConfig();
const stack = buildStack(cfg);
const app = createServer(stack);

const TICK_MS = 60_000;
setInterval(() => {
  void stack.scheduler.tick().catch((e) => console.error("scheduler tick error:", e));
}, TICK_MS);

const server = app.listen(cfg.port, () => {
  console.log(`bou-bot listening on :${cfg.port} (wa=${stack.wa.provider}, llm=${stack.llm.provider})`);
  if (cfg.waProvider === "mock") {
    console.log(`Simulator ready:
  POST /sim/inbound  {"from":"...","text":"..."}
  GET  /sim/outbox
  POST /sim/tick     (run one check-in scheduler tick)
  GET  /admin        (control panel, token: ADMIN_TOKEN)`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    server.close(() => stack.db.sqlite.close());
    setTimeout(() => process.exit(0), 500);
  });
}
