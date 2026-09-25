import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildReport } from "./metrics.js";
import { parseTurn } from "./evidence.js";
import type { AnswerCandidate, BenchmarkReport, RunManifest, SearchResultEvidence, ToolEvidence, TrialResult } from "./types.js";

function cell(value: string): string { return value.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|").trim(); }

function fenced(value: string, language = "text"): string[] {
  const matches = value.match(/`+/g) ?? [];
  const width = Math.max(3, ...matches.map((match) => match.length + 1));
  const fence = "`".repeat(width);
  return [`${fence}${language}`, value || "(empty)", fence];
}

function selected(trial: TrialResult): string {
  return trial.answerCandidates.filter((candidate) => candidate.selected).map((candidate) => candidate.name).join(", ") || "—";
}

function primaryRecommendation(trial: TrialResult): AnswerCandidate | undefined {
  return trial.answerCandidates.find((candidate) => candidate.selected) ?? trial.answerCandidates[0];
}

function isSearch(tool: ToolEvidence): boolean {
  return /^(?:web_?search|search)$/i.test(tool.name);
}

function observedSearches(tools: ToolEvidence[]): ToolEvidence[] {
  const searches = tools.filter(isSearch);
  return searches.filter((tool, index, all) => {
    const hasDetails = tool.callId || tool.input !== undefined || tool.output !== undefined || tool.query || tool.results.length;
    return Boolean(hasDetails) || !all.some((other, otherIndex) => otherIndex !== index && other.name === tool.name && Boolean(other.callId || other.input !== undefined || other.output !== undefined || other.query || other.results.length));
  });
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function recommendationMatches(candidate: AnswerCandidate, result: SearchResultEvidence): boolean {
  if (candidate.url && candidate.url.replace(/\/$/, "") === result.url.replace(/\/$/, "")) return true;
  if (candidate.domain && candidate.domain === result.domain) return true;
  if (candidate.key === result.domain) return true;
  const candidateName = normalizedName(candidate.name);
  const resultName = normalizedName(result.name);
  return candidateName.length >= 4 && (resultName.includes(candidateName) || candidateName.includes(resultName));
}

type RecommendationTrace = {
  membership: "yes" | "no" | "unknown";
  matches: Array<{ search: number; rank: number; result: SearchResultEvidence }>;
};

function traceRecommendation(trial: TrialResult): RecommendationTrace {
  const searches = observedSearches(trial.discovery.tools);
  const candidate = primaryRecommendation(trial);
  if (!candidate) return { membership: "unknown", matches: [] };
  const matches = searches.flatMap((tool, searchIndex) => tool.results
    .filter((result) => recommendationMatches(candidate, result))
    .map((result) => ({ search: searchIndex + 1, rank: result.rank, result })));
  if (matches.length) return { membership: "yes", matches };
  if (!searches.length || searches.some((tool) => !tool.rawObservable)) return { membership: "unknown", matches: [] };
  return { membership: "no", matches: [] };
}

function membershipLabel(trace: RecommendationTrace): string {
  if (trace.membership === "yes") return "Yes";
  if (trace.membership === "no") return "No";
  return "Unknown — result payload not exposed";
}

function rankLabel(trace: RecommendationTrace): string {
  if (trace.membership === "unknown") return "Unknown";
  if (!trace.matches.length) return "Not returned";
  const best = [...trace.matches].sort((a, b) => a.rank - b.rank || a.search - b.search)[0];
  if (!best) return "Not returned";
  return `#${best.rank} in search ${best.search}`;
}

function payloadLabel(searches: ToolEvidence[]): string {
  if (!searches.length) return "No search observed";
  const observed = searches.filter((tool) => tool.rawObservable);
  const rows = observed.reduce((count, tool) => count + tool.results.length, 0);
  const unknown = searches.length - observed.length;
  if (!unknown) return `${rows}`;
  if (!observed.length) return "Unknown";
  return `${rows} observed; ${unknown} call${unknown === 1 ? "" : "s"} unknown`;
}

function rationaleExcerpt(trial: TrialResult): string {
  const text = trial.interview?.finalText.trim();
  if (!text) return "Unavailable";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^(?:#{1,6}\s*)?(?:selection|provider selected|selected provider|recommendation|why selected)\b/i.test(line.trim()));
  const relevant = lines.slice(start >= 0 ? start : 0).join(" ").replace(/\s+/g, " ").trim();
  if (!relevant) return "Unavailable";
  return relevant.length > 700 ? `${relevant.slice(0, 697).trimEnd()}…` : relevant;
}

function compactResults(tool: ToolEvidence): string {
  return [...tool.results]
    .sort((a, b) => a.rank - b.rank)
    .map((result) => `${result.rank}. [${result.name}](${result.url})`)
    .join("<br>");
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [
    "# Agent Search Bench — Harness Report",
    "",
    "## Discovery prompt",
    "",
    ...fenced(report.query),
    "",
    `Run \`${report.runId}\` · ${report.successfulTrials}/${report.scheduledTrials} successful trials`,
    "",
    "## What this report measures",
    "",
    "For each harness trial: the exact observed search request, the ordered result payload returned to the agent, the agent’s recommendation, whether that recommendation appeared in the observed results, and its best observed rank. The audit explanation is shown separately as **agent-reported**, because it is not a substitute for the event trace or hidden chain-of-thought.",
    "",
    "Evidence labels: **observed** comes directly from native CLI tool events; **agent-reported** comes from the same-session audit interview; **Unknown** means the native stream did not expose enough evidence, and is never inferred from the interview.",
    "",
    "## Trial summary",
    "",
    "| Harness | Trial | Search calls | Returned results | #1 recommendation | From returned list? | Observed search rank |",
    "| --- | ---: | ---: | ---: | --- | --- | --- |",
  ];

  for (const summary of report.agents) {
    const trials = report.trials.filter((trial) => trial.agent === summary.agent).sort((a, b) => a.repetition - b.repetition);
    for (const trial of trials) {
      const searches = observedSearches(trial.discovery.tools);
      const trace = traceRecommendation(trial);
      lines.push(`| ${summary.agent} | ${trial.repetition} | ${searches.length} | ${cell(payloadLabel(searches))} | ${cell(selected(trial))} | ${cell(membershipLabel(trace))} | ${cell(rankLabel(trace))} |`);
    }
  }
  lines.push("");

  for (const summary of report.agents) {
    const metadata = report.harnesses?.[summary.agent];
    const trials = report.trials.filter((item) => item.agent === summary.agent).sort((a, b) => a.repetition - b.repetition);
    const allSearches = trials.flatMap((trial) => observedSearches(trial.discovery.tools));
    const observableSearches = allSearches.filter((tool) => tool.rawObservable).length;
    const synthesizedSearches = allSearches.filter((tool) => Boolean(tool.responseText)).length;
    lines.push(`## ${summary.agent}`, "", `Model: \`${metadata?.modelPin ?? "unknown"}\` · Search backend: ${metadata?.searchBackend ?? "unknown"}`, "");
    lines.push(`Trace coverage: ${observableSearches}/${allSearches.length} search result payloads observed · ${synthesizedSearches}/${allSearches.length} search-tool syntheses observed · ${trials.filter((trial) => Boolean(trial.interview?.finalText.trim())).length}/${trials.length} audit explanations captured. No hidden reasoning is claimed.`, "");
    const harnessPrompt = trials[0]?.discoveryPrompt;
    if (harnessPrompt && harnessPrompt !== report.query) {
      lines.push("### Discovery prompt sent to this harness", "", ...fenced(harnessPrompt), "");
    }
    lines.push("### Consolidated outcomes", "", "| Trial | Exact search queries observed | Recommendation | From observed list? | Best rank |", "| ---: | --- | --- | --- | --- |");
    for (const trial of trials) {
      const searches = observedSearches(trial.discovery.tools);
      const trace = traceRecommendation(trial);
      const queries = searches.map((tool, index) => `${index + 1}. ${tool.query ?? "Not exposed"}`).join("<br>") || "No search observed";
      lines.push(`| ${trial.repetition} | ${cell(queries)} | ${cell(selected(trial))} | ${cell(membershipLabel(trace))} | ${cell(rankLabel(trace))} |`);
    }
    lines.push("", "### Observed search evidence", "");
    for (const trial of trials) {
      const searches = observedSearches(trial.discovery.tools);
      if (!searches.length) {
        lines.push(`- **Trial ${trial.repetition}:** No web-search call was observed.`, "");
        continue;
      }
      searches.forEach((tool, searchIndex) => {
        const summary = `Trial ${trial.repetition}, search ${searchIndex + 1} — ${tool.query ? cell(tool.query) : "query not exposed"} — ${tool.rawObservable ? `${tool.results.length} results` : "results unknown"}`;
        lines.push("<details>", `<summary>${summary}</summary>`, "", `**Exact tool query (observed):** ${tool.query ? cell(tool.query) : "Not exposed"}`, "");
        if (!tool.rawObservable) {
          lines.push("The harness exposed the search call but not the returned result payload.", "");
        } else if (!tool.results.length) {
          lines.push("The observed result payload contained no result rows.", "");
        } else {
          lines.push(`**Exact ordered result list (observed):**<br>${compactResults(tool)}`, "");
        }
        if (tool.responseText) {
          lines.push("**Search-tool synthesis shown to the agent (observed):**", "", ...fenced(tool.responseText), "");
        }
        lines.push("</details>", "");
      });
    }
    lines.push("### Why the agent says it selected the recommendation", "", "These are concise excerpts from the fixed same-session audit interview. They are **agent-reported**, not hidden reasoning and not proof that an unobserved search result existed.", "");
    for (const trial of trials) lines.push(`- **Trial ${trial.repetition}:** ${cell(rationaleExcerpt(trial))}`);
    lines.push("");
    if (trials.some((trial) => trial.interviewPerformedNewResearch)) lines.push("⚠️ At least one interview trace contains a search/fetch/browser tool call despite the no-new-research instruction.", "");
    lines.push(`Full discovery answers, audit transcripts, and raw tool payloads remain in \`trials/${summary.agent}/<trial>/\`.`, "");
  }
  return lines.join("\n");
}

async function findTrialFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === "trial.json") files.push(path);
    }
  }
  await visit(root);
  return files;
}

async function refreshTrialEvidence(file: string): Promise<TrialResult> {
  const trial = JSON.parse(await readFile(file, "utf8")) as TrialResult;
  const directory = dirname(file);
  for (const phase of ["discovery", "interview"] as const) {
    if (phase === "interview" && !trial.interview) continue;
    try {
      const [jsonl, text] = await Promise.all([
        readFile(join(directory, `${phase}.events.jsonl`), "utf8"),
        readFile(join(directory, `${phase}.txt`), "utf8"),
      ]);
      const events = jsonl.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as unknown]; }
        catch { return []; }
      });
      const reparsed = parseTurn(events, text, phase);
      const current = phase === "discovery" ? trial.discovery : trial.interview;
      const merged = { ...current, ...reparsed, finalText: current?.finalText || reparsed.finalText };
      if (phase === "discovery") trial.discovery = merged;
      else trial.interview = merged;
    } catch { /* Older/partial runs may not contain both raw turn files. */ }
  }
  return trial;
}

export async function generateReport(runDirectory: string): Promise<BenchmarkReport> {
  const root = resolve(runDirectory);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as RunManifest;
  const files = await findTrialFiles(join(root, "trials"));
  const trials = await Promise.all(files.map(refreshTrialEvidence));
  trials.sort((a, b) => a.agent.localeCompare(b.agent) || a.repetition - b.repetition);
  const report = { ...buildReport(manifest.runId, manifest.query, trials, manifest.aliases ?? {}), harnesses: manifest.agents };
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(root, "report.md"), renderMarkdown(report), { mode: 0o600 });
  return report;
}
