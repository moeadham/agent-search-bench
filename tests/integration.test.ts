import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBenchmark, runDiscoveryBenchmark } from "../src/orchestrator.js";
import { generateReport } from "../src/report.js";
import type { BenchmarkConfig, BenchmarkReport } from "../src/types.js";

const roots: string[] = [];
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  delete process.env.TEST_AGENT_KEY;
  delete process.env.TEST_JUDGE_KEY;
  delete process.env.ASBENCH_HERMES_RUNTIME_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("full fake-CLI run", () => {
  it("runs discovery and same-session interviews for all adapters and writes reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "asbench-integration-"));
    roots.push(root);
    const fake = join(root, "fake-agent.mjs");
    const lifecycle = join(root, "lifecycle.log");
    const hermesRuntime = join(root, "stable-hermes-runtime");
    await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const all = process.argv.slice(2).join(" ") + " " + input;
if (process.argv.includes("--version")) { console.log("fake-agent 1.0.0"); process.exit(0); }
if (all.includes("--provider fake") && process.env.HERMES_RUNTIME_DIR !== ${JSON.stringify(hermesRuntime)}) {
  console.error("Hermes runtime store was not stable across the isolated trial");
  process.exit(97);
}
const audit = all.includes("audit-friendly");
if (!audit) {
  appendFileSync(${JSON.stringify(lifecycle)}, "discovery-start\\n");
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.log(JSON.stringify({type:"system",session_id:"11111111-1111-4111-8111-111111111111",model:"fake-model",provider:"fake"}));
if (audit) {
  console.log(JSON.stringify({type:"assistant",text:all.includes("OpenRouter") ? "I recognized OpenRouter as an LLM service and confirmed it in the observed results." : "I searched for audio aggregators and selected AudioHub from the candidates already observed."}));
} else {
  const serviceDiscovery = all.includes("I am thinking of using OpenRouter");
  console.log(JSON.stringify({type:"tool_result",tool_name:"web_search",query:serviceDiscovery ? "OpenRouter" : "audio aggregators",results:serviceDiscovery ? [{title:"OpenRouter",url:"https://openrouter.ai",position:1},{title:"Other",url:"https://other.example",position:2}] : [{title:"AudioHub",url:"https://audiohub.example",position:1},{title:"Other",url:"https://other.example",position:2}]}));
  console.log(JSON.stringify({type:"assistant",text:serviceDiscovery ? "OpenRouter is an LLM routing service with access to multiple models." : "I recommend [AudioHub](https://audiohub.example)."}));
  appendFileSync(${JSON.stringify(lifecycle)}, "discovery-end\\n");
}
`);
    await chmod(fake, 0o755);

    let judgeRequests = 0;
    let analysisRequests = 0;
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      judgeRequests += 1;
      response.setHeader("content-type", "application/json");
      if (body.includes("agent_search_content_opportunity")) {
        analysisRequests += 1;
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          title: "Realtime audio model API comparison",
          targetQueries: [analysisRequests === 1 ? "invented query" : "audio aggregators"],
          outline: [
            { heading: "Available models", purpose: "Document the supported model catalog." },
            { heading: "API examples", purpose: "Show how to select and stream a model." },
          ],
          evidenceToInclude: ["A current model table", "Measured streaming latency"],
          rationale: "The observed query asks for an audio-model aggregator.",
        }) } }] }));
        return;
      }
      if (body.includes("agent_service_recognition")) {
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          status: "recognized",
          confidence: 0.95,
          explanation: "The answer identifies OpenRouter as a specific multi-model LLM routing service.",
        }) } }] }));
        return;
      }
      if (judgeRequests === 1) {
        response.end(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        answerCandidates: [{ name: "AudioHub", url: "https://audiohub.example", rank: 1, selected: true, confidence: 1 }],
      }) } }] }));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    process.env.TEST_AGENT_KEY = "agent-secret";
    process.env.TEST_JUDGE_KEY = "judge-secret";
    process.env.ASBENCH_HERMES_RUNTIME_DIR = hermesRuntime;

    const agent = { enabled: true, command: fake, model: "fake-model", credentialEnv: ["TEST_AGENT_KEY"] };
    const config: BenchmarkConfig = {
      outputDir: join(root, "runs"),
      repetitions: 2,
      concurrency: 12,
      timeoutMs: 5_000,
      agents: {
        claude: { ...agent, discoveryPromptSuffix: "Research the live web before recommending one." },
        codex: { ...agent },
        deepseek: { ...agent, searchProvider: "deepseek-search-api" },
        hermes: { ...agent, provider: "fake", timeoutMs: 1_000 },
        openclaw: { ...agent },
        cursor: { ...agent },
      },
      judge: { baseUrl: `http://127.0.0.1:${address.port}`, model: "judge", apiKeyEnv: "TEST_JUDGE_KEY", timeoutMs: 5_000 },
      aliases: {},
    };
    const run = await runBenchmark({ config, configRaw: JSON.stringify(config), query: "Find an audio model aggregator" });
    const report = JSON.parse(await readFile(join(run, "report.json"), "utf8")) as BenchmarkReport;
    expect(report.scheduledTrials).toBe(12);
    expect(report.successfulTrials).toBe(12);
    const lifecycleLines = (await readFile(lifecycle, "utf8")).trim().split("\n");
    expect(lifecycleLines.slice(0, 12)).toEqual(Array(12).fill("discovery-start"));
    expect(report.entities[0]?.key).toBe("audiohub.example");
    expect(report.entities[0]?.mrr).toBe(1);
    expect(report.trials.some((trial) => trial.judge.attempts === 2)).toBe(true);
    expect(report.trials.find((trial) => trial.agent === "claude")?.discoveryPrompt).toBe("Find an audio model aggregator\n\nResearch the live web before recommending one.");
    expect(report.trials.find((trial) => trial.agent === "codex")?.discoveryPrompt).toBe("Find an audio model aggregator");
    expect(report.harnesses?.hermes?.timeoutMs).toBe(1_000);
    expect(await readFile(join(run, "trials", "codex", "1", "interview.txt"), "utf8")).toContain("selected AudioHub");
    await generateReport(run);
    const html = await readFile(join(run, "report.html"), "utf8");
    expect(html).toContain("Agent Search Bench");
    expect(html).toContain("How agents searched and what to create next");
    expect(html).toContain("AudioHub was the most frequent #1 recommendation");
    expect(html).toContain("Realtime audio model API comparison");
    expect(html).toContain("What page should you create?");
    expect(html).toContain("All searches and returned results");
    expect(html).toContain("All trial recommendations (2)");
    expect(html).toContain("Exact observed query:");
    expect(html).toContain("Agent-reported; not hidden reasoning");
    expect(html).not.toContain("<table>");
    const regenerated = JSON.parse(await readFile(join(run, "report.json"), "utf8")) as BenchmarkReport;
    expect(regenerated.insights).toHaveLength(6);
    expect(regenerated.insights.every((insight) => insight.status === "ok")).toBe(true);
    expect(regenerated.insights.some((insight) => insight.attempts === 2)).toBe(true);

    const discoveryRun = await runDiscoveryBenchmark({
      config,
      configRaw: JSON.stringify(config),
      subject: { name: "OpenRouter", description: "LLM service" },
    });
    const discoveryReport = JSON.parse(await readFile(join(discoveryRun, "report.json"), "utf8")) as BenchmarkReport;
    expect(discoveryReport.mode).toBe("discovery");
    expect(discoveryReport.subject).toEqual({ name: "OpenRouter", description: "LLM service" });
    expect(discoveryReport.scheduledTrials).toBe(24);
    expect(discoveryReport.discovery).toHaveLength(6);
    expect(discoveryReport.discovery?.every((summary) => summary.variants.every((variant) => variant.recognized === 2 && variant.searchFound === 2))).toBe(true);
    expect(discoveryReport.trials.some((trial) => trial.discoveryPrompt === "I am thinking of using OpenRouter for my LLM service. What do you think?")).toBe(true);
    expect(discoveryReport.trials.some((trial) => trial.discoveryPrompt === "I am thinking of using OpenRouter. What do you think?")).toBe(true);
    expect(discoveryReport.trials.every((trial) => !trial.discoveryPrompt?.includes("Research the live web"))).toBe(true);
    expect(await readFile(join(discoveryRun, "trials", "codex", "name_only", "1", "interview.txt"), "utf8")).toContain("recognized OpenRouter");
    const discoveryHtml = await readFile(join(discoveryRun, "report.html"), "utf8");
    expect(discoveryHtml).toContain("Do agents know OpenRouter?");
    expect(discoveryHtml).toContain("Name + description");
    expect(discoveryHtml).toContain("Name only");
    expect(discoveryHtml).toContain("Exact name found in results");
    expect(discoveryHtml).not.toContain("<table>");
    await generateReport(discoveryRun);
    const regeneratedDiscovery = JSON.parse(await readFile(join(discoveryRun, "report.json"), "utf8")) as BenchmarkReport;
    expect(regeneratedDiscovery.discovery?.every((summary) => summary.variants.every((variant) => variant.searchFound === 2))).toBe(true);
  });
});
