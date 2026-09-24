import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBenchmark } from "../src/orchestrator.js";
import { generateReport } from "../src/report.js";
import type { BenchmarkConfig, BenchmarkReport } from "../src/types.js";

const roots: string[] = [];
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  delete process.env.TEST_AGENT_KEY;
  delete process.env.TEST_JUDGE_KEY;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("full fake-CLI run", () => {
  it("runs discovery and same-session interviews for all adapters and writes reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "asbench-integration-"));
    roots.push(root);
    const fake = join(root, "fake-agent.mjs");
    await writeFile(fake, `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
const all = process.argv.slice(2).join(" ") + " " + input;
if (process.argv.includes("--version")) { console.log("fake-agent 1.0.0"); process.exit(0); }
console.log(JSON.stringify({type:"system",session_id:"11111111-1111-4111-8111-111111111111",model:"fake-model",provider:"fake"}));
if (all.includes("audit-friendly")) {
  console.log(JSON.stringify({type:"assistant",text:"I searched for audio aggregators and selected AudioHub from the candidates already observed."}));
} else {
  console.log(JSON.stringify({type:"tool_result",tool_name:"web_search",query:"audio aggregators",results:[{title:"AudioHub",url:"https://audiohub.example",position:1},{title:"Other",url:"https://other.example",position:2}]}));
  console.log(JSON.stringify({type:"assistant",text:"I recommend [AudioHub](https://audiohub.example)."}));
}
`);
    await chmod(fake, 0o755);

    let judgeRequests = 0;
    server = createServer((_request, response) => {
      judgeRequests += 1;
      response.setHeader("content-type", "application/json");
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

    const agent = { enabled: true, command: fake, model: "fake-model", credentialEnv: ["TEST_AGENT_KEY"] };
    const config: BenchmarkConfig = {
      outputDir: join(root, "runs"),
      repetitions: 1,
      concurrency: 5,
      timeoutMs: 5_000,
      agents: {
        claude: { ...agent, discoveryPromptSuffix: "Research the live web before recommending one." },
        codex: { ...agent },
        hermes: { ...agent, provider: "fake" },
        openclaw: { ...agent },
        cursor: { ...agent },
      },
      judge: { baseUrl: `http://127.0.0.1:${address.port}`, model: "judge", apiKeyEnv: "TEST_JUDGE_KEY", timeoutMs: 5_000 },
      aliases: {},
    };
    const run = await runBenchmark({ config, configRaw: JSON.stringify(config), query: "Find an audio model aggregator" });
    const report = JSON.parse(await readFile(join(run, "report.json"), "utf8")) as BenchmarkReport;
    expect(report.scheduledTrials).toBe(5);
    expect(report.successfulTrials).toBe(5);
    expect(report.entities[0]?.key).toBe("audiohub.example");
    expect(report.entities[0]?.mrr).toBe(1);
    expect(report.trials.some((trial) => trial.judge.attempts === 2)).toBe(true);
    expect(report.trials.find((trial) => trial.agent === "claude")?.discoveryPrompt).toBe("Find an audio model aggregator\n\nResearch the live web before recommending one.");
    expect(report.trials.find((trial) => trial.agent === "codex")?.discoveryPrompt).toBe("Find an audio model aggregator");
    expect(await readFile(join(run, "trials", "codex", "1", "interview.txt"), "utf8")).toContain("selected AudioHub");
    await writeFile(join(run, "report.md"), "stale");
    await generateReport(run);
    const markdown = await readFile(join(run, "report.md"), "utf8");
    expect(markdown).toContain("Agent Search Bench");
    expect(markdown).toContain("## Trial summary");
    expect(markdown).toContain("| claude | 1 | 1 | 2 | AudioHub | Yes | #1 in search 1 |");
    expect(markdown).toContain("**#1 recommendation:** AudioHub");
    expect(markdown).toContain("| 1 | [AudioHub](https://audiohub.example) |");
    expect(markdown).toContain("### Discovery prompt sent to this harness");
    expect(markdown).not.toContain("Mean quality");
    expect(markdown).not.toContain("Cross-harness visibility");
  });
});
