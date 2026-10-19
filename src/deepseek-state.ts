import { join } from "node:path";
import type { BenchmarkConfig } from "./types.js";

type DeepSeekConfig = BenchmarkConfig["agents"]["deepseek"];

export function deepSeekStatePatch(config: DeepSeekConfig, stateDir: string): Array<Record<string, unknown>> {
  return [
    {
      id: "agent-default-model",
      config: { provider: "deepseek-official", model: config.model },
    },
    {
      id: "web",
      config: {
        searchProvider: config.searchProvider ?? "deepseek-search-api",
        fetchProvider: "deepseek-fetch-api",
      },
    },
    {
      id: "web-deepseek-api",
      config: { apiKeyEnv: config.credentialEnv[0], count: 10, sendOriginalQuestion: true },
    },
    {
      id: "tool-web",
      config: { searchMaxResults: 10 },
    },
    {
      id: "session-persistence-jsonl",
      config: { root: join(stateDir, "sessions"), compression: "none" },
    },
  ];
}
