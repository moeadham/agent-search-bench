export const SCHEMA_VERSION = "1.0.0";
export const INTERVIEW_PROMPT_VERSION = "1.0.0";
export const DISCOVERY_INTERVIEW_PROMPT_VERSION = "1.0.0";

export const INTERVIEW_PROMPT = `Without doing any new searches or opening any new pages, provide an audit-friendly account of the research you already completed. List the tools or search methods you used, the exact search queries when available, and every candidate or result you considered with its URL and original order when known. State which provider you selected and summarize the evidence and criteria supporting that selection. Clearly distinguish observed evidence from inference or memory. Do not reveal private chain-of-thought; provide only a concise rationale. If any requested detail is unavailable, say so explicitly.`;

export function discoveryInterviewPrompt(name: string): string {
  return `Without doing any new searches or opening any new pages, provide an audit-friendly account of how you answered the previous question about ${name}. State whether you recognized ${name} as a specific product or service before using any tools, and briefly state what you believe it is. List every search or retrieval tool you used, the exact queries or arguments, the ordered results you received when known, and any pages you opened or cited. Clearly distinguish prior knowledge, observed search evidence, and uncertainty. Do not reveal private chain-of-thought; provide only a concise stated justification. If any requested detail is unavailable, say so explicitly.`;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REPETITIONS = 3;
export const DEFAULT_CONCURRENCY = 15;
export const JUDGE_INPUT_LIMIT = 100_000;

export const AGENT_IDS = [
  "claude",
  "codex",
  "deepseek",
  "hermes",
  "openclaw",
  "cursor",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];
