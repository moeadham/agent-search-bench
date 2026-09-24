import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { AGENT_IDS, DEFAULT_CONCURRENCY, DEFAULT_REPETITIONS, DEFAULT_TIMEOUT_MS, type AgentId } from "./constants.js";
import type { BenchmarkConfig } from "./types.js";

const agentSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().min(1),
  model: z.string().min(1),
  credentialEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1),
  provider: z.string().min(1).optional(),
  searchProvider: z.string().min(1).optional(),
  searchBackend: z.string().min(1).optional(),
  discoveryPromptSuffix: z.string().min(1).optional(),
  extraArgs: z.array(z.string()).optional(),
});

const configSchema = z.object({
  outputDir: z.string().min(1).default("runs"),
  repetitions: z.number().int().min(1).max(50).default(DEFAULT_REPETITIONS),
  concurrency: z.number().int().min(1).max(20).default(DEFAULT_CONCURRENCY),
  timeoutMs: z.number().int().min(1_000).default(DEFAULT_TIMEOUT_MS),
  agents: z.object(Object.fromEntries(AGENT_IDS.map((id) => [id, agentSchema])) as Record<AgentId, typeof agentSchema>),
  judge: z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    timeoutMs: z.number().int().min(1_000).default(120_000),
  }),
  aliases: z.record(z.string(), z.string()).default({}),
});

export const DEFAULT_CONFIG_PATH = process.env.ASBENCH_CONFIG ?? "agent-search-bench.config.json";

export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<{ config: BenchmarkConfig; raw: string; path: string }> {
  const absolute = resolve(path);
  const raw = await readFile(absolute, "utf8");
  const parsed = configSchema.parse(JSON.parse(raw)) as BenchmarkConfig;
  for (const [id, agent] of Object.entries(parsed.agents)) {
    if (agent.enabled && /REPLACE_ME|CHOOSE_/i.test(agent.model)) {
      throw new Error(`Agent ${id} needs an explicit model pin in ${absolute}`);
    }
    if (agent.enabled && agent.provider && /REPLACE_ME|CHOOSE_/i.test(agent.provider)) {
      throw new Error(`Agent ${id} needs an explicit provider in ${absolute}`);
    }
  }
  if (/REPLACE_ME|CHOOSE_/i.test(parsed.judge.model) || parsed.judge.baseUrl.includes("your-independent-judge.example")) {
    throw new Error(`Judge needs an explicit model pin and endpoint in ${absolute}`);
  }
  return { config: parsed, raw, path: absolute };
}

export function hashConfig(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function createConfigTemplate(): BenchmarkConfig {
  return {
    outputDir: "runs",
    repetitions: DEFAULT_REPETITIONS,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    agents: {
      claude: { enabled: true, command: "claude", model: "CHOOSE_CLAUDE_MODEL", credentialEnv: ["ANTHROPIC_API_KEY"] },
      codex: { enabled: true, command: "codex", model: "CHOOSE_CODEX_MODEL", credentialEnv: ["CODEX_API_KEY"] },
      hermes: { enabled: true, command: "hermes", model: "CHOOSE_HERMES_MODEL", provider: "CHOOSE_HERMES_PROVIDER", credentialEnv: ["HERMES_PROVIDER_API_KEY", "FIRECRAWL_API_KEY"], searchProvider: "firecrawl", searchBackend: "Hermes Firecrawl" },
      openclaw: { enabled: true, command: "openclaw", model: "CHOOSE_OPENCLAW_MODEL", credentialEnv: ["OPENCLAW_PROVIDER_API_KEY", "BRAVE_API_KEY"], searchProvider: "brave", searchBackend: "OpenClaw Brave Search" },
      cursor: { enabled: false, command: "cursor-agent", model: "CHOOSE_CURSOR_MODEL", credentialEnv: ["CURSOR_API_KEY"] },
    },
    judge: {
      baseUrl: "https://your-independent-judge.example/v1",
      model: "CHOOSE_JUDGE_MODEL",
      apiKeyEnv: "JUDGE_API_KEY",
      timeoutMs: 120_000,
    },
    aliases: {},
  };
}

export async function writeConfigTemplate(path = DEFAULT_CONFIG_PATH): Promise<void> {
  await writeFile(resolve(path), `${JSON.stringify(createConfigTemplate(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function writeConfig(path: string, config: BenchmarkConfig): Promise<void> {
  await writeFile(resolve(path), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
