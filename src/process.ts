import { spawn } from "node:child_process";
import type { CommandSpec, ProcessResult } from "./types.js";

export async function runProcess(spec: CommandSpec, options: { cwd: string; timeoutMs: number; env: Record<string, string> }): Promise<ProcessResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: { ...options.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const events: unknown[] = [];
      const malformedLines: string[] = [];
      try {
        events.push(JSON.parse(stdout.trim()));
      } catch {
        for (const line of lines) {
          try { events.push(JSON.parse(line)); }
          catch { malformedLines.push(line); }
        }
      }
      const completed = Date.now();
      resolve({
        command: spec.command,
        args: spec.args,
        stdout,
        stderr,
        lines,
        events,
        malformedLines,
        exitCode,
        signal,
        timedOut,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
      });
    });
    if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();
  });
}
