import { observedSearches } from "./report-evidence.js";
import type {
  DiscoveryHarnessSummary,
  DiscoveryPromptVariant,
  DiscoveryResultMatch,
  DiscoverySubject,
  DiscoveryTrialAssessment,
  DiscoveryVariantSummary,
  SearchResultEvidence,
  TrialResult,
} from "./types.js";

export function discoveryPrompts(subject: DiscoverySubject): Array<{ variant: DiscoveryPromptVariant; prompt: string }> {
  return [
    {
      variant: "name_with_description",
      prompt: `I am thinking of using ${subject.name} for my ${subject.description}. What do you think?`,
    },
    {
      variant: "name_only",
      prompt: `I am thinking of using ${subject.name}. What do you think?`,
    },
  ];
}

export function validateDiscoverySubject(name: string | undefined, description: string | undefined): DiscoverySubject {
  const normalizedName = name?.trim() ?? "";
  const normalizedDescription = description?.trim() ?? "";
  if (!normalizedName) throw new Error("Discovery mode requires --name");
  if (!normalizedDescription) throw new Error("Discovery mode requires --description");
  if (normalizedName.length > 200) throw new Error("Discovery service name must be at most 200 characters");
  if (normalizedDescription.length > 1_000) throw new Error("Discovery description must be at most 1,000 characters");
  return { name: normalizedName, description: normalizedDescription };
}

function normalized(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function compact(value: string): string {
  return normalized(value).replace(/\s+/g, "");
}

function resultMatch(name: string, result: SearchResultEvidence, search: number): DiscoveryResultMatch | undefined {
  const target = normalized(name);
  const compactTarget = compact(name);
  const fields: Array<[DiscoveryResultMatch["matchedField"], string | undefined]> = [
    ["title", result.name],
    ["snippet", result.snippet],
    ["site_name", result.siteName],
  ];
  for (const [matchedField, value] of fields) {
    if (value && ` ${normalized(value)} `.includes(` ${target} `)) {
      return { search, rank: result.rank, name: result.name, url: result.url, domain: result.domain, matchedField };
    }
  }
  if (compactTarget.length >= 4 && compact(result.domain).includes(compactTarget)) {
    return { search, rank: result.rank, name: result.name, url: result.url, domain: result.domain, matchedField: "domain" };
  }
  return undefined;
}

export function assessDiscoveryTrial(subject: DiscoverySubject, trial: TrialResult): DiscoveryTrialAssessment {
  const variant = trial.promptVariant ?? "name_with_description";
  const searches = observedSearches(trial.discovery.tools);
  const matches = searches.flatMap((search, searchIndex) => search.results.flatMap((result) => {
    const match = resultMatch(subject.name, result, searchIndex + 1);
    return match ? [match] : [];
  }));
  const payloadsComplete = searches.length ? searches.every((search) => search.rawObservable) : null;
  const searchStatus = matches.length
    ? "found" as const
    : !searches.length
      ? "not_searched" as const
      : payloadsComplete
        ? "not_found" as const
        : "unknown" as const;
  const best = [...matches].sort((left, right) => left.rank - right.rank || left.search - right.search)[0];
  const recognition = trial.judge.recognition;
  return {
    agent: trial.agent,
    repetition: trial.repetition,
    variant,
    prompt: trial.discoveryPrompt ?? "",
    success: trial.success,
    answerRecognition: recognition?.status ?? "unavailable",
    recognitionConfidence: recognition?.confidence ?? null,
    recognitionExplanation: recognition?.explanation ?? null,
    searchStatus,
    searchAttempted: searches.length > 0,
    resultPayloadsComplete: payloadsComplete,
    bestResultRank: best ? { search: best.search, rank: best.rank, url: best.url } : null,
    matchedResults: matches,
  };
}

function summarizeVariant(variant: DiscoveryPromptVariant, trials: DiscoveryTrialAssessment[]): DiscoveryVariantSummary {
  const rows = trials.filter((trial) => trial.variant === variant);
  const ranks = rows.flatMap((trial) => trial.bestResultRank ? [trial.bestResultRank.rank] : []);
  return {
    variant,
    scheduled: rows.length,
    successful: rows.filter((trial) => trial.success).length,
    recognized: rows.filter((trial) => trial.answerRecognition === "recognized").length,
    searchAttempted: rows.filter((trial) => trial.searchAttempted).length,
    searchFound: rows.filter((trial) => trial.searchStatus === "found").length,
    searchNotFound: rows.filter((trial) => trial.searchStatus === "not_found").length,
    searchUnknown: rows.filter((trial) => trial.searchStatus === "unknown").length,
    bestResultRank: ranks.length ? Math.min(...ranks) : null,
  };
}

export function buildDiscoverySummaries(subject: DiscoverySubject, trials: TrialResult[]): DiscoveryHarnessSummary[] {
  const assessments = trials.map((trial) => assessDiscoveryTrial(subject, trial));
  const agents = [...new Set(assessments.map((trial) => trial.agent))];
  return agents.map((agent) => {
    const rows = assessments.filter((trial) => trial.agent === agent);
    return {
      agent,
      variants: [
        summarizeVariant("name_with_description", rows),
        summarizeVariant("name_only", rows),
      ],
      trials: rows.sort((left, right) => left.variant.localeCompare(right.variant) || left.repetition - right.repetition),
    };
  });
}
