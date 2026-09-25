# Agent Search Bench

A TypeScript CLI for comparing agentic web discovery. It runs a base prompt through enabled agent harnesses, interviews each agent in the same session, preserves observable tool evidence, and reports the returned search-result lists and the agent's recommendation. The current deployment enables Claude Code, Codex, Hermes, and OpenClaw; Cursor remains implemented but disabled and is not installed in the image.

The goal is to help product and website owners understand how agents discover and select products for a particular search term—and, ultimately, what improves their visibility. The primary view is therefore organized by agent harness rather than as a generic website leaderboard.

For every harness, the report answers seven questions:

1. What exact prompt did the agent receive?
2. What search tool/provider did it call, with what exact queries or arguments?
3. What exact ordered results came back from that tool?
4. Which result pages did it open or cite?
5. What did the agent recommend, and was its domain returned, mentioned in another result, absent, or unobservable?
6. What reasons did the agent state in the fixed same-session audit interview?
7. What focused content page could better match the exact searches the agent performed?

The evidence boundary is deliberate. Native tool events are labeled **observed**. Audit explanations are labeled **agent-reported** and are not presented as hidden chain-of-thought. If a native CLI does not expose its result payload, the result list and recommendation rank remain `Unknown`; the framework never reconstructs them from the agent's prose.

## Requirements

- Node.js 26+
- pnpm
- The enabled agent CLIs, or Docker
- API credentials for enabled agents and a separate OpenAI-compatible report-analysis model

Current Codex automation uses the global search switch in `codex --search exec --json` and exact-session `exec resume`. For ephemeral API-key authentication, current Codex versions use `CODEX_API_KEY`; you may configure `OPENAI_API_KEY` instead if your installed provider path expects it.

## Setup

```bash
pnpm install
pnpm build
node dist/cli.js init
```

Edit `agent-search-bench.config.json` and replace every `CHOOSE_*` value with an explicit product-specific model/provider. Credential values are never placed in this file. Provide each credential as either an environment variable or a corresponding file variable:

```bash
export ANTHROPIC_API_KEY="..."
export CODEX_API_KEY="..."
export HERMES_PROVIDER_API_KEY="..."
export OPENCLAW_PROVIDER_API_KEY="..."
export FIRECRAWL_API_KEY="..."
export BRAVE_API_KEY="..."
export JUDGE_API_KEY="..."

# Secret-file form is also supported:
export ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic
```

The placeholder Hermes/OpenClaw credential names are intentionally configurable. Change `credentialEnv` to the actual variable used by the selected provider, such as `OPENROUTER_API_KEY`. The report-analysis model extracts the primary recommendation and proposes the captured-evidence-only content opportunity; it must expose an OpenAI-compatible `/chat/completions` endpoint with JSON-schema structured output.

Model and search providers are configured independently. The checked-in deployment pins Hermes search to its documented Firecrawl default (`FIRECRAWL_API_KEY`) and OpenClaw search to the first provider in its auto-detection order, Brave (`BRAVE_API_KEY`). OpenRouter remains the model provider for both agents and for the structured report-analysis step.

An agent may optionally define `discoveryPromptSuffix`. The suffix is appended only for that harness and the exact resulting prompt is retained in every trial and shown in the report. The checked-in deployment adds `Research the live web before recommending one.` for Claude because live testing showed that the unmodified discovery prompt did not reliably trigger Claude's search tool. Other harnesses receive the base query verbatim.

Validate without model charges:

```bash
node dist/cli.js doctor
```

Validate each agent with a real web-search turn (this can incur charges):

```bash
node dist/cli.js doctor --live
```

## Run a benchmark

```bash
node dist/cli.js run --query "Find me a provider that aggregates audio models"
```

For arbitrary shell-sensitive prompts:

```bash
node dist/cli.js run --query-file prompt.txt
```

The default is three fresh repetitions per enabled agent with fifteen-way concurrency and a ten-minute timeout per turn. Every agent/repetition pair is submitted to one concurrency pool with no repetition barriers, so the default five-agent, three-repetition run starts all fifteen independent trials together. Each successful discovery is followed by a fixed audit interview in the same session. Regenerate a report without making model calls:

```bash
node dist/cli.js report runs/<run-id>
```

## Evidence layout

```text
runs/<run-id>/
├── manifest.json
├── report.json
├── report.html
└── trials/<agent>/<repetition>/
    ├── discovery.events.jsonl
    ├── discovery.txt
    ├── discovery.process.json
    ├── discovery.stderr.log
    ├── interview.events.jsonl
    ├── interview.txt
    ├── interview.process.json
    ├── interview.stderr.log
    └── trial.json
```

Artifacts are created with private permissions. Configured secret literals, authorization headers, credential-shaped strings, and sensitive URL parameters are redacted before writing. Raw event files mean raw observable CLI events after mandatory redaction; they are not unredacted credential dumps.

The self-contained HTML report consolidates repeated trials by harness and shows:

- the exact query sent with each search call
- the ordered result rows returned by the search provider
- any search-provider synthesis that the native tool delivered to the agent
- the agent's extracted recommendation
- whether the recommendation's own domain was returned or it was only mentioned in another result
- owned-domain, title/snippet mention, and best-evidence ranks
- pages opened and URLs cited in the answer
- a concise, explicitly agent-reported excerpt explaining the selection
- a captured-evidence-only suggestion for a content page targeting the exact observed searches

Detailed trial evidence uses native expandable sections and requires no JavaScript. `report.json` remains the canonical machine-readable artifact and retains validated content suggestions so HTML regeneration does not make another model call.

If a harness exposes the search call but not its result payload, membership and rank are reported as `Unknown`; the framework does not substitute the agent's self-report. A recommendation is marked absent only when every relevant result payload is observable. The model-assisted extraction step identifies the recommendation in free-form prose; it does not decide observed membership or rank.

Claude's stream exposes ordered native WebSearch results plus the search-tool synthesis shown to the model, and the framework preserves both. Hermes and OpenClaw expose their native result payloads. Codex currently exposes its exact hosted-search calls and queries through `codex exec --json`, but not the complete ordered result payload, so Codex result-list membership remains `Unknown` even when the audit describes candidates.

## Container

Build-time version arguments default to `latest`. Set them to explicit package versions for reproducible images. Hermes uses a configurable installer URL because its official distribution channel is not an npm package.

```bash
docker build \
  --build-arg CLAUDE_VERSION=latest \
  --build-arg CODEX_VERSION=latest \
  --build-arg OPENCLAW_VERSION=latest \
  -t agent-search-bench .

docker compose run --rm asbench doctor
docker compose run --rm asbench run --query "Find me a provider that aggregates audio models"
```

The Compose service is non-root, read-only except for `/tmp`, and mounts only configuration and output—not a source repository or Docker socket. Every run records the actual CLI `--version` output.

## Cloudflare Containers demo

The checked-in Worker runs the same CLI image on a Cloudflare Container and writes reports plus the complete evidence archive to a private R2 bucket. Long benchmarks are queued through the container Durable Object: `POST /runs` returns `202` immediately, while `status.json` reports `queued`, `running`, `complete`, or `failed`.

Create the bucket and configure Worker secrets before the first deployment:

```bash
pnpm exec wrangler r2 bucket create agent-search-bench-demo-runs

pnpm exec wrangler secret put ANTHROPIC_API_KEY
pnpm exec wrangler secret put CODEX_API_KEY
pnpm exec wrangler secret put OPENROUTER_API_KEY
pnpm exec wrangler secret put FIRECRAWL_API_KEY
pnpm exec wrangler secret put BRAVE_API_KEY
pnpm exec wrangler secret put JUDGE_API_KEY
pnpm exec wrangler secret put DEMO_TOKEN

pnpm deploy:cloudflare
```

Start and poll a run with the bearer token stored in `DEMO_TOKEN`:

```bash
curl -X POST https://<worker>.workers.dev/runs \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"query":"find me an api for realtime audio tts but with every model available"}'

curl https://<worker>.workers.dev/runs/<run-name>/status.json \
  -H "Authorization: Bearer $DEMO_TOKEN"
```

Completed runs expose authenticated `report.html`, `report.json`, and `artifacts.tar.gz` paths under the same run URL. Final `status.json` also includes a millisecond-resolution lifecycle timeline for scheduling, container entrypoint and readiness, cleanup, benchmark execution, artifact persistence, and container destruction. The pre-persistence portion is copied into the archived `manifest.json`. The container filesystem is ephemeral; R2 is the durable record.

## Testing

```bash
pnpm test
pnpm typecheck
pnpm typecheck:cloudflare
pnpm build
pnpm test:container
```

Tests use fixture/fake process output and never make paid model calls. Container smoke tests build the image, check all five CLI versions, and run non-live configuration/credential inspection. Paid acceptance is explicitly gated:

```bash
ASBENCH_ENABLE_PAID_E2E=1 \
ASBENCH_CONFIG=agent-search-bench.config.json \
pnpm test:live
```

Set repetitions and enabled agents in that configuration to select the one-agent adapter check, five-agent reporting check, or final five-agent/three-repetition acceptance run.

## Security notes

Search pages are untrusted and may attempt prompt injection. Trials run in empty, disposable workspaces with isolated homes and without user rules or memories where the CLI supports that mode. Only the credential variables declared for that adapter are copied into its child environment. Keep reports local unless reviewed: even redacted traces can contain sensitive source content.
