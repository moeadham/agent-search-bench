import type { AgentAdapter } from "./base.js";
import { appendExtra } from "./base.js";

function runtimeEnv(homeDir: string, workDir: string): Record<string, string> {
  return {
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: `${homeDir}/.openclaw`,
    OPENCLAW_CONFIG_PATH: `${homeDir}/.openclaw/openclaw.json`,
    OPENCLAW_WORKSPACE_DIR: workDir,
  };
}

function configPath(homeDir: string): string {
  return `${homeDir}/.openclaw/openclaw.json`;
}

export const openclawAdapter: AgentAdapter = {
  id: "openclaw",
  version: (config) => ({ command: config.command, args: ["--version"] }),
  discovery: (context, prompt) => ({
    command: context.config.command,
    args: appendExtra([
      "agent", "exec", "--message-file", "-", "--cwd", context.workDir,
      "--state-dir", `${context.homeDir}/.openclaw`, "--config", configPath(context.homeDir),
      "--model", context.config.model,
      "--json",
    ], context.config),
    stdin: prompt,
    env: runtimeEnv(context.homeDir, context.workDir),
  }),
  interview: (context, sessionId, prompt) => ({
    command: context.config.command,
    args: appendExtra([
      "agent", "--local", "--session-id", sessionId, "--model", context.config.model,
      "--message", prompt, "--json",
    ], context.config),
    env: runtimeEnv(context.homeDir, context.workDir),
  }),
};
