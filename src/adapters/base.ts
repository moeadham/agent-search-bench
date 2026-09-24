import type { AgentId } from "../constants.js";
import type { AgentConfig, CommandSpec } from "../types.js";

export interface AdapterContext {
  config: AgentConfig;
  homeDir: string;
  workDir: string;
  sessionKey: string;
}

export interface AgentAdapter {
  id: AgentId;
  version(config: AgentConfig): CommandSpec;
  discovery(context: AdapterContext, prompt: string): CommandSpec;
  interview(context: AdapterContext, sessionId: string, prompt: string): CommandSpec;
}

export function appendExtra(args: string[], config: AgentConfig): string[] {
  return [...args, ...(config.extraArgs ?? [])];
}
