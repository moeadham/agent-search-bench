import type { AgentId } from "./constants.js";

export interface AgentConfig {
  enabled: boolean;
  command: string;
  model: string;
  credentialEnv: string[];
  provider?: string;
  searchProvider?: string;
  searchBackend?: string;
  discoveryPromptSuffix?: string;
  extraArgs?: string[];
}

export interface JudgeConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  timeoutMs: number;
}

export interface BenchmarkConfig {
  outputDir: string;
  repetitions: number;
  concurrency: number;
  timeoutMs: number;
  agents: Record<AgentId, AgentConfig>;
  judge: JudgeConfig;
  aliases: Record<string, string>;
}

export interface CommandSpec {
  command: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
}

export interface ProcessResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  lines: string[];
  events: unknown[];
  malformedLines: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
}

export interface SearchResultEvidence {
  name: string;
  url: string;
  domain: string;
  rank: number;
  query?: string;
  tool?: string;
  snippet?: string;
  published?: string;
  siteName?: string;
}

export interface ToolEvidence {
  name: string;
  phase: "discovery" | "interview";
  query?: string;
  callId?: string;
  provider?: string;
  input?: unknown;
  output?: unknown;
  /** Search-provider synthesis or answer text delivered alongside ordered result rows. */
  responseText?: string;
  results: SearchResultEvidence[];
  rawObservable: boolean;
}

export interface AnswerCandidate {
  key: string;
  name: string;
  url?: string;
  domain?: string;
  rank: number;
  selected: boolean;
  confidence: number;
  source: "local" | "judge";
}

export interface TurnEvidence {
  sessionId?: string;
  finalText: string;
  resolvedModel?: string;
  resolvedProvider?: string;
  usage: Record<string, number | null> | null;
  costUsd: number | null;
  tools: ToolEvidence[];
}

export interface JudgeScores {
  relevance: number;
  alternativeCoverage: number;
  evidenceSupport: number;
  selectionJustification: number;
  traceConsistency: number;
}

export interface JudgeResult {
  status: "ok" | "invalid" | "error" | "skipped";
  scores?: JudgeScores;
  qualityScore?: number;
  rationale?: string;
  consistencyNotes?: string;
  answerCandidates?: AnswerCandidate[];
  rawOutput?: string;
  error?: string;
  attempts: number;
}

export interface TrialResult {
  schemaVersion: string;
  agent: AgentId;
  repetition: number;
  scheduled: true;
  success: boolean;
  failureStage?: "setup" | "discovery" | "resume" | "interview" | "judge";
  error?: string;
  modelPin: string;
  discoveryPrompt?: string;
  discovery: TurnEvidence;
  interview?: TurnEvidence;
  interviewPerformedNewResearch: boolean;
  answerCandidates: AnswerCandidate[];
  judge: JudgeResult;
  timing: {
    discoveryMs: number;
    interviewMs?: number;
    totalMs: number;
  };
}

export interface RunManifest {
  schemaVersion: string;
  runId: string;
  query: string;
  interviewPromptVersion: string;
  interviewPrompt: string;
  startedAt: string;
  completedAt?: string;
  repetitions: number;
  concurrency: number;
  timeoutMs: number;
  configHash: string;
  aliases: Record<string, string>;
  agentPrompts?: Partial<Record<AgentId, string>>;
  gitCommit?: string;
  imageIdentity?: string;
  agents: Partial<Record<AgentId, {
    enabled: boolean;
    command: string;
    modelPin: string;
    provider?: string;
    resolvedModels?: string[];
    resolvedProviders?: string[];
    searchBackend?: string;
    version?: string;
    versionError?: string;
  }>>;
  judge: {
    baseUrl: string;
    model: string;
  };
}

export interface EntityMetric {
  key: string;
  name: string;
  domain?: string;
  mentions: number;
  selections: number;
  firstMentions: number;
  discoveryRate: number;
  selectionShare: number;
  firstMentionShare: number;
  mrr: number;
  successConditionedMrr: number;
  averageRank: number | null;
  searchExposureMrr: number;
}

export interface AgentSummary {
  agent: AgentId;
  scheduled: number;
  successful: number;
  successRate: number;
  meanQualityScore: number | null;
  candidateSetStability: number | null;
  selectionAgreement: number | null;
}

export interface BenchmarkReport {
  schemaVersion: string;
  runId: string;
  query: string;
  generatedAt: string;
  scheduledTrials: number;
  successfulTrials: number;
  harnesses?: RunManifest["agents"];
  entities: EntityMetric[];
  agents: AgentSummary[];
  trials: TrialResult[];
}
