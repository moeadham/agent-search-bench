import type { AgentAdapter } from "./base.js";
import { appendExtra } from "./base.js";

const shared = (model: string) => [
  "--print",
  "--output-format", "stream-json",
  "--verbose",
  "--safe-mode",
  "--model", model,
  "--permission-mode", "dontAsk",
  "--permission-prompts", "none",
  "--allowedTools", "WebSearch", "WebFetch",
];

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  version: (config) => ({ command: config.command, args: ["--version"] }),
  discovery: (context, prompt) => ({
    command: context.config.command,
    args: appendExtra([...shared(context.config.model), "--session-id", context.sessionKey, prompt], context.config),
    env: { CLAUDE_CONFIG_DIR: `${context.homeDir}/.claude` },
  }),
  interview: (context, sessionId, prompt) => ({
    command: context.config.command,
    args: appendExtra([...shared(context.config.model), "--resume", sessionId, prompt], context.config),
    env: { CLAUDE_CONFIG_DIR: `${context.homeDir}/.claude` },
  }),
};
