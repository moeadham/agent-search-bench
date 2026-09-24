import { describe, expect, it } from "vitest";
import { extractAnswerCandidates, parseTurn } from "../src/evidence.js";

describe("evidence parsing", () => {
  it("extracts sessions, final text, and observable search results while ignoring unknown fields", () => {
    const events = [
      { type: "system", session_id: "session-1", model: "model-a", future_field: { anything: true } },
      {
        type: "tool_result",
        tool_name: "web_search",
        query: "audio model aggregators",
        results: [
          { title: "Provider A", url: "https://www.provider-a.example/models", position: 1 },
          { title: "Provider B", url: "https://provider-b.example", position: 2 },
        ],
      },
      { type: "assistant", text: "Choose [Provider A](https://provider-a.example)." },
    ];
    const parsed = parseTurn(events, events.map(JSON.stringify).join("\n"), "discovery");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.resolvedModel).toBe("model-a");
    expect(parsed.finalText).toContain("Provider A");
    expect(parsed.tools[0]?.results).toHaveLength(2);
    expect(parsed.tools[0]?.results[0]?.domain).toBe("provider-a.example");
  });

  it("extracts ordered answer candidates and applies aliases", () => {
    const result = extractAnswerCandidates(
      "Try [Acme Audio](https://www.acme.example/audio), then https://other.example.",
      { "acme.example": "acme" },
    );
    expect(result.map((candidate) => candidate.key)).toEqual(["acme", "other.example"]);
    expect(result[0]?.selected).toBe(true);
  });

  it("parses OpenClaw's JSON envelope and records summarized tools as unobservable", () => {
    const parsed = parseTurn([{
      final: "Choose Provider A",
      sessionId: "openclaw-session",
      model: "model-a",
      provider: "openrouter",
      toolSummary: { calls: 2, tools: ["web_search", "web_fetch"] },
    }], "", "discovery");
    expect(parsed.sessionId).toBe("openclaw-session");
    expect(parsed.finalText).toBe("Choose Provider A");
    expect(parsed.tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
    expect(parsed.tools.every((tool) => tool.rawObservable === false)).toBe(true);
  });

  it("does not mistake Claude's advertised capability list for tool calls", () => {
    const parsed = parseTurn([{ type: "system", session_id: "s", tools: ["WebSearch", "WebFetch", "Read"] }], "", "discovery");
    expect(parsed.tools).toEqual([]);
  });

  it("preserves each exact Codex hosted-search query without inventing results", () => {
    const parsed = parseTurn([{
      type: "item.completed",
      item: {
        id: "search-1",
        type: "web_search",
        query: "audio model API",
        action: { type: "search", queries: ["audio model API", "speech model aggregator"] },
      },
    }], "", "discovery");
    expect(parsed.tools.map((tool) => tool.query)).toEqual(["audio model API", "speech model aggregator"]);
    expect(parsed.tools.every((tool) => tool.results.length === 0 && tool.rawObservable === false)).toBe(true);
  });

  it("joins an OpenClaw trajectory call and Brave result payload", () => {
    const parsed = parseTurn([
      { type: "tool.call", toolName: "web_search", toolCallId: "c1", arguments: { query: "audio aggregators" } },
      {
        type: "transcript.message",
        message: {
          role: "toolResult",
          toolName: "web_search",
          toolCallId: "c1",
          details: {
            kind: "results",
            provider: "brave",
            query: "audio aggregators",
            results: [
              { title: "First", url: "https://first.example", snippet: "One" },
              { title: "Second", url: "https://second.example", snippet: "Two" },
            ],
          },
        },
      },
    ], "", "discovery");
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]?.input).toEqual({ query: "audio aggregators" });
    expect(parsed.tools[0]?.provider).toBe("brave");
    expect(parsed.tools[0]?.results.map((result) => result.name)).toEqual(["First", "Second"]);
  });

  it("parses OpenClaw trajectory schema v1 runtime tool events", () => {
    const parsed = parseTurn([
      { source: "runtime", type: "tool.call", data: { toolCallId: "oc-1", name: "web_search", args: { query: "realtime audio router", count: 2 } } },
      { source: "runtime", type: "tool.result", data: { toolCallId: "oc-1", name: "web_search", result: { details: { provider: "brave", query: "realtime audio router", results: [{ title: "One", url: "https://one.example" }, { title: "Two", url: "https://two.example" }] } } } },
    ], "", "discovery");
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]).toMatchObject({ name: "web_search", query: "realtime audio router", provider: "brave", callId: "oc-1" });
    expect(parsed.tools[0]?.results.map((result) => result.url)).toEqual(["https://one.example", "https://two.example"]);
  });
});
