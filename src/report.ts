import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseTurn } from "./evidence.js";
import { buildReport } from "./metrics.js";
import { observedSearches, primaryRecommendation } from "./report-evidence.js";
import type { BenchmarkReport, HarnessInsight, RunManifest, ToolEvidence, TrialEvidenceJourney, TrialResult } from "./types.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch { return undefined; }
}

function link(url: string, label = url): string {
  const safe = safeHttpUrl(url);
  return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : escapeHtml(label);
}

function selected(trial: TrialResult): string {
  return trial.answerCandidates.filter((candidate) => candidate.selected).map((candidate) => candidate.name).join(", ") || "Unavailable";
}

function rationaleExcerpt(trial: TrialResult): string {
  const text = trial.interview?.finalText.trim();
  if (!text) return "Unavailable";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^(?:#{1,6}\s*)?(?:selection|provider selected|selected provider|recommendation|why selected)\b/i.test(line.trim()));
  const relevant = lines.slice(start >= 0 ? start : 0).join(" ").replace(/\s+/g, " ").trim();
  return relevant.length > 900 ? `${relevant.slice(0, 897).trimEnd()}…` : relevant;
}

function payloadLabel(searches: ToolEvidence[]): string {
  if (!searches.length) return "No search observed";
  const observable = searches.filter((search) => search.rawObservable);
  const rows = observable.reduce((count, search) => count + search.results.length, 0);
  const unknown = searches.length - observable.length;
  if (!unknown) return `${rows} returned results`;
  if (!observable.length) return "Result payloads unknown";
  return `${rows} results observed; ${unknown} search payload${unknown === 1 ? "" : "s"} unknown`;
}

function positionLabel(position: TrialEvidenceJourney["bestEvidenceRank"]): string {
  return position ? `#${position.rank} in search ${position.search}` : "—";
}

function relationshipLabel(value: TrialEvidenceJourney["relationship"]): string {
  return { direct_result: "Direct result", mentioned_result: "Mentioned in a result", not_observed: "Not observed", unknown: "Unknown" }[value];
}

function basisLabel(value: TrialEvidenceJourney["basis"]): string {
  return { returned_and_opened: "Returned and opened", returned_not_opened: "Returned but not opened", mentioned_only: "Mentioned only", not_observed: "Not observed", unknown: "Unknown" }[value];
}

function agentName(value: string): string {
  return value === "openclaw" ? "OpenClaw" : value.charAt(0).toUpperCase() + value.slice(1);
}

function list(items: string[], empty: string, render: (item: string) => string = escapeHtml): string {
  if (!items.length) return `<p class="muted">${escapeHtml(empty)}</p>`;
  return `<ol>${items.map((item) => `<li>${render(item)}</li>`).join("")}</ol>`;
}

function dominantRecommendation(trials: TrialResult[]): { name: string; count: number } | undefined {
  const counts = new Map<string, number>();
  for (const trial of trials) {
    const name = primaryRecommendation(trial)?.name;
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([name, count]) => ({ name, count }))[0];
}

function strongestJourney(journeys: TrialEvidenceJourney[]): TrialEvidenceJourney | undefined {
  const score = { direct_result: 0, mentioned_result: 1, not_observed: 2, unknown: 3 };
  return [...journeys].sort((left, right) => score[left.relationship] - score[right.relationship]
    || (left.bestEvidenceRank?.rank ?? Number.MAX_SAFE_INTEGER) - (right.bestEvidenceRank?.rank ?? Number.MAX_SAFE_INTEGER))[0];
}

function harnessNarrative(report: BenchmarkReport, agent: string): string {
  const trials = report.trials.filter((trial) => trial.agent === agent);
  const journeys = report.journeys.filter((journey) => journey.agent === agent);
  const queries = [...new Set(trials.flatMap((trial) => observedSearches(trial.discovery.tools).flatMap((search) => search.query ? [search.query] : [])))];
  const dominant = dominantRecommendation(trials);
  const relevantJourneys = dominant ? journeys.filter((journey) => journey.recommendation === dominant.name) : journeys;
  const strongest = strongestJourney(relevantJourneys);
  const backend = report.harnesses?.[agent as keyof NonNullable<BenchmarkReport["harnesses"]>]?.searchBackend ?? "its native search stack";
  const searchText = queries.length
    ? `searched ${backend} for “${queries[0]}”${queries.length > 1 ? ` and ${queries.length - 1} additional quer${queries.length === 2 ? "y" : "ies"}` : ""}`
    : "did not expose an observed search query";
  if (!dominant) return `${agentName(agent)} ran ${trials.length} trial${trials.length === 1 ? "" : "s"} and ${searchText}. No primary recommendation was extractable.`;
  const recommendation = `${dominant.name} was the most frequent #1 recommendation (${dominant.count}/${trials.length} trials)`;
  if (!strongest) return `${agentName(agent)} ${searchText}. ${recommendation}.`;
  const connection = strongest.relationship === "direct_result"
    ? `its own domain ranked as high as ${positionLabel(strongest.ownedDomainRank)}`
    : strongest.relationship === "mentioned_result"
      ? `it was first mentioned at ${positionLabel(strongest.mentionRank)}, but its own domain was not returned`
      : strongest.relationship === "not_observed"
        ? "it was not present in the complete observed result lists"
        : "the native harness did not expose enough result data to establish its search rank";
  return `${agentName(agent)} ${searchText}. ${recommendation}; ${connection}.`;
}

function suggestionHtml(insight: HarnessInsight | undefined): string {
  if (!insight?.suggestion) return `<p class="opportunity unavailable"><strong>Content opportunity unavailable.</strong> ${escapeHtml(insight?.error ?? "No saved analysis was available for this report.")}</p>`;
  const suggestion = insight.suggestion;
  return `<div class="opportunity">
    <p><strong>Suggested page:</strong> “${escapeHtml(suggestion.title)},” targeting ${suggestion.targetQueries.map((query) => `“${escapeHtml(query)}”`).join(", ")}. ${escapeHtml(suggestion.rationale)}</p>
    <details><summary>Suggested page outline</summary>
      <ol>${suggestion.outline.map((section) => `<li><strong>${escapeHtml(section.heading)}</strong> — ${escapeHtml(section.purpose)}</li>`).join("")}</ol>
      <h4>Evidence to include</h4>${list(suggestion.evidenceToInclude, "No evidence recommendations were generated.")}
    </details>
  </div>`;
}

function summaryCard(report: BenchmarkReport, agent: string): string {
  const summary = report.agents.find((item) => item.agent === agent);
  const insight = report.insights.find((item) => item.agent === agent);
  const trials = report.trials.filter((trial) => trial.agent === agent);
  const searches = trials.flatMap((trial) => observedSearches(trial.discovery.tools));
  return `<article class="card">
    <div class="card-heading"><h2>${escapeHtml(agentName(agent))}</h2><span class="pill">${summary?.successful ?? 0}/${summary?.scheduled ?? trials.length} successful</span></div>
    <p class="lead">${escapeHtml(harnessNarrative(report, agent))}</p>
    ${suggestionHtml(insight)}
    <p class="meta">${searches.length} search calls · ${escapeHtml(payloadLabel(searches))}</p>
  </article>`;
}

function comparisonTable(report: BenchmarkReport): string {
  const rows = report.agents.map((summary) => {
    const trials = report.trials.filter((trial) => trial.agent === summary.agent);
    const journeys = report.journeys.filter((journey) => journey.agent === summary.agent);
    const searches = trials.flatMap((trial) => observedSearches(trial.discovery.tools));
    const dominant = dominantRecommendation(trials);
    const strongest = strongestJourney(dominant ? journeys.filter((journey) => journey.recommendation === dominant.name) : journeys);
    return `<tr><th>${escapeHtml(agentName(summary.agent))}</th><td>${summary.successful}/${summary.scheduled}</td><td>${searches.length}</td><td>${escapeHtml(payloadLabel(searches))}</td><td>${escapeHtml(dominant?.name ?? "Unavailable")}</td><td>${escapeHtml(strongest ? relationshipLabel(strongest.relationship) : "Unknown")}</td><td>${escapeHtml(positionLabel(strongest?.ownedDomainRank ?? null))}</td><td>${escapeHtml(positionLabel(strongest?.mentionRank ?? null))}</td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Harness</th><th>Trials</th><th>Searches</th><th>Returned data</th><th>Most common #1</th><th>Relationship</th><th>Owned-domain rank</th><th>Mention rank</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function resultList(search: ToolEvidence): string {
  if (!search.rawObservable) return `<p class="unknown">The harness exposed the search call but not its returned result payload.</p>`;
  if (!search.results.length) return `<p class="muted">The observed payload contained no result rows.</p>`;
  return `<ol class="results">${[...search.results].sort((left, right) => left.rank - right.rank).map((result) => `<li value="${result.rank}"><div>${link(result.url, result.name)} <span class="domain">${escapeHtml(result.domain)}</span></div>${result.snippet ? `<p>${escapeHtml(result.snippet)}</p>` : ""}</li>`).join("")}</ol>`;
}

function searchDetails(search: ToolEvidence, index: number): string {
  return `<details class="search"><summary>Search ${index + 1}: ${escapeHtml(search.query ?? "Query not exposed")} <span>${search.rawObservable ? `${search.results.length} results` : "results unknown"}</span></summary>
    <p><strong>Exact observed query:</strong> ${escapeHtml(search.query ?? "Not exposed")}</p>${resultList(search)}
    ${search.responseText ? `<details><summary>Search synthesis shown to the agent</summary><pre>${escapeHtml(search.responseText)}</pre></details>` : ""}
  </details>`;
}

function trialDetails(trial: TrialResult, journey: TrialEvidenceJourney | undefined): string {
  const searches = observedSearches(trial.discovery.tools);
  const opened = journey?.openedPages ?? [];
  const citations = journey?.answerCitations ?? [];
  return `<details class="trial"><summary>Trial ${trial.repetition}: ${escapeHtml(selected(trial))} <span class="pill ${trial.success ? "success" : "failure"}">${trial.success ? "successful" : "failed"}</span></summary>
    ${trial.discoveryPrompt ? `<h4>Prompt sent to this harness</h4><pre>${escapeHtml(trial.discoveryPrompt)}</pre>` : ""}
    <div class="journey" aria-label="Observed evidence journey">
      <div><strong>1. Search queries</strong>${list(searches.flatMap((search) => search.query ? [search.query] : []), "No search query observed.")}</div>
      <div><strong>2. Returned results</strong><p>${escapeHtml(payloadLabel(searches))}</p></div>
      <div><strong>3. Pages opened</strong>${list(opened, "No opened page URL was observed.", (url) => link(url))}</div>
      <div><strong>4. Answer citations</strong>${list(citations, "No answer URL was observed.", (url) => link(url))}</div>
      <div><strong>5. Recommendation</strong><p>${escapeHtml(selected(trial))}</p></div>
    </div>
    <div class="rank-grid">
      <div><span>Result relationship</span><strong>${escapeHtml(journey ? relationshipLabel(journey.relationship) : "Unknown")}</strong></div>
      <div><span>Observable basis</span><strong>${escapeHtml(journey ? basisLabel(journey.basis) : "Unknown")}</strong></div>
      <div><span>Owned-domain rank</span><strong>${escapeHtml(positionLabel(journey?.ownedDomainRank ?? null))}</strong></div>
      <div><span>First mention rank</span><strong>${escapeHtml(positionLabel(journey?.mentionRank ?? null))}</strong></div>
      <div><span>Best evidence rank</span><strong>${escapeHtml(positionLabel(journey?.bestEvidenceRank ?? null))}</strong></div>
    </div>
    <h4>Observed search evidence</h4>${searches.length ? searches.map(searchDetails).join("") : `<p class="muted">No web-search call was observed.</p>`}
    <h4>Why the agent says it selected this recommendation</h4><p class="label">Agent-reported; not hidden reasoning or a substitute for observed evidence.</p><p>${escapeHtml(rationaleExcerpt(trial))}</p>
    ${trial.interviewPerformedNewResearch ? `<p class="warning">The audit interview performed a new search, fetch, or browser action despite its instruction.</p>` : ""}
  </details>`;
}

function harnessEvidence(report: BenchmarkReport, agent: string): string {
  const trials = report.trials.filter((trial) => trial.agent === agent).sort((left, right) => left.repetition - right.repetition);
  const metadata = report.harnesses?.[agent as keyof NonNullable<BenchmarkReport["harnesses"]>];
  return `<details class="harness-evidence"><summary>${escapeHtml(agentName(agent))}: detailed trial evidence</summary><p class="meta">Model: ${escapeHtml(metadata?.modelPin ?? "unknown")} · Search backend: ${escapeHtml(metadata?.searchBackend ?? "unknown")}</p>${trials.map((trial) => trialDetails(trial, report.journeys.find((journey) => journey.agent === trial.agent && journey.repetition === trial.repetition))).join("")}</details>`;
}

function diagnostics(report: BenchmarkReport): string {
  return `<details class="diagnostics"><summary>Run diagnostics</summary><div class="table-wrap"><table><thead><tr><th>Harness</th><th>Trial</th><th>Status</th><th>Discovery</th><th>Interview</th><th>Total</th><th>Failure</th></tr></thead><tbody>${report.trials.map((trial) => `<tr><th>${escapeHtml(agentName(trial.agent))}</th><td>${trial.repetition}</td><td>${trial.success ? "Success" : "Failed"}</td><td>${trial.timing.discoveryMs} ms</td><td>${trial.timing.interviewMs ?? "—"}${trial.timing.interviewMs === undefined ? "" : " ms"}</td><td>${trial.timing.totalMs} ms</td><td>${escapeHtml(trial.error ?? "—")}</td></tr>`).join("")}</tbody></table></div><h3>Harness versions and configuration</h3><pre>${escapeHtml(JSON.stringify(report.harnesses ?? {}, null, 2))}</pre></details>`;
}

export function renderHtml(report: BenchmarkReport): string {
  const agents = report.agents.map((summary) => summary.agent);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Search Bench — ${escapeHtml(report.query)}</title><style>
  :root{color-scheme:light;--ink:#17211b;--muted:#5f6f64;--line:#dce4de;--paper:#fff;--soft:#f4f7f4;--accent:#176b45;--accent-soft:#e7f4ec;--warn:#8a4b08}*{box-sizing:border-box}body{margin:0;background:#eef2ee;color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:auto;padding:40px 24px 80px}header{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:28px;margin-bottom:20px}h1{font-size:clamp(28px,5vw,48px);line-height:1.05;margin:0 0 18px}h2{margin:0;font-size:22px}h3{margin-top:30px}h4{margin:22px 0 8px}p{margin:9px 0}.prompt{font-size:18px;background:var(--soft);border-left:4px solid var(--accent);padding:16px;border-radius:6px;white-space:pre-wrap}.meta,.muted,.label{color:var(--muted)}.label{font-size:13px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}.card{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 5px 18px rgba(28,54,37,.04)}.card-heading{display:flex;justify-content:space-between;gap:12px;align-items:center}.lead{font-size:16px}.pill{display:inline-block;background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:12px;white-space:nowrap}.success{background:var(--accent-soft);color:var(--accent)}.failure{background:#fce8e6;color:#912018}.opportunity{margin-top:16px;padding:14px;background:var(--accent-soft);border-radius:10px}.opportunity.unavailable{background:var(--soft)}section{margin-top:30px}.table-wrap{overflow:auto;background:var(--paper);border:1px solid var(--line);border-radius:12px}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:top}thead th{background:var(--soft);font-size:12px;text-transform:uppercase;letter-spacing:.04em}details{border-top:1px solid var(--line);padding:10px 0}summary{cursor:pointer;font-weight:650;list-style-position:outside}.harness-evidence,.diagnostics{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin:12px 0}.trial{margin:12px 0;padding:14px;border:1px solid var(--line);border-radius:10px}.search{margin:8px 0;padding:10px 12px;background:var(--soft);border-radius:8px}.search summary{display:flex;justify-content:space-between;gap:16px}.results li{padding:6px 0}.results p{color:var(--muted);margin:3px 0}.domain{color:var(--muted);font-size:12px;margin-left:6px}.journey{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:16px 0}.journey>div,.rank-grid>div{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--soft)}.journey ol{padding-left:20px}.rank-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:8px}.rank-grid span,.rank-grid strong{display:block}.rank-grid span{color:var(--muted);font-size:12px}.unknown,.warning{color:var(--warn)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#17211b;color:#e9f1eb;padding:14px;border-radius:8px;max-height:460px;overflow:auto}a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:2px}@media(max-width:600px){main{padding:18px 12px 50px}header,.card{padding:18px}.cards{grid-template-columns:1fr}}
  </style></head><body><main>
  <header><p class="meta">Agent Search Bench</p><h1>How agents searched and what to create next</h1><h2>Discovery prompt</h2><div class="prompt">${escapeHtml(report.query)}</div><p class="meta">Run ${escapeHtml(report.runId)} · ${report.successfulTrials}/${report.scheduledTrials} successful trials</p></header>
  <section><h2>Harness findings</h2><p class="meta">Observed evidence and actionable content suggestions, consolidated across repeated trials.</p><div class="cards">${agents.map((agent) => summaryCard(report, agent)).join("")}</div></section>
  <section><h2>Cross-harness comparison</h2>${comparisonTable(report)}</section>
  <section><h2>Detailed evidence</h2><p class="meta">Expand a harness and trial to inspect the exact observable path from search query to recommendation.</p>${agents.map((agent) => harnessEvidence(report, agent)).join("")}</section>
  <section>${diagnostics(report)}</section>
  </main></body></html>`;
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
      const [jsonl, text] = await Promise.all([readFile(join(directory, `${phase}.events.jsonl`), "utf8"), readFile(join(directory, `${phase}.txt`), "utf8")]);
      const events = jsonl.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
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

async function previousInsights(root: string): Promise<HarnessInsight[]> {
  try {
    const previous = JSON.parse(await readFile(join(root, "report.json"), "utf8")) as Partial<BenchmarkReport>;
    return Array.isArray(previous.insights) ? previous.insights : [];
  } catch { return []; }
}

export async function generateReport(runDirectory: string, newInsights?: HarnessInsight[]): Promise<BenchmarkReport> {
  const root = resolve(runDirectory);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as RunManifest;
  const files = await findTrialFiles(join(root, "trials"));
  const trials = await Promise.all(files.map(refreshTrialEvidence));
  trials.sort((left, right) => left.agent.localeCompare(right.agent) || left.repetition - right.repetition);
  const insights = newInsights ?? await previousInsights(root);
  const report = { ...buildReport(manifest.runId, manifest.query, trials, manifest.aliases ?? {}, insights), harnesses: manifest.agents };
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(root, "report.html"), renderHtml(report), { mode: 0o600 });
  return report;
}
