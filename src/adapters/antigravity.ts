import type { AgentAdapter } from "./base.js";
import { appendExtra } from "./base.js";

function runtimeEnv(): Record<string, string> {
  return {
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    AGY_CLI_HIDE_LOGO: "true",
    NO_COLOR: "1",
  };
}

function shared(model: string): string[] {
  return [
    "--output-format", "stream-json",
    "--model", model,
    "--dangerously-skip-permissions",
  ];
}

export const antigravityAdapter: AgentAdapter = {
  id: "antigravity",
  version: (config) => ({ command: config.command, args: ["--version"] }),
  discovery: (context, prompt) => ({
    command: context.config.command,
    args: appendExtra(["-p", prompt, ...shared(context.config.model)], context.config),
    env: runtimeEnv(),
  }),
  interview: (context, sessionId, prompt) => ({
    command: context.config.command,
    args: appendExtra(["-p", prompt, "--conversation", sessionId, ...shared(context.config.model)], context.config),
    env: runtimeEnv(),
  }),
};
