import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("process runner", () => {
  it("keeps valid JSONL events and malformed lines separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "asbench-process-"));
    roots.push(root);
    const script = join(root, "fake-agent");
    await writeFile(script, "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"assistant\",\"text\":\"ok\"}' 'not-json'\n");
    await chmod(script, 0o755);
    const result = await runProcess({ command: script, args: [] }, { cwd: root, timeoutMs: 2_000, env: { PATH: process.env.PATH ?? "" } });
    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.malformedLines).toEqual(["not-json"]);
  });

  it("parses one pretty-printed JSON envelope as a single event", async () => {
    const root = await mkdtemp(join(tmpdir(), "asbench-process-"));
    roots.push(root);
    const script = join(root, "fake-agent");
    await writeFile(script, "#!/bin/sh\nprintf '{\\n  \\\"final\\\": \\\"ok\\\",\\n  \\\"sessionId\\\": \\\"session-1\\\"\\n}\\n'\n");
    await chmod(script, 0o755);
    const result = await runProcess({ command: script, args: [] }, { cwd: root, timeoutMs: 2_000, env: { PATH: process.env.PATH ?? "" } });
    expect(result.events).toEqual([{ final: "ok", sessionId: "session-1" }]);
    expect(result.malformedLines).toEqual([]);
  });

  it("terminates a turn at the configured timeout without retrying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "asbench-timeout-"));
    roots.push(root);
    const script = join(root, "slow-agent");
    await writeFile(script, "#!/bin/sh\nsleep 2\n");
    await chmod(script, 0o755);
    const result = await runProcess({ command: script, args: [] }, { cwd: root, timeoutMs: 25, env: { PATH: process.env.PATH ?? "" } });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
  });
});
