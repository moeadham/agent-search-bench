import { SCHEMA_VERSION, type AgentId } from "./constants.js";
import { buildTrialJourney } from "./report-evidence.js";
import type { AgentSummary, BenchmarkReport, EntityMetric, HarnessInsight, TrialResult } from "./types.js";

function normalizedEntityName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function reconcileNameOnlyCandidates(trials: TrialResult[]): TrialResult[] {
  const domainsByName = new Map<string, Set<string>>();
  for (const trial of trials) {
    for (const candidate of trial.answerCandidates) {
      if (!candidate.domain) continue;
      const name = normalizedEntityName(candidate.name);
      const keys = domainsByName.get(name) ?? new Set<string>();
      keys.add(candidate.key);
      domainsByName.set(name, keys);
    }
  }
  return trials.map((trial) => ({
    ...trial,
    answerCandidates: trial.answerCandidates.map((candidate) => {
      if (candidate.domain) return candidate;
      const keys = domainsByName.get(normalizedEntityName(candidate.name));
      const key = keys?.size === 1 ? [...keys][0] : undefined;
      return key ? { ...candidate, key } : candidate;
    }),
  }));
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pairwiseJaccard(sets: Set<string>[]): number | null {
  if (sets.length < 2) return null;
  const values: number[] = [];
  for (let left = 0; left < sets.length; left++) {
    for (let right = left + 1; right < sets.length; right++) {
      const a = sets[left];
      const b = sets[right];
      if (!a || !b) continue;
      const union = new Set([...a, ...b]);
      const intersection = [...a].filter((value) => b.has(value));
      values.push(union.size ? intersection.length / union.size : 1);
    }
  }
  return mean(values);
}

export function buildReport(runId: string, query: string, trials: TrialResult[], aliases: Record<string, string> = {}, insights: HarnessInsight[] = []): BenchmarkReport {
  const reconciledTrials = reconcileNameOnlyCandidates(trials);
  const scheduled = reconciledTrials.length;
  const successful = reconciledTrials.filter((trial) => trial.success);
  const entityMap = new Map<string, EntityMetric & { rankSum: number; searchReciprocalSum: number }>();

  for (const trial of reconciledTrials) {
    const seen = new Set<string>();
    for (const candidate of [...trial.answerCandidates].sort((a, b) => a.rank - b.rank)) {
      if (seen.has(candidate.key)) continue;
      seen.add(candidate.key);
      const metric = entityMap.get(candidate.key) ?? {
        key: candidate.key,
        name: candidate.name,
        ...(candidate.domain ? { domain: candidate.domain } : {}),
        mentions: 0,
        selections: 0,
        firstMentions: 0,
        discoveryRate: 0,
        selectionShare: 0,
        firstMentionShare: 0,
        mrr: 0,
        successConditionedMrr: 0,
        averageRank: null,
        searchExposureMrr: 0,
        rankSum: 0,
        searchReciprocalSum: 0,
      };
      metric.mentions += 1;
      metric.rankSum += candidate.rank;
      if (candidate.rank === 1) metric.firstMentions += 1;
      if (candidate.selected) metric.selections += 1;
      metric.mrr += 1 / candidate.rank;
      entityMap.set(candidate.key, metric);
    }
    const searchSeen = new Set<string>();
    for (const tool of trial.discovery.tools) {
      for (const item of tool.results) {
        const key = aliases[item.domain] ?? item.domain;
        if (searchSeen.has(key)) continue;
        searchSeen.add(key);
        const metric = entityMap.get(key) ?? {
          key,
          name: item.name,
          domain: item.domain,
          mentions: 0,
          selections: 0,
          firstMentions: 0,
          discoveryRate: 0,
          selectionShare: 0,
          firstMentionShare: 0,
          mrr: 0,
          successConditionedMrr: 0,
          averageRank: null,
          searchExposureMrr: 0,
          rankSum: 0,
          searchReciprocalSum: 0,
        };
        metric.searchReciprocalSum += 1 / item.rank;
        entityMap.set(key, metric);
      }
    }
  }

  const entities: EntityMetric[] = [...entityMap.values()].map(({ rankSum, searchReciprocalSum, ...metric }) => ({
    ...metric,
    discoveryRate: scheduled ? metric.mentions / scheduled : 0,
    selectionShare: scheduled ? metric.selections / scheduled : 0,
    firstMentionShare: scheduled ? metric.firstMentions / scheduled : 0,
    mrr: scheduled ? metric.mrr / scheduled : 0,
    successConditionedMrr: successful.length ? metric.mrr / successful.length : 0,
    averageRank: metric.mentions ? rankSum / metric.mentions : null,
    searchExposureMrr: scheduled ? searchReciprocalSum / scheduled : 0,
  })).sort((a, b) => b.mrr - a.mrr || b.selectionShare - a.selectionShare || b.discoveryRate - a.discoveryRate || a.key.localeCompare(b.key));

  const agentIds = [...new Set(reconciledTrials.map((trial) => trial.agent))] as AgentId[];
  const agents: AgentSummary[] = agentIds.map((agent) => {
    const rows = reconciledTrials.filter((trial) => trial.agent === agent);
    const completed = rows.filter((trial) => trial.success);
    const selected = completed.flatMap((trial) => trial.answerCandidates.filter((candidate) => candidate.selected).map((candidate) => candidate.key));
    const counts = new Map<string, number>();
    selected.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
    return {
      agent,
      scheduled: rows.length,
      successful: completed.length,
      successRate: rows.length ? completed.length / rows.length : 0,
      meanQualityScore: mean(completed.flatMap((trial) => trial.judge.qualityScore === undefined ? [] : [trial.judge.qualityScore])),
      candidateSetStability: pairwiseJaccard(completed.map((trial) => new Set(trial.answerCandidates.map((candidate) => candidate.key)))),
      selectionAgreement: completed.length ? Math.max(0, ...counts.values()) / completed.length : null,
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    query,
    generatedAt: new Date().toISOString(),
    scheduledTrials: scheduled,
    successfulTrials: successful.length,
    entities,
    agents,
    trials: reconciledTrials,
    journeys: reconciledTrials.map((trial) => buildTrialJourney(trial, aliases)),
    insights,
  };
}
