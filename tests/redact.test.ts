import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "../src/redact.js";

describe("redaction", () => {
  it("removes exact secrets, authorization values, and secret URL parameters", () => {
    const secret = "super-secret-value";
    const output = redactText(`Authorization: Bearer ${secret}\nhttps://x.test?a=1&api_key=${secret}\nsk-test-token-123456789`, [secret]);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("sk-test-token");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts credential-shaped object fields even when their values were not configured", () => {
    expect(redactValue({ api_key: "unexpected-value", nested: { authorization: "Bearer value", safe: "visible" } })).toEqual({
      api_key: "[REDACTED]",
      nested: { authorization: "[REDACTED]", safe: "visible" },
    });
  });

  it("does not corrupt ordinary API URL slugs", () => {
    const url = "https://example.test/best-api-providers/audio-api-models";
    expect(redactText(url)).toBe(url);
  });
});
