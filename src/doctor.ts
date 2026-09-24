import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { adapters } from "./adapters/index.js";
import { AGENT_IDS, type AgentId } from "./constants.js";
import { parseTurn } from "./evidence.js";
import { judgeTrial } from "./judge.js";
import { runProcess } from "./process.js";
import { redactText } from "./redact.js";
import { resolveSecrets, safeBaseEnv } from "./secrets.js";
import type { BenchmarkConfig } from "./types.js";

export interface DoctorCheck { name: string; ok: boolean; detail: string; }

export async function doctor(config: BenchmarkConfig, live = false): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const id of AGENT_IDS) {
    const agent = config.agents[id];
    if (!agent.enabled) {
      checks.push({ name: `${id}: enabled`, ok: true, detail: "disabled" });
      continue;
    }
    try {
      const version = await runProcess(adapters[id].version(agent), { cwd: process.cwd(), timeoutMs: 15_000, env: safeBaseEnv() });
      checks.push({ name: `${id}: binary`, ok: version.exitCode === 0, detail: (version.stdout || version.stderr).trim().split("\n")[0] || `exit ${version.exitCode}` });
    } catch (error) {
      checks.push({ name: `${id}: binary`, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    const secrets = await resolveSecrets(agent.credentialEnv);
    checks.push({ name: `${id}: credentials`, ok: secrets.missing.length === 0, detail: secrets.missing.length ? `missing ${secrets.missing.join(", ")}` : "available" });
    checks.push({ name: `${id}: model pin`, ok: Boolean(agent.model && !/CHOOSE_|REPLACE_ME/.test(agent.model)), detail: agent.model });
    checks.push({ name: `${id}: search`, ok: true, detail: agent.searchBackend ?? "native/default (verified only by --live)" });
    if (live && !secrets.missing.length) checks.push(await liveCheck(id, config));
  }
  const judgeSecret = await resolveSecrets([config.judge.apiKeyEnv]);
  checks.push({ name: "judge: credentials", ok: judgeSecret.missing.length === 0, detail: judgeSecret.missing.length ? `missing ${config.judge.apiKeyEnv}` : "available" });
  checks.push({ name: "judge: model", ok: Boolean(config.judge.model), detail: config.judge.model });
  if (live && !judgeSecret.missing.length) {
    const judged = await judgeTrial({
      config: config.judge,
      query: "Find the official Example Domain provider.",
      discovery: { finalText: "I selected [Example Domain](https://example.com).", usage: null, costUsd: null, tools: [] },
      interview: { finalText: "No search tool trace was available; the selected URL was https://example.com.", usage: null, costUsd: null, tools: [] },
      aliases: config.aliases,
    });
    checks.push({ name: "judge: live", ok: judged.status === "ok", detail: judged.status === "ok" ? "completed" : judged.error ?? judged.status });
  }
  return checks;
}

async function liveCheck(id: AgentId, config: BenchmarkConfig): Promise<DoctorCheck> {
  const root = await mkdtemp(join(tmpdir(), `asbench-doctor-${id}-`));
  const homeDir = join(root, "home");
  const workDir = join(root, "work");
  await mkdir(homeDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  try {
    const agent = config.agents[id];
    if (id === "codex") await mkdir(join(homeDir, ".codex"), { recursive: true });
    if (id === "claude") await mkdir(join(homeDir, ".claude"), { recursive: true });
    if (id === "hermes") {
      const stateDir = join(homeDir, ".hermes");
      await mkdir(stateDir, { recursive: true });
      if (agent.searchProvider) {
        await writeFile(join(stateDir, "config.yaml"), `${JSON.stringify({
          web: { backend: agent.searchProvider },
        }, null, 2)}\n`, { mode: 0o600 });
      }
    }
    if (id === "openclaw") {
      const stateDir = join(homeDir, ".openclaw");
      const template = process.env.ASBENCH_OPENCLAW_TEMPLATE;
      if (template) await cp(template, stateDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      const pluginPath = process.env.ASBENCH_OPENCLAW_PLUGIN_PATH;
      const searchProvider = agent.searchProvider;
      await writeFile(join(stateDir, "openclaw.json"), `${JSON.stringify({
        plugins: {
          ...(pluginPath ? { load: { paths: [pluginPath] } } : {}),
          ...(searchProvider ? {
            allow: [searchProvider],
            entries: { [searchProvider]: { enabled: true } },
          } : {}),
        },
        tools: { web: { search: { enabled: true, ...(searchProvider ? { provider: searchProvider } : {}) } } },
      }, null, 2)}\n`, { mode: 0o600 });
    }
    const secrets = await resolveSecrets(agent.credentialEnv);
    const spec = adapters[id].discovery({ config: agent, homeDir, workDir, sessionKey: randomUUID() }, "Use web search to find the official homepage for Example Domain and return its URL.");
    const result = await runProcess(spec, { cwd: workDir, timeoutMs: config.timeoutMs, env: { ...safeBaseEnv(), HOME: homeDir, ...secrets.env } });
    const evidence = parseTurn(result.events, result.stdout, "discovery");
    const searchFailure = /(?:web[_ -]?search is disabled|web[_ -]?search failed|no (?:web[_ -]?search )?provider is available)/i.test(`${result.stderr}\n${result.stdout}`);
    const ok = result.exitCode === 0 && evidence.finalText.length > 0 && !searchFailure;
    const diagnostic = redactText((result.stderr || result.stdout).trim().slice(0, 500), secrets.values);
    return { name: `${id}: live search`, ok, detail: ok ? "completed" : searchFailure ? "search tool unavailable" : `exit ${result.exitCode}${diagnostic ? `: ${diagnostic}` : ""}` };
  } catch (error) {
    return { name: `${id}: live search`, ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
