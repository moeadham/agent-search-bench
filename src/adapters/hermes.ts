import type { AgentAdapter } from "./base.js";
import { appendExtra } from "./base.js";

const shared = (model: string, provider?: string) => [
  "chat", "--oneshot", "--ignore-rules", "--quiet", "--format", "stream-json",
  "--model", model,
  ...(provider ? ["--provider", provider] : []),
  "--toolsets", "web", "--query-file", "-",
];

export const hermesAdapter: AgentAdapter = {
  id: "hermes",
  version: (config) => ({ command: config.command, args: ["--version"] }),
  discovery: (context, prompt) => ({
    command: context.config.command,
    args: appendExtra(shared(context.config.model, context.config.provider), context.config),
    stdin: prompt,
    env: { HERMES_HOME: `${context.homeDir}/.hermes` },
  }),
  interview: (context, sessionId, prompt) => ({
    command: context.config.command,
    args: appendExtra([...shared(context.config.model, context.config.provider), "--resume", sessionId], context.config),
    stdin: prompt,
    env: { HERMES_HOME: `${context.homeDir}/.hermes` },
  }),
};
