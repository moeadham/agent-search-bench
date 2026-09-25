import { canonicalDomain } from "./evidence.js";
import type {
  AnswerCandidate,
  EvidencePosition,
  SearchResultEvidence,
  ToolEvidence,
  TrialEvidenceJourney,
  TrialResult,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSearchTool(tool: ToolEvidence): boolean {
  return /^(?:web_?search|search)$/i.test(tool.name);
}

export function observedSearches(tools: ToolEvidence[]): ToolEvidence[] {
  const searches = tools.filter(isSearchTool);
  return searches.filter((tool, index, all) => {
    const hasDetails = tool.callId || tool.input !== undefined || tool.output !== undefined || tool.query || tool.results.length;
    return Boolean(hasDetails) || !all.some((other, otherIndex) => otherIndex !== index && other.name === tool.name && Boolean(other.callId || other.input !== undefined || other.output !== undefined || other.query || other.results.length));
  });
}

export function primaryRecommendation(trial: TrialResult): AnswerCandidate | undefined {
  return trial.answerCandidates.find((candidate) => candidate.selected) ?? trial.answerCandidates[0];
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function urlsFromValue(value: unknown): string[] {
  const found: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
        const url = validHttpUrl(match[0].replace(/[.,;:!?]+$/, ""));
        if (url) found.push(url);
      }
      return;
    }
    if (Array.isArray(item)) return void item.forEach(visit);
    if (isRecord(item)) Object.values(item).forEach(visit);
  };
  visit(value);
  return [...new Set(found)];
}

export function answerCitations(text: string): string[] {
  return urlsFromValue(text);
}

export function openedPages(tools: ToolEvidence[]): string[] {
  return [...new Set(tools
    .filter((tool) => !isSearchTool(tool) && /fetch|open|browser|extract/i.test(tool.name))
    .flatMap((tool) => urlsFromValue(tool.input ?? tool.query ?? "")))];
}

function candidateDomains(candidate: AnswerCandidate): string[] {
  return [...new Set([
    candidate.domain,
    candidate.url ? canonicalDomain(candidate.url) : undefined,
    /\./.test(candidate.key) ? candidate.key : undefined,
  ].filter((value): value is string => Boolean(value)))];
}

function directlyMatches(candidate: AnswerCandidate, result: SearchResultEvidence, aliases: Record<string, string>): boolean {
  if (candidate.url && candidate.url.replace(/\/$/, "") === result.url.replace(/\/$/, "")) return true;
  if (candidateDomains(candidate).includes(result.domain)) return true;
  return aliases[result.domain]?.toLowerCase() === candidate.key.toLowerCase();
}

function mentionTerms(candidate: AnswerCandidate, aliases: Record<string, string>): string[] {
  const domains = candidateDomains(candidate);
  return [...new Set([
    candidate.name,
    !candidate.key.includes(".") ? candidate.key : undefined,
    ...domains.map((domain) => domain.split(".")[0]),
    ...Object.entries(aliases).filter(([, key]) => key.toLowerCase() === candidate.key.toLowerCase()).map(([alias]) => alias),
  ].filter((value): value is string => Boolean(value)).map(normalized).filter((value) => value.length >= 4))];
}

function mentioned(candidate: AnswerCandidate, result: SearchResultEvidence, aliases: Record<string, string>): boolean {
  const haystack = normalized([result.name, result.snippet, result.siteName].filter(Boolean).join(" "));
  return mentionTerms(candidate, aliases).some((term) => haystack.includes(term));
}

function bestPosition(matches: EvidencePosition[]): EvidencePosition | null {
  return [...matches].sort((left, right) => left.rank - right.rank || left.search - right.search)[0] ?? null;
}

function resultPositions(searches: ToolEvidence[], predicate: (result: SearchResultEvidence) => boolean): EvidencePosition[] {
  return searches.flatMap((search, searchIndex) => search.results
    .filter(predicate)
    .map((result) => ({ search: searchIndex + 1, rank: result.rank, url: result.url })));
}

export function buildTrialJourney(trial: TrialResult, aliases: Record<string, string>): TrialEvidenceJourney {
  const searches = observedSearches(trial.discovery.tools);
  const candidate = primaryRecommendation(trial);
  const opened = openedPages(trial.discovery.tools);
  const citations = answerCitations(trial.discovery.finalText);
  if (!candidate) {
    return {
      agent: trial.agent,
      repetition: trial.repetition,
      relationship: "unknown",
      basis: "unknown",
      ownedDomainRank: null,
      mentionRank: null,
      bestEvidenceRank: null,
      openedPages: opened,
      answerCitations: citations,
    };
  }

  const direct = resultPositions(searches, (result) => directlyMatches(candidate, result, aliases));
  const mentions = resultPositions(searches, (result) => mentioned(candidate, result, aliases));
  const ownedDomainRank = bestPosition(direct);
  const mentionRank = bestPosition(mentions);
  const bestEvidenceRank = bestPosition([...direct, ...mentions]);
  const complete = searches.length > 0 && searches.every((search) => search.rawObservable);
  const relationship = direct.length
    ? "direct_result"
    : mentions.length
      ? "mentioned_result"
      : complete
        ? "not_observed"
        : "unknown";
  const openedDomains = opened.flatMap((url) => canonicalDomain(url) ?? []);
  const matchedResultOpened = direct.some((match) => opened.includes(match.url));
  const candidateOpened = candidateDomains(candidate).some((domain) => openedDomains.includes(domain));
  const basis = relationship === "direct_result"
    ? matchedResultOpened || candidateOpened ? "returned_and_opened" : "returned_not_opened"
    : relationship === "mentioned_result"
      ? "mentioned_only"
      : relationship === "not_observed"
        ? "not_observed"
        : "unknown";

  return {
    agent: trial.agent,
    repetition: trial.repetition,
    recommendation: candidate.name,
    relationship,
    basis,
    ownedDomainRank,
    mentionRank,
    bestEvidenceRank,
    openedPages: opened,
    answerCitations: citations,
  };
}
