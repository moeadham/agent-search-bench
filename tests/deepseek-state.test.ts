import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deepSeekStatePatch } from "../src/deepseek-state.js";

describe("DeepSeek state configuration", () => {
  it("mounts JSONL session persistence at the isolated state directory", () => {
    const stateDir = "/tmp/private-home/.dsh";
    const patch = deepSeekStatePatch({
      enabled: true,
      command: "dsh",
      model: "deepseek-chat",
      credentialEnv: ["DEEPSEEK_API_KEY"],
      searchProvider: "deepseek-search-api",
    }, stateDir);

    expect(patch).toContainEqual({
      id: "session-persistence-jsonl",
      config: {
        root: join(stateDir, "sessions"),
        compression: "none",
      },
    });
  });
});
