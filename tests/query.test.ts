import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readQuery } from "../src/orchestrator.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("discovery input", () => {
  it("passes query-file contents verbatim after validating that they are non-empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "asbench-query-"));
    roots.push(root);
    const path = join(root, "prompt.txt");
    const prompt = "  Find a provider.\nKeep this newline.\n";
    await writeFile(path, prompt);
    expect(await readQuery({ queryFile: path })).toBe(prompt);
    expect(await readFile(path, "utf8")).toBe(prompt);
  });
});
