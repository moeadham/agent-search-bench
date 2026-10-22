import type { AgentId } from "../constants.js";
import type { AgentAdapter } from "./base.js";
import { antigravityAdapter } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { deepseekAdapter } from "./deepseek.js";
import { hermesAdapter } from "./hermes.js";
import { openclawAdapter } from "./openclaw.js";

export const adapters: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  deepseek: deepseekAdapter,
  antigravity: antigravityAdapter,
  hermes: hermesAdapter,
  openclaw: openclawAdapter,
  cursor: cursorAdapter,
};
