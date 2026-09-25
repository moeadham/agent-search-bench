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

function rationaleText(trial: TrialResult): string {
  const text = trial.interview?.finalText.trim();
  if (!text) return "Unavailable";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^(?:#{1,6}\s*)?(?:selection|provider selected|selected provider|recommendation|why selected)\b/i.test(line.trim()));
  return lines.slice(start >= 0 ? start : 0).join("\n").trim() || "Unavailable";
}

function inlineMarkdown(value: string): string {
  const renderPlain = (plain: string): string => escapeHtml(plain)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const matches = [...value.matchAll(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g)];
  if (!matches.length) return renderPlain(value);
  let cursor = 0;
  const rendered: string[] = [];
  for (const match of matches) {
    const index = match.index ?? cursor;
    rendered.push(renderPlain(value.slice(cursor, index)));
    rendered.push(link(match[2] ?? "", match[1] ?? match[2] ?? ""));
    cursor = index + match[0].length;
  }
  rendered.push(renderPlain(value.slice(cursor)));
  return rendered.join("");
}

function readableMarkdown(value: string): string {
  const output: string[] = [];
  let listType: "ul" | "ol" | undefined;
  const closeList = (): void => {
    if (listType) output.push(`</${listType}>`);
    listType = undefined;
  };
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      closeList();
      output.push(`<h5>${inlineMarkdown(heading[1] ?? "")}</h5>`);
      continue;
    }
    if (/^---+$/.test(line)) {
      closeList();
      output.push("<hr>");
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const nextType = bullet ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        output.push(`<${nextType}>`);
      }
      output.push(`<li>${inlineMarkdown((bullet ?? numbered)?.[1] ?? "")}</li>`);
      continue;
    }
    closeList();
    output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  return output.join("");
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
  if (!insight?.suggestion) return `<div class="opportunity unavailable"><h3>What page should you create?</h3><p><strong>Recommendation unavailable.</strong> ${escapeHtml(insight?.error ?? "No saved analysis was available for this report.")}</p></div>`;
  const suggestion = insight.suggestion;
  return `<div class="opportunity">
    <h3>What page should you create?</h3>
    <p><strong>Recommendation:</strong> Create a page titled <span class="page-title">${escapeHtml(suggestion.title)}</span>.</p>
    <p><strong>Why this page:</strong> ${escapeHtml(suggestion.rationale)}</p>
    <details><summary>Target search queries (${suggestion.targetQueries.length})</summary>${list(suggestion.targetQueries, "No target queries were generated.")}</details>
    <details><summary>Recommended page outline (${suggestion.outline.length} sections)</summary>
      <ol>${suggestion.outline.map((section) => `<li><strong>${escapeHtml(section.heading)}</strong> — ${escapeHtml(section.purpose)}</li>`).join("")}</ol>
      <h4>Evidence to include</h4>${list(suggestion.evidenceToInclude, "No evidence recommendations were generated.")}
    </details>
  </div>`;
}

function harnessSearchDropdown(report: BenchmarkReport, agent: string): string {
  const rows = report.trials
    .filter((trial) => trial.agent === agent)
    .sort((left, right) => left.repetition - right.repetition)
    .flatMap((trial) => observedSearches(trial.discovery.tools).map((search, index) => ({ trial: trial.repetition, index, search })));
  return `<details class="primary-dropdown"><summary>All searches and returned results (${rows.length})</summary>
    <div class="row-list">${rows.length ? rows.map(({ trial, index, search }) => `<div class="data-row"><p class="row-label">Trial ${trial} · Search ${index + 1}</p>${searchDetails(search, index)}</div>`).join("") : `<p class="muted">No search calls were observed.</p>`}</div>
  </details>`;
}

function harnessRecommendationDropdown(report: BenchmarkReport, agent: string): string {
  const trials = report.trials.filter((trial) => trial.agent === agent).sort((left, right) => left.repetition - right.repetition);
  return `<details class="primary-dropdown"><summary>All trial recommendations (${trials.length})</summary>
    <div class="row-list">${trials.map((trial) => {
      const journey = report.journeys.find((item) => item.agent === trial.agent && item.repetition === trial.repetition);
      return `<details class="recommendation-row"><summary><span>Trial ${trial.repetition}</span><strong>${escapeHtml(selected(trial))}</strong></summary>
        <dl class="fact-rows">
          <div><dt>Relationship to results</dt><dd>${escapeHtml(journey ? relationshipLabel(journey.relationship) : "Unknown")}</dd></div>
          <div><dt>Observable basis</dt><dd>${escapeHtml(journey ? basisLabel(journey.basis) : "Unknown")}</dd></div>
          <div><dt>Owned-domain rank</dt><dd>${escapeHtml(positionLabel(journey?.ownedDomainRank ?? null))}</dd></div>
          <div><dt>First mention rank</dt><dd>${escapeHtml(positionLabel(journey?.mentionRank ?? null))}</dd></div>
          <div><dt>Best evidence rank</dt><dd>${escapeHtml(positionLabel(journey?.bestEvidenceRank ?? null))}</dd></div>
        </dl>
        <div class="rationale"><h4>Why the agent says it selected this</h4><p class="label">Agent-reported, not hidden reasoning.</p>${readableMarkdown(rationaleText(trial))}</div>
      </details>`;
    }).join("")}</div>
  </details>`;
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
    ${harnessSearchDropdown(report, agent)}
    ${harnessRecommendationDropdown(report, agent)}
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
    return `<article class="comparison-row"><h3>${escapeHtml(agentName(summary.agent))}</h3><dl class="fact-rows">
      <div><dt>Successful trials</dt><dd>${summary.successful}/${summary.scheduled}</dd></div>
      <div><dt>Searches</dt><dd>${searches.length}</dd></div>
      <div><dt>Returned data</dt><dd>${escapeHtml(payloadLabel(searches))}</dd></div>
      <div><dt>Most common #1</dt><dd>${escapeHtml(dominant?.name ?? "Unavailable")}</dd></div>
      <div><dt>Relationship</dt><dd>${escapeHtml(strongest ? relationshipLabel(strongest.relationship) : "Unknown")}</dd></div>
      <div><dt>Owned-domain rank</dt><dd>${escapeHtml(positionLabel(strongest?.ownedDomainRank ?? null))}</dd></div>
      <div><dt>First mention rank</dt><dd>${escapeHtml(positionLabel(strongest?.mentionRank ?? null))}</dd></div>
    </dl></article>`;
  }).join("");
  return `<div class="comparison-list">${rows}</div>`;
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
    <ol class="journey" aria-label="Observed evidence journey">
      <li><strong>Search queries</strong>${list(searches.flatMap((search) => search.query ? [search.query] : []), "No search query observed.")}</li>
      <li><strong>Returned results</strong><p>${escapeHtml(payloadLabel(searches))}</p></li>
      <li><strong>Pages opened</strong>${list(opened, "No opened page URL was observed.", (url) => link(url))}</li>
      <li><strong>Answer citations</strong>${list(citations, "No answer URL was observed.", (url) => link(url))}</li>
      <li><strong>Recommendation</strong><p>${escapeHtml(selected(trial))}</p></li>
    </ol>
    <dl class="fact-rows">
      <div><dt>Result relationship</dt><dd>${escapeHtml(journey ? relationshipLabel(journey.relationship) : "Unknown")}</dd></div>
      <div><dt>Observable basis</dt><dd>${escapeHtml(journey ? basisLabel(journey.basis) : "Unknown")}</dd></div>
      <div><dt>Owned-domain rank</dt><dd>${escapeHtml(positionLabel(journey?.ownedDomainRank ?? null))}</dd></div>
      <div><dt>First mention rank</dt><dd>${escapeHtml(positionLabel(journey?.mentionRank ?? null))}</dd></div>
      <div><dt>Best evidence rank</dt><dd>${escapeHtml(positionLabel(journey?.bestEvidenceRank ?? null))}</dd></div>
    </dl>
    <h4>Observed search evidence</h4>${searches.length ? searches.map(searchDetails).join("") : `<p class="muted">No web-search call was observed.</p>`}
    <div class="rationale"><h4>Why the agent says it selected this recommendation</h4><p class="label">Agent-reported; not hidden reasoning or a substitute for observed evidence.</p>${readableMarkdown(rationaleText(trial))}</div>
    ${trial.interviewPerformedNewResearch ? `<p class="warning">The audit interview performed a new search, fetch, or browser action despite its instruction.</p>` : ""}
  </details>`;
}

function harnessEvidence(report: BenchmarkReport, agent: string): string {
  const trials = report.trials.filter((trial) => trial.agent === agent).sort((left, right) => left.repetition - right.repetition);
  const metadata = report.harnesses?.[agent as keyof NonNullable<BenchmarkReport["harnesses"]>];
  return `<details class="harness-evidence"><summary>${escapeHtml(agentName(agent))}: detailed trial evidence</summary><p class="meta">Model: ${escapeHtml(metadata?.modelPin ?? "unknown")} · Search backend: ${escapeHtml(metadata?.searchBackend ?? "unknown")}</p>${trials.map((trial) => trialDetails(trial, report.journeys.find((journey) => journey.agent === trial.agent && journey.repetition === trial.repetition))).join("")}</details>`;
}

function diagnostics(report: BenchmarkReport): string {
  return `<details class="diagnostics"><summary>Run diagnostics</summary><div class="row-list">${report.trials.map((trial) => `<div class="data-row"><h4>${escapeHtml(agentName(trial.agent))} · Trial ${trial.repetition}</h4><dl class="fact-rows"><div><dt>Status</dt><dd>${trial.success ? "Success" : "Failed"}</dd></div><div><dt>Discovery</dt><dd>${trial.timing.discoveryMs} ms</dd></div><div><dt>Interview</dt><dd>${trial.timing.interviewMs ?? "—"}${trial.timing.interviewMs === undefined ? "" : " ms"}</dd></div><div><dt>Total</dt><dd>${trial.timing.totalMs} ms</dd></div><div><dt>Failure</dt><dd>${escapeHtml(trial.error ?? "—")}</dd></div></dl></div>`).join("")}</div><h3>Harness versions and configuration</h3><pre>${escapeHtml(JSON.stringify(report.harnesses ?? {}, null, 2))}</pre></details>`;
}

export function renderHtml(report: BenchmarkReport): string {
  const agents = report.agents.map((summary) => summary.agent);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Search Bench — ${escapeHtml(report.query)}</title><style>
  :root{color-scheme:light;--ink:#17211b;--muted:#5f6f64;--line:#dce4de;--paper:#fff;--soft:#f4f7f4;--accent:#176b45;--accent-soft:#e7f4ec;--warn:#8a4b08}*{box-sizing:border-box}body{margin:0;background:#eef2ee;color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:960px;margin:auto;padding:40px 24px 80px}header,.card,.harness-evidence,.diagnostics,.comparison-row{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:26px}header{margin-bottom:20px}h1{font-size:clamp(28px,5vw,46px);line-height:1.08;margin:0 0 18px}h2{margin:0;font-size:22px}h3{font-size:17px;margin:18px 0 8px}h4{margin:22px 0 8px}h5{font-size:15px;margin:20px 0 8px}p{margin:9px 0}.prompt{font-size:18px;background:var(--soft);border-left:4px solid var(--accent);padding:16px;border-radius:6px;white-space:pre-wrap}.meta,.muted,.label{color:var(--muted)}.label{font-size:13px}.cards,.comparison-list,.row-list{display:flex;flex-direction:column;gap:14px}.card{box-shadow:0 5px 18px rgba(28,54,37,.04)}.card-heading{display:flex;justify-content:space-between;gap:12px;align-items:center}.lead{font-size:17px}.pill{display:inline-block;background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:12px;white-space:nowrap}.success{background:var(--accent-soft);color:var(--accent)}.failure{background:#fce8e6;color:#912018}.opportunity{margin:18px 0;padding:18px;background:var(--accent-soft);border-radius:10px}.opportunity h3{margin-top:0}.opportunity.unavailable{background:var(--soft)}.page-title{font-weight:700}section{margin-top:32px}details{border-top:1px solid var(--line);padding:11px 0}summary{cursor:pointer;font-weight:680;list-style-position:outside}.primary-dropdown{margin-top:12px;border:1px solid var(--line);border-radius:10px;padding:14px 16px}.primary-dropdown[open]>summary{margin-bottom:14px}.data-row,.recommendation-row{border:1px solid var(--line);border-radius:9px;padding:14px;background:var(--paper)}.row-label{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.recommendation-row summary{display:flex;gap:12px;justify-content:space-between}.harness-evidence,.diagnostics{padding:18px 22px;margin:12px 0}.trial{margin:12px 0;padding:16px;border:1px solid var(--line);border-radius:10px}.search{margin:8px 0;padding:11px 13px;background:var(--soft);border-radius:8px}.search summary{display:flex;justify-content:space-between;gap:16px}.results li{padding:7px 0}.results p{color:var(--muted);margin:3px 0}.domain{color:var(--muted);font-size:12px;margin-left:6px}.journey{margin:16px 0;padding:0;list-style:none;counter-reset:journey}.journey>li{counter-increment:journey;border:1px solid var(--line);border-radius:8px;padding:14px;margin:8px 0;background:var(--soft)}.journey>li:before{content:counter(journey) ". ";font-weight:750;color:var(--accent)}.journey ol{padding-left:24px}.fact-rows{margin:14px 0;border:1px solid var(--line);border-radius:9px;overflow:hidden}.fact-rows>div{padding:11px 13px;border-bottom:1px solid var(--line)}.fact-rows>div:last-child{border-bottom:0}.fact-rows dt{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em}.fact-rows dd{margin:2px 0 0;font-weight:650}.comparison-row h3{margin-top:0}.rationale{margin-top:18px;padding:16px 18px;background:#fbfcfb;border:1px solid var(--line);border-radius:9px}.rationale h4,.rationale h5{margin-top:12px}.rationale p{max-width:78ch}.rationale li{margin:6px 0}.rationale code{background:#edf1ed;border-radius:4px;padding:1px 4px;font-size:.92em}.rationale hr{border:0;border-top:1px solid var(--line);margin:18px 0}.unknown,.warning{color:var(--warn)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#17211b;color:#e9f1eb;padding:14px;border-radius:8px;max-height:460px;overflow:auto}a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:2px}@media(max-width:600px){main{padding:18px 12px 50px}header,.card,.comparison-row{padding:18px}.card-heading,.recommendation-row summary,.search summary{align-items:flex-start;flex-direction:column}.harness-evidence,.diagnostics{padding:15px}}
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
