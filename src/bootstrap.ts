import type { AppConfig } from "./config.js";
import { Db } from "./db.js";
import { MockWaClient } from "./wa/mock.js";
import { CloudWaClient } from "./wa/cloud.js";
import type { WaClient } from "./wa/types.js";
import { MockLlm } from "./llm/mock.js";
import { AnthropicLlm } from "./llm/anthropic.js";
import type { LlmProvider } from "./llm/provider.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { CheckinScheduler } from "./engine/scheduler.js";

export interface Stack {
  cfg: AppConfig;
  db: Db;
  wa: WaClient;
  llm: LlmProvider;
  orchestrator: Orchestrator;
  scheduler: CheckinScheduler;
}

/** Wire the whole application around a config (single composition root, also used by tests). */
export function buildStack(cfg: AppConfig): Stack {
  const db = new Db(cfg.dbPath);
  const wa: WaClient = cfg.waProvider === "cloud" ? new CloudWaClient(cfg) : new MockWaClient(db);
  const llm: LlmProvider =
    cfg.llmProvider === "anthropic" ? new AnthropicLlm(cfg) : new MockLlm();
  const orchestrator = new Orchestrator(cfg, db, wa, llm);
  const scheduler = new CheckinScheduler(cfg, db, wa);
  return { cfg, db, wa, llm, orchestrator, scheduler };
}
