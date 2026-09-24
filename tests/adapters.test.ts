import { describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { hermesAdapter } from "../src/adapters/hermes.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import type { AdapterContext } from "../src/adapters/base.js";

function context(command: string): AdapterContext {
  return {
    config: { enabled: true, command, model: "pinned-model", credentialEnv: ["TEST_KEY"] },
    homeDir: "/tmp/private-home",
    workDir: "/tmp/empty-work",
    sessionKey: "11111111-1111-4111-8111-111111111111",
  };
}

describe("agent command contracts", () => {
  it("places Codex's global search flag before the exec subcommand and resumes the exact session", () => {
    const ctx = context("codex");
    expect(codexAdapter.discovery(ctx, "query").args.slice(0, 3)).toEqual(["--search", "exec", "--json"]);
    expect(codexAdapter.interview(ctx, "session-id", "audit").args.slice(0, 5)).toEqual(["--search", "exec", "resume", "session-id", "--json"]);
  });

  it("uses retained OpenClaw state for exec then resumes by returned session id", () => {
    const ctx = context("openclaw");
    const discovery = openclawAdapter.discovery(ctx, "query");
    expect(discovery.args).toContain("--state-dir");
    expect(discovery.args).toContain("--config");
    const interview = openclawAdapter.interview(ctx, "observed-session", "audit");
    expect(interview.args).toContain("observed-session");
    expect(interview.args).toContain("--message");
    expect(interview.stdin).toBeUndefined();
    expect(interview.env?.OPENCLAW_STATE_DIR).toBe("/tmp/private-home/.openclaw");
  });

  it.each([
    ["claude", claudeAdapter, "--resume"],
    ["cursor", cursorAdapter, "--resume"],
    ["hermes", hermesAdapter, "--resume"],
  ] as const)("resumes the exact stream session for %s", (_name, adapter, resumeFlag) => {
    const ctx = context(adapter.id);
    const discovery = adapter.discovery(ctx, "verbatim query\n");
    const interview = adapter.interview(ctx, "exact-session-id", "audit");
    expect(discovery.stdin ?? discovery.args.at(-1)).toBe("verbatim query\n");
    expect(interview.args).toContain(resumeFlag);
    expect(interview.args).toContain("exact-session-id");
  });
});
