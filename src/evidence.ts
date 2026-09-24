import { URL } from "node:url";
import type { AnswerCandidate, SearchResultEvidence, ToolEvidence, TurnEvidence } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return void item.forEach(visit);
    if (!isRecord(item)) return;
    found.push(item);
    Object.values(item).forEach(visit);
  };
  visit(value);
  return found;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function cleanExternalText(value: string): string {
  return value
    .replace(/<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?>>>/g, "")
    .replace(/^Source:\s*Web Search\s*$/gim, "")
    .replace(/^---\s*$/gm, "")
    .trim();
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (!isRecord(item)) return [];
      const type = firstString(item, ["type", "role"]);
      if (type && /tool[_ .-]?(?:use|call|result)/i.test(type)) return [];
      const text = firstString(item, ["text", "content", "message"]);
      return text ? [text] : [];
    });
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

export function canonicalDomain(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function canonicalKey(name: string, url: string | undefined, aliases: Record<string, string>): string {
  const domain = url ? canonicalDomain(url) : undefined;
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const alias = aliases[domain ?? ""] ?? aliases[normalizedName];
  return (alias ?? domain ?? normalizedName).toLowerCase();
}

function resultRows(value: unknown, query?: string, tool?: string): SearchResultEvidence[] {
  if (typeof value === "string") {
    try { return resultRows(JSON.parse(value), query, tool); }
    catch {
      // Some CLIs truncate an otherwise JSON result string. Preserve that raw
      // payload, but still surface complete URL/title pairs that are observable.
      const visible: SearchResultEvidence[] = [];
      const pairs = /"url"\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"title"\s*:\s*("(?:\\.|[^"\\])*")/g;
      for (const match of value.matchAll(pairs)) {
        try {
          const url = JSON.parse(match[1] as string) as string;
          const name = JSON.parse(match[2] as string) as string;
          const domain = canonicalDomain(url);
          if (domain) visible.push({ name, url, domain, rank: visible.length + 1, ...(query ? { query } : {}), ...(tool ? { tool } : {}) });
        } catch { /* Ignore an incomplete pair at the truncation boundary. */ }
      }
      if (visible.length) return [...new Map(visible.map((row) => [row.url, row])).values()];
    }
  }
  const rows: SearchResultEvidence[] = [];
  for (const record of records(value)) {
    const url = firstString(record, ["url", "link", "href"]);
    const domain = url ? canonicalDomain(url) : undefined;
    if (!url || !domain) continue;
    const position = record.position ?? record.rank ?? record.index;
    const name = cleanExternalText(firstString(record, ["title", "name", "siteName"]) ?? domain);
    const snippet = firstString(record, ["snippet", "description", "summary"]);
    const published = firstString(record, ["published", "publishedAt", "date"]);
    const siteName = firstString(record, ["siteName", "site_name"]);
    rows.push({
      name,
      url,
      domain,
      rank: typeof position === "number" && position >= 1 ? position : rows.length + 1,
      ...(query ? { query } : {}),
      ...(tool ? { tool } : {}),
      ...(snippet ? { snippet: cleanExternalText(snippet) } : {}),
      ...(published ? { published } : {}),
      ...(siteName ? { siteName: cleanExternalText(siteName) } : {}),
    });
  }
  return [...new Map(rows.map((row) => [row.url, row])).values()];
}

function toolName(record: Record<string, unknown>): string | undefined {
  return firstString(record, ["toolName", "tool_name", "tool", "name"]);
}

function callId(record: Record<string, unknown>): string | undefined {
  return firstString(record, ["toolCallId", "tool_call_id", "callId", "call_id", "id"]);
}

function queryFrom(value: unknown): string | undefined {
  for (const record of records(value)) {
    const query = firstString(record, ["query", "search_query", "searchQuery"]);
    if (query) return query;
  }
  return undefined;
}

function appendTool(tools: ToolEvidence[], tool: ToolEvidence): void {
  if (tool.output !== undefined && !tool.callId && !tool.query) {
    const pending = [...tools].reverse().find((item) => item.name === tool.name && item.output === undefined && !item.rawObservable);
    if (pending) {
      pending.output = tool.output;
      pending.rawObservable = true;
      if (tool.results.length) pending.results = tool.results;
      if (tool.provider) pending.provider = tool.provider;
      return;
    }
  }
  const key = `${tool.phase}|${tool.callId ?? ""}|${tool.name}|${tool.query ?? ""}`;
  const existing = tools.find((item) => `${item.phase}|${item.callId ?? ""}|${item.name}|${item.query ?? ""}` === key);
  if (!existing) return void tools.push(tool);
  if (tool.results.length) existing.results = tool.results;
  if (tool.rawObservable) existing.rawObservable = true;
  if (tool.output !== undefined) existing.output = tool.output;
  if (tool.input !== undefined && existing.input === undefined) existing.input = tool.input;
  if (tool.provider && !existing.provider) existing.provider = tool.provider;
}

export function parseTurn(events: unknown[], stdout: string, phase: "discovery" | "interview"): TurnEvidence {
  let sessionId: string | undefined;
  let resolvedModel: string | undefined;
  let resolvedProvider: string | undefined;
  let costUsd: number | undefined;
  const textCandidates: string[] = [];
  const usage: Record<string, number | null> = {};
  const tools: ToolEvidence[] = [];

  for (const event of events) {
    const all = records(event);
    for (const record of all) {
      sessionId ??= firstString(record, ["session_id", "sessionId", "thread_id", "threadId", "chat_id", "chatId"]);
      resolvedModel ??= firstString(record, ["model", "model_id", "modelId"]);
      resolvedProvider ??= firstString(record, ["provider", "apiProvider"]);
      const maybeCost = record.costUsd ?? record.cost_usd ?? record.total_cost_usd;
      if (typeof maybeCost === "number") costUsd = maybeCost;
      for (const [key, value] of Object.entries(record)) {
        if (/token|usage/i.test(key) && typeof value === "number") usage[key] = value;
      }
      const type = firstString(record, ["type", "event"]);
      const role = firstString(record, ["role"]);
      const isAssistant = role === "assistant" || type === "assistant" || type === "agent_message" || type === "message" && role !== "tool";
      if (isAssistant) {
        const text = textValue(record.text ?? record.content ?? record.message);
        if (text) textCandidates.push(text);
      }
      if (type === "result" || type === "final" || type === "completion") {
        const text = textValue(record.result ?? record.final ?? record.text ?? record.content ?? record.message);
        if (text) textCandidates.push(text);
      }
    }

    if (isRecord(event) && event.type === "item.completed" && isRecord(event.item) && event.item.type === "web_search") {
      const item = event.item;
      const action = isRecord(item.action) ? item.action : undefined;
      const queries = action && Array.isArray(action.queries)
        ? action.queries.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        : [];
      const exactQueries = queries.length ? queries : [firstString(item, ["query"])].filter((value): value is string => Boolean(value));
      const id = firstString(item, ["id"]);
      for (const query of exactQueries) appendTool(tools, {
        name: "web_search", phase, query, ...(id ? { callId: id } : {}),
        input: action ?? { query }, results: [], rawObservable: false,
      });
      continue;
    }

    // OpenClaw trajectory schema v1 wraps runtime tool events in `data`.
    // Prefer these events over transcript snapshots because they retain the
    // exact Brave arguments and normalized result payload.
    if (isRecord(event) && event.source === "runtime" && isRecord(event.data) && (event.type === "tool.call" || event.type === "tool.result")) {
      const record = event.data;
      const name = toolName(record);
      if (name && event.type === "tool.call") {
        const input = record.args ?? record.arguments ?? record.input ?? record.parameters;
        const id = callId(record);
        const query = queryFrom(input);
        appendTool(tools, { name, phase, ...(id ? { callId: id } : {}), ...(query ? { query } : {}), ...(input !== undefined ? { input } : {}), results: [], rawObservable: false });
      }
      if (name && event.type === "tool.result") {
        const output = record.result ?? record.output ?? record.content ?? record;
        const details = isRecord(output) && output.details !== undefined ? output.details : output;
        const id = callId(record);
        const query = queryFrom(details) ?? queryFrom(record);
        const provider = isRecord(details) ? firstString(details, ["provider"]) : undefined;
        appendTool(tools, { name, phase, ...(id ? { callId: id } : {}), ...(query ? { query } : {}), ...(provider ? { provider } : {}), output, results: resultRows(details, query, name), rawObservable: true });
      }
      continue;
    }

    if (isRecord(event) && isRecord(event.toolSummary) && Array.isArray(event.toolSummary.tools)) {
      for (const name of event.toolSummary.tools) {
        if (typeof name === "string") appendTool(tools, { name, phase, results: [], rawObservable: false });
      }
    }

    for (const record of all) {
      const type = firstString(record, ["type", "event", "role"]) ?? "";
      const name = toolName(record);
      const isCall = /^(?:tool[._ -]?(?:call|use)|function_call)$/i.test(type);
      const isResult = /^(?:tool[._ -]?result|function_result)$/i.test(type) || record.role === "toolResult" || record.role === "tool";
      if (isCall && name) {
        const input = record.input ?? record.arguments ?? record.args ?? record.parameters;
        const id = callId(record);
        const query = queryFrom(input);
        appendTool(tools, { name, phase, ...(id ? { callId: id } : {}), ...(query ? { query } : {}), ...(input !== undefined ? { input } : {}), results: [], rawObservable: false });
      }
      if (isResult && !name && callId(record)) {
        const existing = tools.find((item) => item.callId === callId(record));
        if (existing) {
          const output = record.output ?? record.result ?? record.content ?? record.details ?? record;
          existing.output = output;
          existing.rawObservable = true;
          const parsed = resultRows(record.details ?? output, existing.query, existing.name);
          if (parsed.length) existing.results = parsed;
        }
      }
      if (isResult && name) {
        const output = record.output ?? record.result ?? record.content ?? record.details ?? record;
        const query = queryFrom(record.details ?? output) ?? queryFrom(record);
        const provider = isRecord(record.details) ? firstString(record.details, ["provider"]) : undefined;
        const id = callId(record);
        appendTool(tools, { name, phase, ...(id ? { callId: id } : {}), ...(query ? { query } : {}), ...(provider ? { provider } : {}), output, results: resultRows(record.details ?? output, query, name), rawObservable: true });
      }
    }
  }

  let finalText = textCandidates.at(-1) ?? "";
  if (!finalText && events.length === 1 && isRecord(events[0])) {
    const root = events[0];
    finalText = textValue(root.final ?? root.result ?? root.text ?? root.message) ?? "";
    if (!finalText && Array.isArray(root.payloads)) finalText = root.payloads.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("\n");
  }
  finalText ||= stdout.trim();
  return { ...(sessionId ? { sessionId } : {}), finalText, ...(resolvedModel ? { resolvedModel } : {}), ...(resolvedProvider ? { resolvedProvider } : {}), usage: Object.keys(usage).length ? usage : null, costUsd: costUsd ?? null, tools };
}

const MARKDOWN_LINK = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/gi;
const BARE_URL = /https?:\/\/[^\s<>"')\]]+/gi;
function trimUrlPunctuation(url: string): string { return url.replace(/[.,;:!?]+$/, ""); }

export function extractAnswerCandidates(text: string, aliases: Record<string, string>): AnswerCandidate[] {
  const found: Array<{ name: string; url: string }> = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) if (match[1] && match[2]) found.push({ name: match[1].trim(), url: match[2] });
  for (const rawUrl of text.match(BARE_URL) ?? []) {
    const url = trimUrlPunctuation(rawUrl);
    if (!found.some((item) => item.url === url)) found.push({ name: canonicalDomain(url) ?? url, url });
  }
  return [...new Map(found.map((item) => [canonicalKey(item.name, item.url, aliases), item])).entries()].map(([key, item], index) => {
    const domain = canonicalDomain(item.url);
    return { key, name: item.name, url: item.url, ...(domain ? { domain } : {}), rank: index + 1, selected: index === 0, confidence: 0.6, source: "local" as const };
  });
}

export function interviewDidResearch(evidence: TurnEvidence): boolean {
  return evidence.tools.some((tool) => /search|fetch|browser/i.test(tool.name));
}
