import { describe, expect, it } from "vitest";
import { buildReport } from "../src/metrics.js";
import type { TrialResult } from "../src/types.js";

function trial(repetition: number, success: boolean, rank?: number, selected = false): TrialResult {
  return {
    schemaVersion: "1",
    agent: "claude",
    repetition,
    scheduled: true,
    success,
    ...(!success ? { failureStage: "discovery" as const, error: "failed" } : {}),
    modelPin: "model",
    discovery: { finalText: success ? "answer" : "", usage: null, costUsd: null, tools: [] },
    interviewPerformedNewResearch: false,
    answerCandidates: rank ? [{ key: "provider.example", name: "Provider", domain: "provider.example", rank, selected, confidence: 1, source: "judge" }] : [],
    judge: { status: success ? "ok" : "skipped", ...(success ? { qualityScore: 3 } : {}), attempts: success ? 1 : 0 },
    timing: { discoveryMs: 1, totalMs: 1 },
  };
}

describe("visibility metrics", () => {
  it("keeps failed trials in the headline denominator", () => {
    const report = buildReport("run", "query", [trial(1, true, 1, true), trial(2, true, 2), trial(3, false)]);
    const entity = report.entities[0];
    expect(entity?.mrr).toBeCloseTo(0.5);
    expect(entity?.successConditionedMrr).toBeCloseTo(0.75);
    expect(entity?.selectionShare).toBeCloseTo(1 / 3);
    expect(report.agents[0]?.successRate).toBeCloseTo(2 / 3);
  });

  it("reconciles a judge's name-only entity with its unique observed domain", () => {
    const withDomain = trial(1, true, 1, true);
    const nameOnly = trial(2, true, 1, true);
    nameOnly.answerCandidates = [{ key: "provider", name: "Provider", rank: 1, selected: true, confidence: 0.8, source: "judge" }];
    const report = buildReport("run", "query", [withDomain, nameOnly]);
    expect(report.entities).toHaveLength(1);
    expect(report.entities[0]?.key).toBe("provider.example");
    expect(report.entities[0]?.mentions).toBe(2);
    expect(report.trials[1]?.answerCandidates[0]?.key).toBe("provider.example");
  });
});
