# Agent Search Bench contributor guide

## Product goal

Agent Search Bench helps product and website owners understand how likely AI agents are to discover and recommend them for a specific user request. The unit of analysis is the agent harness, not a generic ranking of websites.

For every harness, the benchmark should make it easy to answer:

1. What exact discovery prompt did the agent receive?
2. Which native search tool/provider did it use, and what exact arguments or queries did it send?
3. What exact, ordered results did the search tool return to the agent?
4. What did the agent recommend, and was that recommendation present in the observed results? At what rank?
5. What selection criteria did the agent report in the fixed same-session audit interview?
6. Which observed results did the agent open or cite on the path to its recommendation?
7. What focused content page could better match the exact searches and result patterns observed for that harness?

The static HTML report should consolidate repeated trials by harness, lead with the actionable finding and content opportunity, and keep detailed evidence in expandable sections. Full raw events and transcripts belong in the evidence artifacts, not in the main narrative.

## Evidence standard

- Label native CLI events and tool payloads as **observed**.
- Label statements from the audit interview as **agent-reported**.
- Do not describe an audit statement as hidden reasoning or chain-of-thought. We measure observable behavior and concise stated justification only.
- Never reconstruct a missing result list from citations, final prose, or the audit. Record it as `Unknown`.
- Preserve exact tool inputs, ordered result rows, and any search-provider synthesis shown to the agent when the native stream exposes them.
- A recommendation may be marked absent from the returned list only when all relevant result payloads are observable. Partial evidence remains `Unknown` unless an observed result matches it.
- Treat additive and unknown event fields as compatible. Preserve the raw redacted event stream as the source of truth.
- The audit must resume the exact discovery session, request no new research, and flag any new tool calls.
- Preserve each product's native agent loop and search stack. Do not replace a harness with a common search API merely to make traces uniform.

## Runtime and safety

- TypeScript/JavaScript is preferred for implementation work.
- Benchmark runs should execute in the container, including cloud demos. The host repository and Docker socket must not be mounted into agent workspaces.
- Start all independent agent/repetition trials through the shared concurrency pool; do not add repetition barriers.
- Read credentials only from environment variables or `*_FILE` paths. Never commit secrets, credential stores, raw authorization headers, or generated run artifacts.
- Redact before writing artifacts and use private filesystem permissions.
- Do not silently retry accepted turns or turn missing telemetry into zero.

## Verification

Run the non-paid checks after changes:

```bash
pnpm test
pnpm typecheck
pnpm typecheck:cloudflare
pnpm build
```

Paid live tests require the explicit `ASBENCH_ENABLE_PAID_E2E=1` gate. Do not start a paid benchmark merely to validate deterministic parsing or reporting changes; replay recorded event artifacts instead.
