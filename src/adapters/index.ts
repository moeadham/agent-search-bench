import type { AgentId } from "../constants.js";
import type { AgentAdapter } from "./base.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { hermesAdapter } from "./hermes.js";
import { openclawAdapter } from "./openclaw.js";

export const adapters: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  hermes: hermesAdapter,
  openclaw: openclawAdapter,
  cursor: cursorAdapter,
};
