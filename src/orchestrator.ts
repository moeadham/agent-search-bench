import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import pLimit from "p-limit";
import { adapters } from "./adapters/index.js";
import type { AdapterContext } from "./adapters/base.js";
import { AGENT_IDS, INTERVIEW_PROMPT, INTERVIEW_PROMPT_VERSION, SCHEMA_VERSION, type AgentId } from "./constants.js";
import { extractAnswerCandidates, interviewDidResearch, parseTurn } from "./evidence.js";
import { judgeTrial } from "./judge.js";
import { runProcess } from "./process.js";
import { redactText, redactValue } from "./redact.js";
import { generateReport } from "./report.js";
import { resolveSecrets, safeBaseEnv } from "./secrets.js";
import type { BenchmarkConfig, ProcessResult, RunManifest, TrialResult, TurnEvidence } from "./types.js";

function slugify(value: string): string {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return slug || "query";
}

async function privateWrite(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
}

async function prepareAgentState(agent: AgentId, config: BenchmarkConfig["agents"][AgentId], homeDir: string): Promise<void> {
  if (agent === "codex") await mkdir(join(homeDir, ".codex"), { recursive: true, mode: 0o700 });
  if (agent === "claude") await mkdir(join(homeDir, ".claude"), { recursive: true, mode: 0o700 });
  if (agent === "hermes") {
    const stateDir = join(homeDir, ".hermes");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    if (config.searchProvider) {
      await privateWrite(join(stateDir, "config.yaml"), `${JSON.stringify({
        web: { backend: config.searchProvider },
      }, null, 2)}\n`);
    }
  }
  if (agent === "openclaw") {
    const stateDir = join(homeDir, ".openclaw");
    const template = process.env.ASBENCH_OPENCLAW_TEMPLATE;
    if (template) await cp(template, stateDir, { recursive: true });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const pluginPath = process.env.ASBENCH_OPENCLAW_PLUGIN_PATH;
    const searchProvider = config.searchProvider;
    await privateWrite(join(stateDir, "openclaw.json"), `${JSON.stringify({
      plugins: {
        ...(pluginPath ? { load: { paths: [pluginPath] } } : {}),
        ...(searchProvider ? {
          allow: [searchProvider],
          entries: { [searchProvider]: { enabled: true } },
        } : {}),
      },
      tools: { web: { search: { enabled: true, ...(searchProvider ? { provider: searchProvider } : {}) } } },
    }, null, 2)}\n`);
  }
}

function eventJsonl(result: ProcessResult, secrets: string[]): string {
  if (result.events.length) return result.events.map((event) => JSON.stringify(redactValue(event, secrets))).join("\n") + "\n";
  return redactText(result.stdout, secrets);
}

async function saveTurn(directory: string, name: "discovery" | "interview", process: ProcessResult, evidence: TurnEvidence, secrets: string[]): Promise<void> {
  await privateWrite(join(directory, `${name}.events.jsonl`), eventJsonl(process, secrets));
  await privateWrite(join(directory, `${name}.txt`), redactText(evidence.finalText, secrets));
  await privateWrite(join(directory, `${name}.stderr.log`), redactText(process.stderr, secrets));
  await privateWrite(join(directory, `${name}.process.json`), `${JSON.stringify(redactValue({
    command: basename(process.command),
    args: process.args.map((arg) => secrets.includes(arg) ? "[REDACTED]" : arg),
    exitCode: process.exitCode,
    signal: process.signal,
    timedOut: process.timedOut,
    startedAt: process.startedAt,
    completedAt: process.completedAt,
    elapsedMs: process.elapsedMs,
    malformedLines: process.malformedLines,
  }, secrets), null, 2)}\n`);
}

function processError(label: string, result: ProcessResult): string {
  if (result.timedOut) return `${label} timed out`;
  return `${label} exited ${result.exitCode ?? result.signal ?? "without status"}: ${result.stderr.trim().slice(0, 500)}`;
}

async function enrichOpenClawTrajectory(input: {
  process: ProcessResult;
  command: string;
  sessionId: string;
  homeDir: string;
  workDir: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<void> {
  const runtimeEnv = {
    OPENCLAW_HOME: input.homeDir,
    OPENCLAW_STATE_DIR: join(input.homeDir, ".openclaw"),
    OPENCLAW_CONFIG_PATH: join(input.homeDir, ".openclaw", "openclaw.json"),
    OPENCLAW_WORKSPACE_DIR: input.workDir,
  };
  try {
    const listing = await runProcess({ command: input.command, args: ["sessions", "--json"], env: runtimeEnv }, {
      cwd: input.workDir, timeoutMs: Math.min(input.timeoutMs, 60_000), env: input.env,
    });
    const root = listing.events.find((event) => typeof event === "object" && event !== null) as { sessions?: Array<{ key?: string; sessionId?: string }> } | undefined;
    const sessionKey = root?.sessions?.find((session) => session.sessionId === input.sessionId)?.key;
    if (!sessionKey) throw new Error(`session key for ${input.sessionId} was not listed`);
    const outputName = "asbench-discovery";
    const exported = await runProcess({
      command: input.command,
      args: ["sessions", "export-trajectory", "--session-key", sessionKey, "--workspace", input.workDir, "--output", outputName, "--json"],
      env: runtimeEnv,
    }, { cwd: input.workDir, timeoutMs: Math.min(input.timeoutMs, 60_000), env: input.env });
    if (exported.exitCode !== 0) throw new Error(processError("trajectory export", exported));
    const jsonl = await readFile(join(input.workDir, ".openclaw", "trajectory-exports", outputName, "events.jsonl"), "utf8");
    for (const line of jsonl.split(/\r?\n/).filter(Boolean)) {
      try { input.process.events.push(JSON.parse(line)); }
      catch { input.process.malformedLines.push(line); }
    }
  } catch (error) {
    input.process.stderr += `\nOpenClaw trajectory unavailable: ${error instanceof Error ? error.message : String(error)}\n`;
  }
}

async function runTrial(input: {
  agent: AgentId;
  repetition: number;
  query: string;
  config: BenchmarkConfig;
  runDirectory: string;
}): Promise<TrialResult> {
  const started = Date.now();
  const agentConfig = input.config.agents[input.agent];
  const discoveryPrompt = agentConfig.discoveryPromptSuffix
    ? `${input.query}\n\n${agentConfig.discoveryPromptSuffix}`
    : input.query;
  const adapter = adapters[input.agent];
  const trialDirectory = join(input.runDirectory, "trials", input.agent, String(input.repetition));
  await mkdir(trialDirectory, { recursive: true, mode: 0o700 });
  const isolatedRoot = await mkdtemp(join(tmpdir(), `asbench-${input.agent}-`));
  const homeDir = join(isolatedRoot, "home");
  const workDir = join(isolatedRoot, "work");
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await prepareAgentState(input.agent, agentConfig, homeDir);
  const resolved = await resolveSecrets(agentConfig.credentialEnv);
  const env = { ...safeBaseEnv(), HOME: homeDir, ...resolved.env };
  const context: AdapterContext = { config: agentConfig, homeDir, workDir, sessionKey: randomUUID() };
  const emptyDiscovery: TurnEvidence = { finalText: "", usage: null, costUsd: null, tools: [] };

  try {
    if (resolved.missing.length) {
      const trial: TrialResult = {
        schemaVersion: SCHEMA_VERSION,
        agent: input.agent,
        repetition: input.repetition,
        scheduled: true,
        success: false,
        failureStage: "setup",
        error: `Missing credentials: ${resolved.missing.join(", ")}`,
        modelPin: agentConfig.model,
        discoveryPrompt,
        discovery: emptyDiscovery,
        interviewPerformedNewResearch: false,
        answerCandidates: [],
        judge: { status: "skipped", error: "Agent setup failed", attempts: 0 },
        timing: { discoveryMs: 0, totalMs: Date.now() - started },
      };
      await privateWrite(join(trialDirectory, "trial.json"), `${JSON.stringify(trial, null, 2)}\n`);
      return trial;
    }

    let discoveryProcess: ProcessResult;
    try {
      discoveryProcess = await runProcess(adapter.discovery(context, discoveryPrompt), { cwd: workDir, timeoutMs: input.config.timeoutMs, env });
    } catch (error) {
      const trial: TrialResult = {
        schemaVersion: SCHEMA_VERSION,
        agent: input.agent,
        repetition: input.repetition,
        scheduled: true,
        success: false,
        failureStage: "discovery",
        error: error instanceof Error ? error.message : String(error),
        modelPin: agentConfig.model,
        discoveryPrompt,
        discovery: emptyDiscovery,
        interviewPerformedNewResearch: false,
        answerCandidates: [],
        judge: { status: "skipped", error: "Discovery failed", attempts: 0 },
        timing: { discoveryMs: Date.now() - started, totalMs: Date.now() - started },
      };
      await privateWrite(join(trialDirectory, "trial.json"), `${JSON.stringify(redactValue(trial, resolved.values), null, 2)}\n`);
      return trial;
    }
    const initialDiscovery = parseTurn(discoveryProcess.events, discoveryProcess.stdout, "discovery");
    if (input.agent === "openclaw" && initialDiscovery.sessionId && discoveryProcess.exitCode === 0 && !discoveryProcess.timedOut) {
      await enrichOpenClawTrajectory({
        process: discoveryProcess,
        command: agentConfig.command,
        sessionId: initialDiscovery.sessionId,
        homeDir,
        workDir,
        env,
        timeoutMs: input.config.timeoutMs,
      });
    }
    const discovery = parseTurn(discoveryProcess.events, discoveryProcess.stdout, "discovery");
    await saveTurn(trialDirectory, "discovery", discoveryProcess, discovery, resolved.values);
    if (discoveryProcess.exitCode !== 0 || discoveryProcess.timedOut || !discovery.finalText) {
      const trial: TrialResult = {
        schemaVersion: SCHEMA_VERSION,
        agent: input.agent,
        repetition: input.repetition,
        scheduled: true,
        success: false,
        failureStage: "discovery",
        error: processError("Discovery", discoveryProcess),
        modelPin: agentConfig.model,
        discoveryPrompt,
        discovery,
        interviewPerformedNewResearch: false,
        answerCandidates: extractAnswerCandidates(discovery.finalText, input.config.aliases),
        judge: { status: "skipped", error: "Discovery failed", attempts: 0 },
        timing: { discoveryMs: discoveryProcess.elapsedMs, totalMs: Date.now() - started },
      };
      await privateWrite(join(trialDirectory, "trial.json"), `${JSON.stringify(redactValue(trial, resolved.values), null, 2)}\n`);
      return trial;
    }

    const sessionId = discovery.sessionId;
    if (!sessionId) {
      const trial: TrialResult = {
        schemaVersion: SCHEMA_VERSION,
        agent: input.agent,
        repetition: input.repetition,
        scheduled: true,
        success: false,
        failureStage: "resume",
        error: "Discovery stream did not expose a session identifier",
        modelPin: agentConfig.model,
        discoveryPrompt,
        discovery,
        interviewPerformedNewResearch: false,
        answerCandidates: extractAnswerCandidates(discovery.finalText, input.config.aliases),
        judge: { status: "skipped", error: "Interview could not resume", attempts: 0 },
        timing: { discoveryMs: discoveryProcess.elapsedMs, totalMs: Date.now() - started },
      };
      await privateWrite(join(trialDirectory, "trial.json"), `${JSON.stringify(redactValue(trial, resolved.values), null, 2)}\n`);
      return trial;
    }

    let interviewProcess: ProcessResult;
    try {
      interviewProcess = await runProcess(adapter.interview(context, sessionId, INTERVIEW_PROMPT), { cwd: workDir, timeoutMs: input.config.timeoutMs, env });
    } catch (error) {
      const local = extractAnswerCandidates(discovery.finalText, input.config.aliases);
      const trial: TrialResult = {
        schemaVersion: SCHEMA_VERSION,
        agent: input.agent,
        repetition: input.repetition,
        scheduled: true,
        success: false,
        failureStage: "interview",
        error: error instanceof Error ? error.message : String(error),
        modelPin: agentConfig.model,
        discoveryPrompt,
        discovery,
        interviewPerformedNewResearch: false,
        answerCandidates: local,
        judge: { status: "skipped", error: "Interview failed", attempts: 0 },
        timing: { discoveryMs: discoveryProcess.elapsedMs, totalMs: Date.now() - started },
      };
      await privateWrite(join(trialDirectory, "trial.json"), `${JSON.stringify(redactValue(trial, resolved.values), null, 2)}\n`);
      return trial;
    }
    const interview = parseTurn(interviewProcess.events, interviewProcess.stdout, "interview");
    await saveTurn(trialDirectory, "interview", interviewProcess, interview, resolved.values);
    const agentSuccess = interviewProcess.exitCode === 0 && !interviewProcess.timedOut && Boolean(interview.finalText);
    const localCandidates = extractAnswerCandidates(discovery.finalText, input.config.aliases);
    const judge = agentSuccess ? await judgeTrial({ config: input.config.judge, query: discoveryPrompt, discovery, interview, aliases: input.config.aliases }) : { status: "skipped" as const, error: "Interview failed", attempts: 0 };
    const candidates = judge.status === "ok" && judge.answerCandidates?.length ? judge.answerCandidates : localCandidates;
    const trial: TrialResult = {
      schemaVersion: SCHEMA_VERSION,
      agent: input.agent,
      repetition: input.repetition,
      scheduled: true,
      success: agentSuccess,
      ...(!agentSuccess ? { failureStage: "interview" as const, error: processError("Interview", interviewProcess) } : {}),
      modelPin: agentConfig.model,
      discoveryPrompt,
      discovery,
      interview,
      interviewPerformedNewResearch: interviewDidResearch(interview),
      answerCandidates: candidates,
      judge,
      timing: { discoveryMs: discoveryProcess.elapsedMs, interviewMs: interviewProcess.elapsedMs, totalMs: Date.now() - started },
    };
    await privateWrite(join(trialDirectory, "trial.json"), `${JSON.stringify(redactValue(trial, resolved.values), null, 2)}\n`);
    return trial;
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

async function gitCommit(): Promise<string | undefined> {
  try {
    const result = await runProcess({ command: "git", args: ["rev-parse", "HEAD"] }, { cwd: process.cwd(), timeoutMs: 5_000, env: safeBaseEnv() });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch { return undefined; }
}

export async function collectVersions(config: BenchmarkConfig): Promise<RunManifest["agents"]> {
  const result: RunManifest["agents"] = {};
  await Promise.all(AGENT_IDS.map(async (id) => {
    const agent = config.agents[id];
    if (!agent.enabled) {
      result[id] = { enabled: false, command: agent.command, modelPin: agent.model };
      return;
    }
    try {
      const version = await runProcess(adapters[id].version(agent), { cwd: process.cwd(), timeoutMs: 15_000, env: safeBaseEnv() });
      const versionText = (version.stdout || version.stderr).trim().split("\n")[0] || "unknown";
      result[id] = {
        enabled: true,
        command: agent.command,
        modelPin: agent.model,
        ...(agent.provider ? { provider: agent.provider } : {}),
        searchBackend: agent.searchBackend ?? "native/default",
        ...(version.exitCode === 0 ? { version: versionText } : { versionError: processError("Version", version) }),
      };
    } catch (error) {
      result[id] = { enabled: true, command: agent.command, modelPin: agent.model, versionError: error instanceof Error ? error.message : String(error) };
    }
  }));
  return result;
}

export async function runBenchmark(input: { config: BenchmarkConfig; configRaw: string; query: string }): Promise<string> {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const queryHash = createHash("sha256").update(input.query).digest("hex").slice(0, 8);
  const runId = `${stamp}-${slugify(input.query)}-${queryHash}`;
  const runDirectory = resolve(input.config.outputDir, runId);
  await mkdir(join(runDirectory, "trials"), { recursive: true, mode: 0o700 });
  const commit = await gitCommit();
  const manifest: RunManifest = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    query: input.query,
    interviewPromptVersion: INTERVIEW_PROMPT_VERSION,
    interviewPrompt: INTERVIEW_PROMPT,
    startedAt: now.toISOString(),
    repetitions: input.config.repetitions,
    concurrency: input.config.concurrency,
    timeoutMs: input.config.timeoutMs,
    configHash: createHash("sha256").update(input.configRaw).digest("hex"),
    aliases: input.config.aliases,
    agentPrompts: Object.fromEntries(AGENT_IDS
      .filter((id) => input.config.agents[id].enabled)
      .map((id) => [id, input.config.agents[id].discoveryPromptSuffix
        ? `${input.query}\n\n${input.config.agents[id].discoveryPromptSuffix}`
        : input.query])) as Partial<Record<AgentId, string>>,
    ...(commit ? { gitCommit: commit } : {}),
    imageIdentity: process.env.ASBENCH_IMAGE_ID ?? "local",
    agents: await collectVersions(input.config),
    judge: { baseUrl: input.config.judge.baseUrl, model: input.config.judge.model },
  };
  await privateWrite(join(runDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const enabled = AGENT_IDS.filter((id) => input.config.agents[id].enabled);
  const limit = pLimit(input.config.concurrency);
  const trials: TrialResult[] = [];
  for (let repetition = 1; repetition <= input.config.repetitions; repetition++) {
    const repetitionTrials = await Promise.all(enabled.map((agent) => limit(() => runTrial({
      agent,
      repetition,
      query: input.query,
      config: input.config,
      runDirectory,
    }))));
    trials.push(...repetitionTrials);
  }
  for (const id of enabled) {
    const agent = manifest.agents[id];
    if (!agent) continue;
    const rows = trials.filter((trial) => trial.agent === id);
    const models = [...new Set(rows.flatMap((trial) => trial.discovery.resolvedModel ? [trial.discovery.resolvedModel] : []))];
    const providers = [...new Set(rows.flatMap((trial) => trial.discovery.resolvedProvider ? [trial.discovery.resolvedProvider] : []))];
    if (models.length) agent.resolvedModels = models;
    if (providers.length) agent.resolvedProviders = providers;
  }
  manifest.completedAt = new Date().toISOString();
  await privateWrite(join(runDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await generateReport(runDirectory);
  return runDirectory;
}

export async function readQuery(options: { query?: string; queryFile?: string }): Promise<string> {
  if ((options.query ? 1 : 0) + (options.queryFile ? 1 : 0) !== 1) throw new Error("Provide exactly one of --query or --query-file");
  const query = options.query ?? await readFile(resolve(options.queryFile as string), "utf8");
  if (!query.trim()) throw new Error("Query must not be empty");
  return query;
}
