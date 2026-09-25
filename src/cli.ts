#!/usr/bin/env node
import { Command } from "commander";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createConfigTemplate, DEFAULT_CONFIG_PATH, loadConfig, writeConfig, writeConfigTemplate } from "./config.js";
import { doctor } from "./doctor.js";
import { readQuery, runBenchmark } from "./orchestrator.js";
import { generateReport } from "./report.js";

const program = new Command();
program.name("asbench").description("Benchmark what AI agents search, see, and recommend").version("0.1.0");

program.command("init")
  .description("Create and validate a private configuration")
  .option("-c, --config <path>", "configuration path", DEFAULT_CONFIG_PATH)
  .option("--template", "write placeholders without prompting", false)
  .action(async ({ config, template }: { config: string; template: boolean }) => {
    try {
      if (template || !process.stdin.isTTY || !process.stdout.isTTY) {
        await writeConfigTemplate(config);
        console.log(`Created template ${resolve(config)} with mode 0600.`);
        console.log("Replace every CHOOSE_* value, then run asbench doctor.");
        return;
      }
      const output = createConfigTemplate();
      const prompts = createInterface({ input: process.stdin, output: process.stdout });
      const required = async (label: string, initial = ""): Promise<string> => {
        while (true) {
          const answer = (await prompts.question(`${label}${initial ? ` [${initial}]` : ""}: `)).trim() || initial;
          if (answer) return answer;
        }
      };
      try {
        output.agents.claude.model = await required("Claude model ID");
        output.agents.codex.model = await required("Codex model ID");
        output.agents.hermes.provider = await required("Hermes provider ID");
        output.agents.hermes.model = await required("Hermes model ID");
        output.agents.openclaw.model = await required("OpenClaw provider/model ID");
        output.agents.cursor.model = await required("Cursor model ID");
        output.judge.baseUrl = await required("Independent judge base URL (ending in /v1)");
        output.judge.model = await required("Independent judge model ID");
      } finally {
        prompts.close();
      }
      await writeConfig(config, output);
      await loadConfig(config);
      console.log(`Created ${resolve(config)} with mode 0600.`);
      console.log("Configuration schema and required pins validated. Set credentials, then run asbench doctor.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${resolve(config)} already exists; refusing to overwrite it`);
      throw error;
    }
  });

program.command("doctor")
  .description("Validate binaries, model pins, credentials, and search configuration")
  .option("-c, --config <path>", "configuration path", DEFAULT_CONFIG_PATH)
  .option("--live", "perform paid live web-search checks", false)
  .action(async ({ config: configPath, live }: { config: string; live: boolean }) => {
    const { config } = await loadConfig(configPath);
    const checks = await doctor(config, live);
    for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

program.command("run")
  .description("Run one discovery query across all enabled agents")
  .option("-c, --config <path>", "configuration path", DEFAULT_CONFIG_PATH)
  .option("--query <text>", "discovery prompt")
  .option("--query-file <path>", "read the discovery prompt from a UTF-8 file")
  .action(async (options: { config: string; query?: string; queryFile?: string }) => {
    const loaded = await loadConfig(options.config);
    const query = await readQuery(options);
    const directory = await runBenchmark({ config: loaded.config, configRaw: loaded.raw, query });
    console.log(`Run complete: ${directory}`);
    console.log(`Report: ${resolve(directory, "report.html")}`);
  });

program.command("report")
  .description("Regenerate JSON and HTML reports from captured trial evidence")
  .argument("<run-directory>")
  .action(async (runDirectory: string) => {
    await access(resolve(runDirectory, "manifest.json"));
    const report = await generateReport(runDirectory);
    console.log(`Regenerated report for ${report.runId} (${report.successfulTrials}/${report.scheduledTrials} successful trials).`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
