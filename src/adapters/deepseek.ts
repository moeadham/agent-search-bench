import type { AgentAdapter } from "./base.js";
import { appendExtra } from "./base.js";

function runtimeEnv(homeDir: string): Record<string, string> {
  return {
    DSH_HOME: `${homeDir}/.dsh`,
    DSH_PERMISSION_MODE: "read-only",
    DSH_TELEMETRY_MODE: "FEEDBACK_ONLY",
  };
}

const shared = ["headless", "--json"];

export const deepseekAdapter: AgentAdapter = {
  id: "deepseek",
  version: (config) => ({ command: config.command, args: ["--version"] }),
  discovery: (context, prompt) => ({
    command: context.config.command,
    args: appendExtra(shared, context.config),
    stdin: prompt,
    env: runtimeEnv(context.homeDir),
  }),
  interview: (context, sessionId, prompt) => ({
    command: context.config.command,
    args: appendExtra([...shared, "--session-id", sessionId], context.config),
    stdin: prompt,
    env: runtimeEnv(context.homeDir),
  }),
};
