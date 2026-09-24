import type { AgentAdapter } from "./base.js";
import { appendExtra } from "./base.js";

const shared = (model: string) => ["--print", "--output-format", "stream-json", "--model", model];

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  version: (config) => ({ command: config.command, args: ["--version"] }),
  discovery: (context, prompt) => ({
    command: context.config.command,
    args: appendExtra([...shared(context.config.model), prompt], context.config),
  }),
  interview: (context, sessionId, prompt) => ({
    command: context.config.command,
    args: appendExtra([...shared(context.config.model), "--resume", sessionId, prompt], context.config),
  }),
};
