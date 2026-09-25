import { Container } from "@cloudflare/containers";

interface BenchEnv {
  BENCHMARK_CONTAINER: DurableObjectNamespace<BenchmarkContainer>;
  ARTIFACTS: R2Bucket;
  DEMO_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  CODEX_API_KEY: string;
  OPENROUTER_API_KEY: string;
  FIRECRAWL_API_KEY: string;
  BRAVE_API_KEY: string;
  JUDGE_API_KEY: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunResult {
  runId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  report: unknown;
  elapsedMs: number;
  timeline: RunTimeline;
}

interface ScheduledRun {
  query: string;
  runName: string;
  timeline: RunTimeline;
}

interface RunTimeline {
  requestReceivedAt: string;
  queuedAt: string;
  scheduledCallbackStartedAt?: string;
  containerStartRequestedAt?: string;
  containerEntrypointAt?: string;
  containerEntrypointMarkerError?: string;
  containerStartResolvedAt?: string;
  cleanupStartedAt?: string;
  cleanupCompletedAt?: string;
  benchmarkStartedAt?: string;
  benchmarkCompletedAt?: string;
  artifactPersistenceStartedAt?: string;
  artifactPersistenceCompletedAt?: string;
  containerDestroyStartedAt?: string;
  containerDestroyCompletedAt?: string;
  completedAt?: string;
}

const textDecoder = new TextDecoder();
const runIdPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;
const artifactRunIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const maximumQueryLength = 10_000;
const commandTimeoutMs = 15 * 60 * 1_000;

function markTimeline(
  runName: string,
  timeline: RunTimeline,
  phase: keyof RunTimeline,
): string {
  const at = new Date().toISOString();
  timeline[phase] = at;
  console.log("benchmark_timeline", { runName, phase, at });
  return at;
}

function durationMs(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function timelineDurations(timeline: RunTimeline): Record<string, number | null> {
  return {
    requestToScheduledCallbackMs: durationMs(
      timeline.requestReceivedAt,
      timeline.scheduledCallbackStartedAt,
    ),
    containerStartMs: durationMs(
      timeline.containerStartRequestedAt,
      timeline.containerStartResolvedAt,
    ),
    startRequestToEntrypointMs: durationMs(
      timeline.containerStartRequestedAt,
      timeline.containerEntrypointAt,
    ),
    entrypointToStartResolvedMs: durationMs(
      timeline.containerEntrypointAt,
      timeline.containerStartResolvedAt,
    ),
    cleanupMs: durationMs(timeline.cleanupStartedAt, timeline.cleanupCompletedAt),
    benchmarkMs: durationMs(timeline.benchmarkStartedAt, timeline.benchmarkCompletedAt),
    artifactPersistenceMs: durationMs(
      timeline.artifactPersistenceStartedAt,
      timeline.artifactPersistenceCompletedAt,
    ),
    containerDestroyMs: durationMs(
      timeline.containerDestroyStartedAt,
      timeline.containerDestroyCompletedAt,
    ),
    endToEndMs: durationMs(timeline.requestReceivedAt, timeline.completedAt),
  };
}

export class BenchmarkContainer extends Container<BenchEnv> {
  sleepAfter = "1m";
  entrypoint = ["/app/container-entrypoint.sh"];
  enableInternet = true;

  private get runtime(): globalThis.Container {
    const runtime = this.ctx.container;
    if (!runtime) throw new Error("Cloudflare container runtime is unavailable");
    return runtime;
  }

  private async execute(
    command: string[],
    options: ContainerExecOptions = {},
    timeoutMs = commandTimeoutMs,
  ): Promise<CommandResult> {
    const process = await this.runtime.exec(command, {
      stdout: "pipe",
      stderr: "pipe",
      ...options,
    });
    const timeout = setTimeout(() => process.kill(15), timeoutMs);
    try {
      const output = await process.output();
      return {
        exitCode: output.exitCode,
        stdout: textDecoder.decode(output.stdout),
        stderr: textDecoder.decode(output.stderr),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async writeStatus(runName: string, status: unknown): Promise<void> {
    await this.env.ARTIFACTS.put(
      `${runName}/status.json`,
      JSON.stringify(status, null, 2),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    );
  }

  async queueBenchmark(
    query: string,
    runName: string,
    requestReceivedAt: string,
  ): Promise<void> {
    if (!runIdPattern.test(runName)) throw new Error("Invalid run name");
    const timeline: RunTimeline = {
      requestReceivedAt,
      queuedAt: new Date().toISOString(),
    };
    await this.writeStatus(runName, {
      state: "queued",
      runName,
      timeline,
      durationsMs: timelineDurations(timeline),
    });
    await this.schedule<ScheduledRun>(1, "runScheduledBenchmark", {
      query,
      runName,
      timeline,
    });
  }

  async runScheduledBenchmark(payload: ScheduledRun): Promise<void> {
    const { query, runName, timeline } = payload;
    markTimeline(runName, timeline, "scheduledCallbackStartedAt");
    let result: RunResult | undefined;
    let failure: unknown;
    try {
      await this.writeStatus(runName, {
        state: "running",
        runName,
        timeline,
        durationsMs: timelineDurations(timeline),
      });
      result = await this.runBenchmark(
        query,
        runName,
        containerSecrets(this.env),
        timeline,
      );
    } catch (error) {
      failure = error;
      console.error("scheduled_benchmark_failed", { runName, error });
    }

    markTimeline(runName, timeline, "containerDestroyStartedAt");
    try {
      await this.destroy();
    } catch (stopError) {
      console.error("container_stop_failed", { runName, stopError });
      failure ??= stopError;
    }
    markTimeline(runName, timeline, "containerDestroyCompletedAt");
    markTimeline(runName, timeline, "completedAt");

    if (result) {
      await this.writeStatus(runName, {
        state: "complete",
        runName,
        runId: result.runId,
        exitCode: result.exitCode,
        elapsedMs: result.elapsedMs,
        timeline,
        durationsMs: timelineDurations(timeline),
        artifacts: {
          reportJson: `/runs/${runName}/report.json`,
          reportMarkdown: `/runs/${runName}/report.md`,
          archive: `/runs/${runName}/artifacts.tar.gz`,
        },
      });
    } else {
      try {
        await this.writeStatus(runName, {
          state: "failed",
          runName,
          error: failure instanceof Error ? failure.message : "Benchmark failed",
          timeline,
          durationsMs: timelineDurations(timeline),
        });
      } catch (statusError) {
        console.error("failed_status_write_failed", { runName, statusError });
      }
    }
  }

  private async locateRunId(attempts = 20): Promise<string | undefined> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const directories = await this.execute([
        "find",
        "/runs",
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-type",
        "d",
        "-printf",
        "%f\\n",
      ]);
      const runId = directories.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter((value) => artifactRunIdPattern.test(value))
        .at(-1);
      if (runId) return runId;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return undefined;
  }

  private async persistArtifacts(
    runName: string,
    runId: string,
    timeline: RunTimeline,
  ): Promise<unknown> {
    const manifestPath = `/runs/${runId}/manifest.json`;
    const attachTimeline = await this.execute([
      "node",
      "-e",
      "const fs=require('node:fs');const path=process.argv[1];const manifest=JSON.parse(fs.readFileSync(path,'utf8'));manifest.platformTimeline=JSON.parse(process.argv[2]);fs.writeFileSync(path,JSON.stringify(manifest,null,2)+'\\n');",
      manifestPath,
      JSON.stringify({ timestamps: timeline, durationsMs: timelineDurations(timeline) }),
    ]);
    if (attachTimeline.exitCode !== 0) {
      throw new Error(`Could not attach lifecycle timeline: ${attachTimeline.stderr}`);
    }

    const reportJson = await this.execute(["cat", `/runs/${runId}/report.json`]);
    const reportMarkdown = await this.execute(["cat", `/runs/${runId}/report.md`]);
    if (reportJson.exitCode !== 0 || reportMarkdown.exitCode !== 0) {
      throw new Error("Benchmark did not produce both report files");
    }

    const archivePath = `/tmp/${runName}.tar.gz`;
    const archive = await this.execute([
      "tar",
      "-C",
      "/runs",
      "-czf",
      archivePath,
      runId,
    ]);
    if (archive.exitCode !== 0) {
      throw new Error(`Could not archive run artifacts: ${archive.stderr}`);
    }

    const archiveProcess = await this.runtime.exec(["cat", archivePath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const archiveOutput = await archiveProcess.output();
    if (archiveOutput.exitCode !== 0) {
      throw new Error(`Artifact archive read exited ${archiveOutput.exitCode}`);
    }

    await Promise.all([
      this.env.ARTIFACTS.put(`${runName}/artifacts.tar.gz`, archiveOutput.stdout, {
        httpMetadata: { contentType: "application/gzip" },
      }),
      this.env.ARTIFACTS.put(`${runName}/report.json`, reportJson.stdout, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      }),
      this.env.ARTIFACTS.put(`${runName}/report.md`, reportMarkdown.stdout, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      }),
    ]);
    return JSON.parse(reportJson.stdout) as unknown;
  }

  async runBenchmark(
    query: string,
    runName: string,
    secrets: Record<string, string>,
    timeline: RunTimeline,
  ): Promise<RunResult> {
    if (!runIdPattern.test(runName)) {
      throw new Error("Invalid run name");
    }

    const runtimeEnvironment = {
      ...secrets,
      ASBENCH_CONFIG: "/config/agent-search-bench.config.json",
      ASBENCH_IMAGE_ID: "cloudflare-demo",
      ASBENCH_HERMES_RUNTIME_HOME: "/opt/agent-install/.hermes",
      ASBENCH_HERMES_RUNTIME_DIR: "/opt/agent-install/.hermes/tools",
      ASBENCH_OPENCLAW_PLUGIN_PATH:
        "/opt/openclaw-plugins/brave-package/node_modules/@openclaw/brave-plugin",
      HOME: "/home/node",
      NODE_ENV: "production",
      PATH: "/opt/pnpm:/opt/agent-install/.local/bin:/usr/local/bin:/usr/bin:/bin",
    };
    markTimeline(runName, timeline, "containerStartRequestedAt");
    await this.start({
      envVars: runtimeEnvironment,
      entrypoint: this.entrypoint,
      enableInternet: true,
    }, {
      portToCheck: 8080,
      retries: 1_200,
      waitInterval: 500,
    });
    markTimeline(runName, timeline, "containerStartResolvedAt");
    this.renewActivityTimeout();

    const entrypointMarker = await this.execute(
      ["cat", "/tmp/asbench-container-entrypoint-at"],
      {},
      5_000,
    );
    const entrypointAt = entrypointMarker.stdout.trim();
    if (entrypointMarker.exitCode === 0 && Number.isFinite(Date.parse(entrypointAt))) {
      timeline.containerEntrypointAt = entrypointAt;
      console.log("benchmark_timeline", {
        runName,
        phase: "containerEntrypointAt",
        at: entrypointAt,
      });
    } else {
      timeline.containerEntrypointMarkerError =
        entrypointMarker.stderr.trim() ||
        entrypointMarker.stdout.trim() ||
        `marker read exited ${entrypointMarker.exitCode}`;
      console.warn("benchmark_entrypoint_marker_unavailable", {
        runName,
        error: timeline.containerEntrypointMarkerError,
      });
    }

    markTimeline(runName, timeline, "cleanupStartedAt");
    const cleanup = await this.execute([
      "find",
      "/runs",
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-exec",
      "rm",
      "-rf",
      "--",
      "{}",
      "+",
    ]);
    if (cleanup.exitCode !== 0) {
      throw new Error(`Could not prepare the run directory: ${cleanup.stderr}`);
    }
    markTimeline(runName, timeline, "cleanupCompletedAt");

    const startedAt = Date.now();
    markTimeline(runName, timeline, "benchmarkStartedAt");
    const result = await this.execute(
      ["node", "/app/dist/cli.js", "run", "--query", query],
      { env: runtimeEnvironment },
    );
    markTimeline(runName, timeline, "benchmarkCompletedAt");

    const runId = await this.locateRunId();

    if (!runId) {
      throw new Error(
        `Benchmark produced no run directory (exit ${result.exitCode}): ${result.stderr.slice(0, 2_000)}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `Benchmark command exited ${result.exitCode}: ${result.stderr.slice(-2_000) || result.stdout.slice(-2_000)}`,
      );
    }

    markTimeline(runName, timeline, "artifactPersistenceStartedAt");
    const report = await this.persistArtifacts(runName, runId, timeline);
    markTimeline(runName, timeline, "artifactPersistenceCompletedAt");

    this.renewActivityTimeout();
    return {
      runId,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-4_000),
      stderr: result.stderr.slice(-4_000),
      report,
      elapsedMs: Date.now() - startedAt,
      timeline,
    };
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}

async function isAuthorized(request: Request, env: BenchEnv): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  return timingSafeEqual(authorization.slice(prefix.length), env.DEMO_TOKEN);
}

function objectResponse(object: R2ObjectBody): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");
  return new Response(object.body, { headers });
}

function containerSecrets(env: BenchEnv): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    CODEX_API_KEY: env.CODEX_API_KEY,
    OPENAI_API_KEY: env.CODEX_API_KEY,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    HERMES_PROVIDER_API_KEY: env.OPENROUTER_API_KEY,
    OPENCLAW_PROVIDER_API_KEY: env.OPENROUTER_API_KEY,
    JUDGE_API_KEY: env.JUDGE_API_KEY,
    FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY,
    BRAVE_API_KEY: env.BRAVE_API_KEY,
  };
}

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "agent-search-bench-demo" });
    }

    if (!(await isAuthorized(request, env))) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "POST" && url.pathname === "/runs") {
      const requestReceivedAt = new Date().toISOString();
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > 20_000) return json({ error: "Request too large" }, 413);

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Expected a JSON body" }, 400);
      }
      const query =
        typeof body === "object" && body !== null && "query" in body
          ? (body as { query?: unknown }).query
          : undefined;
      if (
        typeof query !== "string" ||
        query.trim().length === 0 ||
        query.length > maximumQueryLength
      ) {
        return json({ error: "query must be a non-empty string up to 10,000 characters" }, 400);
      }

      const runName = `run-${crypto.randomUUID()}`;
      const container = env.BENCHMARK_CONTAINER.getByName("benchmark-runner");
      try {
        await container.queueBenchmark(query, runName, requestReceivedAt);
        return json({
          state: "queued",
          runName,
          artifacts: {
            status: `/runs/${runName}/status.json`,
            reportJson: `/runs/${runName}/report.json`,
            reportMarkdown: `/runs/${runName}/report.md`,
            archive: `/runs/${runName}/artifacts.tar.gz`,
          },
        }, 202);
      } catch (error) {
        console.error("benchmark_failed", { runName, error });
        return json(
          {
            error: error instanceof Error ? error.message : "Benchmark failed",
            runName,
          },
          500,
        );
      }
    }

    const match = url.pathname.match(
      /^\/runs\/(run-[a-f0-9-]+)\/(status\.json|report\.json|report\.md|artifacts\.tar\.gz)$/,
    );
    if (request.method === "GET" && match) {
      const [, runName, filename] = match;
      const object = await env.ARTIFACTS.get(`${runName}/${filename}`);
      return object ? objectResponse(object) : json({ error: "Not found" }, 404);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<BenchEnv>;
