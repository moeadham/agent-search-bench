import { describe, expect, it } from "vitest";
import { antigravityAdapter } from "../src/adapters/antigravity.js";
import type { AdapterContext } from "../src/adapters/base.js";
import { parseTurn } from "../src/evidence.js";
import { isSearchTool, observedSearches } from "../src/report-evidence.js";

const context: AdapterContext = {
  config: {
    enabled: true,
    command: "agy",
    model: "gemini-3.8-flash-medium",
    provider: "gemini",
    credentialEnv: ["GEMINI_API_KEY"],
  },
  homeDir: "/tmp/agy-home",
  workDir: "/tmp/agy-work",
  sessionKey: "unused-by-antigravity",
};

describe("Antigravity harness", () => {
  it("passes the discovery prompt verbatim and resumes the exact conversation", () => {
    const discovery = antigravityAdapter.discovery(context, "verbatim prompt\n");
    expect(discovery.command).toBe("agy");
    expect(discovery.args).toEqual([
      "-p", "verbatim prompt\n",
      "--output-format", "stream-json",
      "--model", "gemini-3.8-flash-medium",
      "--dangerously-skip-permissions",
    ]);

    const interview = antigravityAdapter.interview(context, "conversation-123", "fixed audit");
    expect(interview.args).toContain("--conversation");
    expect(interview.args[interview.args.indexOf("--conversation") + 1]).toBe("conversation-123");
    expect(interview.args.slice(0, 2)).toEqual(["-p", "fixed audit"]);
  });

  it("preserves native search parameters, ordered output rows, and final response", () => {
    const parsed = parseTurn([
      {
        event: "init",
        conversation_id: "conversation-123",
        init: { model: "gemini-3.8-flash-medium", tools: ["search_web", "read_url_content"] },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conversation-123",
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          tool_name: "search_web",
          tool_info: {
            name: "search_web",
            parameters: { query: "realtime voice AI providers" },
            output: {
              results: [
                { title: "First", url: "https://first.example/voice", snippet: "Realtime voice." },
                { title: "Second", url: "https://second.example/audio", snippet: "Audio APIs." },
              ],
            },
          },
        },
      },
      {
        event: "result",
        result: {
          conversation_id: "conversation-123",
          status: "SUCCESS",
          response: "I recommend [First](https://first.example/voice).\n",
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        },
      },
    ], "", "discovery");

    expect(parsed.sessionId).toBe("conversation-123");
    expect(parsed.resolvedModel).toBe("gemini-3.8-flash-medium");
    expect(parsed.finalText).toContain("I recommend");
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]).toMatchObject({
      name: "search_web",
      query: "realtime voice AI providers",
      input: { query: "realtime voice AI providers" },
      rawObservable: true,
    });
    expect(parsed.tools[0]?.results.map((row) => [row.rank, row.url])).toEqual([
      [1, "https://first.example/voice"],
      [2, "https://second.example/audio"],
    ]);
    expect(isSearchTool(parsed.tools[0]!)).toBe(true);
    expect(observedSearches(parsed.tools)).toEqual(parsed.tools);
  });

  it("does not invent result rows from a synthesized search response", () => {
    const parsed = parseTurn([{
      event: "step_update",
      step_update: {
        step_type: "tool",
        state: "DONE",
        tool_name: "search_web",
        tool_info: {
          name: "search_web",
          parameters: { query: "audio API" },
          output: "Several providers offer audio APIs, including ExampleCo.",
        },
      },
    }], "", "discovery");

    expect(parsed.tools[0]).toMatchObject({
      rawObservable: false,
      results: [],
      responseText: "Several providers offer audio APIs, including ExampleCo.",
    });
  });
});
