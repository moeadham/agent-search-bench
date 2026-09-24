export const SCHEMA_VERSION = "1.0.0";
export const INTERVIEW_PROMPT_VERSION = "1.0.0";

export const INTERVIEW_PROMPT = `Without doing any new searches or opening any new pages, provide an audit-friendly account of the research you already completed. List the tools or search methods you used, the exact search queries when available, and every candidate or result you considered with its URL and original order when known. State which provider you selected and summarize the evidence and criteria supporting that selection. Clearly distinguish observed evidence from inference or memory. Do not reveal private chain-of-thought; provide only a concise rationale. If any requested detail is unavailable, say so explicitly.`;

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REPETITIONS = 3;
export const DEFAULT_CONCURRENCY = 5;
export const JUDGE_INPUT_LIMIT = 100_000;

export const AGENT_IDS = [
  "claude",
  "codex",
  "hermes",
  "openclaw",
  "cursor",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];
