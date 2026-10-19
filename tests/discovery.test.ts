import { describe, expect, it } from "vitest";
import { assessDiscoveryTrial, buildDiscoverySummaries, discoveryPrompts, validateDiscoverySubject } from "../src/discovery.js";
import type { TrialResult } from "../src/types.js";

function trial(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    schemaVersion: "1.0.0",
    agent: "openclaw",
    repetition: 1,
    promptVariant: "name_only",
    scheduled: true,
    success: true,
    modelPin: "model",
    discoveryPrompt: "I am thinking of using OpenRouter. What do you think?",
    discovery: {
      finalText: "OpenRouter is an LLM routing service.",
      usage: null,
      costUsd: null,
      tools: [{
        name: "web_search",
        phase: "discovery",
        query: "OpenRouter",
        rawObservable: true,
        results: [
          { name: "A review", url: "https://review.example/openrouter", domain: "review.example", rank: 1, snippet: "OpenRouter provides access to LLMs." },
          { name: "OpenRouter", url: "https://openrouter.ai", domain: "openrouter.ai", rank: 2 },
        ],
      }],
    },
    interview: { finalText: "I recognized it before searching.", usage: null, costUsd: null, tools: [] },
    interviewPerformedNewResearch: false,
    answerCandidates: [],
    judge: {
      status: "ok",
      attempts: 1,
      recognition: { status: "recognized", confidence: 0.9, explanation: "Specific and consistent identification." },
    },
    timing: { discoveryMs: 1, interviewMs: 1, totalMs: 2 },
    ...overrides,
  };
}

describe("service discovery mode", () => {
  it("creates the two exact prompts requested", () => {
    expect(discoveryPrompts({ name: "OpenRouter", description: "LLM service" })).toEqual([
      { variant: "name_with_description", prompt: "I am thinking of using OpenRouter for my LLM service. What do you think?" },
      { variant: "name_only", prompt: "I am thinking of using OpenRouter. What do you think?" },
    ]);
  });

  it("validates and trims discovery inputs", () => {
    expect(validateDiscoverySubject(" OpenRouter ", " LLM service ")).toEqual({ name: "OpenRouter", description: "LLM service" });
    expect(() => validateDiscoverySubject("", "LLM service")).toThrow("--name");
    expect(() => validateDiscoverySubject("OpenRouter", "")).toThrow("--description");
  });

  it("separates answer recognition from exact-name index evidence", () => {
    const assessment = assessDiscoveryTrial({ name: "OpenRouter", description: "LLM service" }, trial());
    expect(assessment.answerRecognition).toBe("recognized");
    expect(assessment.searchStatus).toBe("found");
    expect(assessment.bestResultRank).toMatchObject({ search: 1, rank: 1 });
    expect(assessment.matchedResults.map((match) => match.matchedField)).toEqual(["snippet", "title"]);
  });

  it.each([
    ["not_found", true, true],
    ["unknown", false, true],
    ["not_searched", null, false],
  ] as const)("classifies %s without inventing missing result rows", (status, rawObservable, includeSearch) => {
    const base = trial();
    const changed = trial({
      discovery: {
        ...base.discovery,
        tools: includeSearch ? [{
          name: "web_search",
          phase: "discovery",
          query: "OpenRouter",
          rawObservable: rawObservable as boolean,
          results: [{ name: "Other", url: "https://other.example", domain: "other.example", rank: 1 }],
        }] : [],
      },
    });
    const assessment = assessDiscoveryTrial({ name: "OpenRouter", description: "LLM service" }, changed);
    expect(assessment.searchStatus).toBe(status);
  });

  it("summarizes each prompt variant independently", () => {
    const contextual = trial({ repetition: 1, promptVariant: "name_with_description" });
    const nameOnly = trial({ repetition: 1, promptVariant: "name_only" });
    const summaries = buildDiscoverySummaries({ name: "OpenRouter", description: "LLM service" }, [contextual, nameOnly]);
    expect(summaries[0]?.variants).toEqual([
      expect.objectContaining({ variant: "name_with_description", scheduled: 1, recognized: 1, searchFound: 1 }),
      expect.objectContaining({ variant: "name_only", scheduled: 1, recognized: 1, searchFound: 1 }),
    ]);
  });
});
