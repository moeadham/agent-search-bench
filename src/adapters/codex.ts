import type { AgentAdapter } from "./base.js";
import { appendExtra } from "./base.js";

export const codexAdapter: AgentAdapter = {
  id: "codex",
  version: (config) => ({ command: config.command, args: ["--version"] }),
  discovery: (context, prompt) => ({
    command: context.config.command,
    args: appendExtra([
      "--search", "exec", "--json", "--model", context.config.model,
      "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
      "--cd", context.workDir, prompt,
    ], context.config),
    env: { CODEX_HOME: `${context.homeDir}/.codex` },
  }),
  interview: (context, sessionId, prompt) => ({
    command: context.config.command,
    args: appendExtra([
      "--search", "exec", "resume", sessionId, "--json", "--model", context.config.model,
      "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", prompt,
    ], context.config),
    env: { CODEX_HOME: `${context.homeDir}/.codex` },
  }),
};
