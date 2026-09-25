import { describe, expect, it } from "vitest";
import { buildTrialJourney } from "../src/report-evidence.js";
import { renderHtml } from "../src/report.js";
import type { BenchmarkReport, TrialResult } from "../src/types.js";

function trial(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    schemaVersion: "1.0.0",
    agent: "openclaw",
    repetition: 1,
    scheduled: true,
    success: true,
    modelPin: "model",
    discoveryPrompt: "find a provider",
    discovery: {
      finalText: "Choose [Acme](https://acme.example/product).",
      usage: null,
      costUsd: null,
      tools: [{
        name: "web_search",
        phase: "discovery",
        query: "best provider",
        rawObservable: true,
        results: [
          { name: "A comparison of Acme and others", url: "https://review.example/acme", domain: "review.example", rank: 1, snippet: "Acme offers realtime streaming." },
          { name: "Acme API", url: "https://acme.example/docs", domain: "acme.example", rank: 2 },
        ],
      }, {
        name: "web_fetch",
        phase: "discovery",
        input: { url: "https://acme.example/docs" },
        rawObservable: true,
        results: [],
      }],
    },
    interview: { finalText: "I selected Acme because it matched the request.", usage: null, costUsd: null, tools: [] },
    interviewPerformedNewResearch: false,
    answerCandidates: [{ key: "acme.example", name: "Acme", url: "https://acme.example", domain: "acme.example", rank: 1, selected: true, confidence: 1, source: "judge" }],
    judge: { status: "ok", attempts: 1 },
    timing: { discoveryMs: 10, interviewMs: 5, totalMs: 15 },
    ...overrides,
  };
}

describe("actionable report evidence", () => {
  it("distinguishes owned-domain, mention, opening, and citation evidence", () => {
    const journey = buildTrialJourney(trial(), {});
    expect(journey.relationship).toBe("direct_result");
    expect(journey.basis).toBe("returned_and_opened");
    expect(journey.ownedDomainRank).toMatchObject({ search: 1, rank: 2 });
    expect(journey.mentionRank).toMatchObject({ search: 1, rank: 1 });
    expect(journey.bestEvidenceRank).toMatchObject({ search: 1, rank: 1 });
    expect(journey.openedPages).toEqual(["https://acme.example/docs"]);
    expect(journey.answerCitations).toEqual(["https://acme.example/product"]);
  });

  it.each([
    ["mentioned_result", true, "A comparison of Acme", "Acme is discussed here"],
    ["not_observed", true, "Other provider", "Nothing relevant"],
    ["unknown", false, "Other provider", "Nothing relevant"],
  ] as const)("classifies %s evidence", (relationship, rawObservable, name, snippet) => {
    const base = trial();
    const changed = trial({
      discovery: {
        ...base.discovery,
        tools: [{
          name: "web_search",
          phase: "discovery",
          query: "best provider",
          rawObservable,
          results: rawObservable ? [{ name, snippet, url: "https://review.example/item", domain: "review.example", rank: 3 }] : [],
        }],
      },
    });
    expect(buildTrialJourney(changed, {}).relationship).toBe(relationship);
  });

  it("escapes untrusted content and does not create unsafe links", () => {
    const unsafe = trial({
      discoveryPrompt: "<script>alert(1)</script>",
      discovery: {
        ...trial().discovery,
        finalText: "javascript:alert(1)",
      },
    });
    const journey = buildTrialJourney(unsafe, {});
    const report: BenchmarkReport = {
      schemaVersion: "1.0.0",
      runId: "run",
      query: "<script>alert(1)</script>",
      generatedAt: new Date(0).toISOString(),
      scheduledTrials: 1,
      successfulTrials: 1,
      harnesses: { openclaw: { enabled: true, command: "openclaw", modelPin: "model" } },
      entities: [],
      agents: [{ agent: "openclaw", scheduled: 1, successful: 1, successRate: 1, meanQualityScore: null, candidateSetStability: null, selectionAgreement: 1 }],
      trials: [unsafe],
      journeys: [journey],
      insights: [],
    };
    const html = renderHtml(report);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('href="javascript:');
  });

  it("renders searches, recommendations, and agent explanations as readable rows", () => {
    const sample = trial({
      interview: {
        finalText: "## Selection\n\n**Acme** was selected.\n\n- Fast streaming\n- See [its docs](https://acme.example/docs)\n\n1. First criterion\n2. Second criterion",
        usage: null,
        costUsd: null,
        tools: [],
      },
    });
    const report: BenchmarkReport = {
      schemaVersion: "1.0.0",
      runId: "run",
      query: "find a provider",
      generatedAt: new Date(0).toISOString(),
      scheduledTrials: 1,
      successfulTrials: 1,
      harnesses: { openclaw: { enabled: true, command: "openclaw", modelPin: "model" } },
      entities: [],
      agents: [{ agent: "openclaw", scheduled: 1, successful: 1, successRate: 1, meanQualityScore: null, candidateSetStability: null, selectionAgreement: 1 }],
      trials: [sample],
      journeys: [buildTrialJourney(sample, {})],
      insights: [{
        agent: "openclaw",
        status: "ok",
        attempts: 1,
        suggestion: {
          title: "Realtime provider comparison",
          targetQueries: ["best provider"],
          outline: [{ heading: "Comparison", purpose: "Compare the returned candidates." }],
          evidenceToInclude: ["Latency"],
          rationale: "Matches the query agents actually used.",
        },
      }],
    };
    const html = renderHtml(report);
    expect(html).toContain("What page should you create?");
    expect(html).toContain("All searches and returned results (1)");
    expect(html).toContain("All trial recommendations (1)");
    expect(html).toContain("<h5>Selection</h5>");
    expect(html).toContain("<strong>Acme</strong> was selected.");
    expect(html).toContain("<ul><li>Fast streaming</li>");
    expect(html).toContain('<a href="https://acme.example/docs"');
    expect(html).not.toContain("## Selection");
    expect(html).not.toContain("<table>");
  });
});
