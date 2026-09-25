# Agent Search Bench

A TypeScript CLI for comparing agentic web discovery. It runs a base prompt through enabled agent harnesses, interviews each agent in the same session, preserves observable tool evidence, and reports the returned search-result lists and the agent's recommendation. The current deployment enables Claude Code, Codex, Hermes, and OpenClaw; Cursor remains implemented but disabled and is not installed in the image.

For every trial, the report answers four questions: what the search provider returned, what the agent recommended, whether that recommendation was in the observed result list, and its best observed search rank.

## Requirements

- Node.js 26+
- pnpm
- The enabled agent CLIs, or Docker
- API credentials for enabled agents and a separate OpenAI-compatible recommendation extractor

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

The placeholder Hermes/OpenClaw credential names are intentionally configurable. Change `credentialEnv` to the actual variable used by the selected provider, such as `OPENROUTER_API_KEY`. The recommendation extractor must expose an OpenAI-compatible `/chat/completions` endpoint with JSON-schema structured output.

Model and search providers are configured independently. The checked-in deployment pins Hermes search to its documented Firecrawl default (`FIRECRAWL_API_KEY`) and OpenClaw search to the first provider in its auto-detection order, Brave (`BRAVE_API_KEY`). OpenRouter remains the model provider for both agents and for the small recommendation-extraction step.

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
├── report.md
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

The Markdown report shows:

- the exact query sent with each search call
- the ordered result rows returned by the search provider
- the agent's #1 recommendation
- whether that recommendation was present in those rows
- the recommendation's best observed rank

If a harness exposes the search call but not its result payload, membership and rank are reported as `Unknown`; the framework does not substitute the agent's self-report. The model-assisted extraction step only identifies the #1 recommendation in free-form prose. It does not score quality or decide membership/rank.

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

## Testing

```bash
pnpm test
pnpm typecheck
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
