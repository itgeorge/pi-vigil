import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { VigilState } from "./types";

export const DEFAULT_SEARCH_MAX_RESULTS = 20;
export const MAX_SEARCH_MAX_RESULTS = 50;
export const MAX_SEARCH_EXCERPT_CHARS = 500;
export const DEFAULT_READ_CONTEXT = 1;
export const MAX_READ_CONTEXT = 10;
export const MAX_READ_WINDOW_ENTRIES = 21;
export const MAX_ENTRY_DETAIL_CHARS = 4_000;

export interface ChildSessionTranscriptEntry {
  entryId: string;
  parentId: string | null;
  timestamp: string;
  entryType: string;
  role?: string;
  searchableText: string;
  detailText: string;
}

export interface ChildSessionTranscript {
  entries: ChildSessionTranscriptEntry[];
}

export interface VigilSearchMatch {
  id: string;
  sessionId: string;
  name: string;
  state: VigilState;
  entryId: string;
  parentId: string | null;
  entryType: string;
  role?: string;
  timestamp: string;
  match: string;
}

export interface VigilSearchResult {
  matches: VigilSearchMatch[];
}

export interface VigilReadContextEntry {
  entryId: string;
  parentId: string | null;
  entryType: string;
  role?: string;
  timestamp: string;
  detail: string;
  isAnchor: boolean;
}

export interface VigilReadResult {
  id: string;
  sessionId: string;
  name: string;
  state: VigilState;
  anchorEntryId: string;
  anchorParentId: string | null;
  requestedBefore: number;
  requestedAfter: number;
  effectiveBefore: number;
  effectiveAfter: number;
  order: "jsonl-append-order";
  entries: VigilReadContextEntry[];
}

export interface SearchPolicy {
  query: string;
  includeCompleted: boolean;
  maxResults: number;
  id?: string;
}

export interface ReadPolicy {
  id: string;
  entryId: string;
  before: number;
  after: number;
  includeCompleted: boolean;
}

export function foldCase(value: string): string {
  return value.toLocaleLowerCase();
}

export function truncateVisible(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return "…";
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

export function serializeToolArguments(args: unknown, maxChars = 2_000): string {
  const serialized = serializeValue(args);
  return truncateVisible(serialized, maxChars);
}

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeValue(record[key])}`).join(",")}}`;
  }
  return String(value);
}

export function buildMatchExcerpt(text: string, query: string, maxChars: number): string {
  if (!text) {
    return "";
  }
  if (maxChars <= 0) {
    return "";
  }

  const foldedText = foldCase(text);
  const foldedQuery = foldCase(query);
  const matchIndex = foldedText.indexOf(foldedQuery);
  if (matchIndex < 0) {
    return truncateVisible(text, maxChars);
  }

  const matchLength = query.length;
  const budget = Math.max(matchLength, maxChars);
  const prefixBudget = Math.floor((budget - matchLength) / 2);
  const suffixBudget = budget - matchLength - prefixBudget;

  let start = Math.max(0, matchIndex - prefixBudget);
  let end = Math.min(text.length, matchIndex + matchLength + suffixBudget);

  if (end - start > maxChars) {
    end = start + maxChars;
  }

  let excerpt = text.slice(start, end);
  if (start > 0) {
    excerpt = `…${excerpt}`;
  }
  if (end < text.length) {
    excerpt = `${excerpt}…`;
  }

  return truncateVisible(excerpt, maxChars);
}

export function resolveSearchPolicy(input: {
  query?: string;
  id?: string;
  includeCompleted?: boolean;
  maxResults?: number;
}): SearchPolicy | { error: string } {
  const query = input.query?.trim() ?? "";
  if (!query) {
    return { error: "search requires query" };
  }

  if (input.id !== undefined && !input.id.trim()) {
    return { error: "search id must be nonblank when supplied" };
  }

  const maxResults = input.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
  if (!Number.isSafeInteger(maxResults) || maxResults <= 0 || maxResults > MAX_SEARCH_MAX_RESULTS) {
    return {
      error: `maxResults must be a positive safe integer no greater than ${MAX_SEARCH_MAX_RESULTS}`,
    };
  }

  return {
    query,
    includeCompleted: input.includeCompleted ?? false,
    maxResults,
    ...(input.id?.trim() ? { id: input.id.trim() } : {}),
  };
}

export function resolveReadPolicy(input: {
  id?: string;
  entryId?: string;
  before?: number;
  after?: number;
  includeCompleted?: boolean;
}): ReadPolicy | { error: string } {
  const id = input.id?.trim() ?? "";
  if (!id) {
    return { error: "read requires id" };
  }

  const entryId = input.entryId?.trim() ?? "";
  if (!entryId) {
    return { error: "read requires entryId" };
  }

  const before = input.before ?? DEFAULT_READ_CONTEXT;
  const after = input.after ?? DEFAULT_READ_CONTEXT;

  for (const [name, value, maximum] of [
    ["before", before, MAX_READ_CONTEXT],
    ["after", after, MAX_READ_CONTEXT],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      return { error: `${name} must be a nonnegative safe integer no greater than ${maximum}` };
    }
  }

  if (before + after + 1 > MAX_READ_WINDOW_ENTRIES) {
    return {
      error: `read window exceeds maximum of ${MAX_READ_WINDOW_ENTRIES} entries (before + anchor + after)`,
    };
  }

  return {
    id,
    entryId,
    before,
    after,
    includeCompleted: input.includeCompleted ?? false,
  };
}

function extractTextParts(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  let text = "";
  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const typed = part as { type?: string; text?: string };
    if (typed.type === "text" && typeof typed.text === "string") {
      text += typed.text;
    }
  }
  return text;
}

function projectMessageSearchable(entry: SessionEntry & { type: "message" }): {
  searchable: string;
  detail: string;
  role: string;
} {
  const role = entry.message.role;

  if (role === "user") {
    const text = extractTextParts(entry.message.content);
    return { searchable: text, detail: truncateVisible(text, MAX_ENTRY_DETAIL_CHARS), role };
  }

  if (role === "assistant") {
    const parts: string[] = [];
    const detailParts: string[] = [];
    for (const content of entry.message.content) {
      if (content.type === "text") {
        parts.push(content.text);
        detailParts.push(content.text);
      } else if (content.type === "toolCall") {
        const toolLine = `${content.name} ${serializeToolArguments(content.arguments)}`.trim();
        parts.push(toolLine);
        detailParts.push(toolLine);
      }
    }
    const searchable = parts.join("\n");
    return {
      searchable,
      detail: truncateVisible(detailParts.join("\n"), MAX_ENTRY_DETAIL_CHARS),
      role,
    };
  }

  if (role === "toolResult") {
    const text = extractTextParts(entry.message.content);
    const toolName = entry.message.toolName?.trim() ?? "";
    const searchable = [toolName, text].filter(Boolean).join("\n");
    const detail = truncateVisible(
      [toolName ? `tool: ${toolName}` : "", text].filter(Boolean).join("\n"),
      MAX_ENTRY_DETAIL_CHARS,
    );
    return { searchable, detail, role };
  }

  if (role === "bashExecution") {
    const command = entry.message.command ?? "";
    const output = entry.message.output ?? "";
    const searchable = [command, output].filter(Boolean).join("\n");
    const detail = truncateVisible(
      [`$ ${command}`, output].filter((line) => line.length > 0).join("\n"),
      MAX_ENTRY_DETAIL_CHARS,
    );
    return { searchable, detail, role };
  }

  if (role === "custom") {
    const text = extractTextParts(entry.message.content);
    return { searchable: text, detail: truncateVisible(text, MAX_ENTRY_DETAIL_CHARS), role };
  }

  if (role === "branchSummary") {
    const summary = entry.message.summary ?? "";
    return {
      searchable: summary,
      detail: truncateVisible(summary, MAX_ENTRY_DETAIL_CHARS),
      role,
    };
  }

  if (role === "compactionSummary") {
    const summary = entry.message.summary ?? "";
    return {
      searchable: summary,
      detail: truncateVisible(summary, MAX_ENTRY_DETAIL_CHARS),
      role,
    };
  }

  return {
    searchable: "",
    detail: truncateVisible(`${role} entry`, MAX_ENTRY_DETAIL_CHARS),
    role,
  };
}

export function projectTranscriptEntry(entry: SessionEntry): ChildSessionTranscriptEntry | null {
  const base = {
    entryId: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
  };

  if (entry.type === "message") {
    const projected = projectMessageSearchable(entry);
    return {
      ...base,
      entryType: "message",
      role: projected.role,
      searchableText: projected.searchable,
      detailText: projected.detail,
    };
  }

  if (entry.type === "custom_message") {
    const text = extractTextParts(entry.content);
    return {
      ...base,
      entryType: "custom_message",
      searchableText: text,
      detailText: truncateVisible(text, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "compaction") {
    const summary = entry.summary ?? "";
    return {
      ...base,
      entryType: "compaction",
      searchableText: summary,
      detailText: truncateVisible(summary, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "branch_summary") {
    const summary = entry.summary ?? "";
    return {
      ...base,
      entryType: "branch_summary",
      searchableText: summary,
      detailText: truncateVisible(summary, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "model_change") {
    const searchable = `${entry.provider}/${entry.modelId}`;
    return {
      ...base,
      entryType: "model_change",
      searchableText: searchable,
      detailText: truncateVisible(`model: ${searchable}`, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "thinking_level_change") {
    const searchable = entry.thinkingLevel ?? "";
    return {
      ...base,
      entryType: "thinking_level_change",
      searchableText: searchable,
      detailText: truncateVisible(`thinking level: ${searchable}`, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "label") {
    const searchable = [entry.targetId, entry.label ?? ""].filter(Boolean).join(" ");
    return {
      ...base,
      entryType: "label",
      searchableText: searchable,
      detailText: truncateVisible(
        entry.label ? `label: ${entry.label}` : "label cleared",
        MAX_ENTRY_DETAIL_CHARS,
      ),
    };
  }

  if (entry.type === "custom") {
    return null;
  }

  if (entry.type === "session_info") {
    return null;
  }

  return null;
}

export function projectTranscriptEntries(entries: SessionEntry[]): ChildSessionTranscriptEntry[] {
  const projected: ChildSessionTranscriptEntry[] = [];
  for (const entry of entries) {
    try {
      const item = projectTranscriptEntry(entry);
      if (item) {
        projected.push(item);
      }
    } catch {
      // Malformed records are skipped without leaking raw JSON.
    }
  }
  return projected;
}

export function parseChildSessionTranscript(entries: SessionEntry[]): ChildSessionTranscript {
  return { entries: projectTranscriptEntries(entries) };
}

function literalMatch(searchableText: string, query: string): boolean {
  return foldCase(searchableText).includes(foldCase(query));
}

export function searchTranscriptEntries(
  transcript: ChildSessionTranscript,
  query: string,
  child: { id: string; sessionId: string; name: string; state: VigilState },
  maxResults: number,
): VigilSearchMatch[] {
  const matches: VigilSearchMatch[] = [];
  for (const entry of transcript.entries) {
    if (!literalMatch(entry.searchableText, query)) {
      continue;
    }

    matches.push({
      id: child.id,
      sessionId: child.sessionId,
      name: child.name,
      state: child.state,
      entryId: entry.entryId,
      parentId: entry.parentId,
      entryType: entry.entryType,
      ...(entry.role ? { role: entry.role } : {}),
      timestamp: entry.timestamp,
      match: buildMatchExcerpt(entry.searchableText, query, MAX_SEARCH_EXCERPT_CHARS),
    });

    if (matches.length >= maxResults) {
      break;
    }
  }

  return matches;
}

function formatShortVigilId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed.startsWith("vigil-")) {
    return trimmed;
  }
  const suffix = trimmed.slice("vigil-".length).replace(/-/g, "");
  return suffix ? `vigil-${suffix.slice(0, 7)}` : "vigil-?";
}

function formatEntryIdentity(entry: VigilReadContextEntry | VigilSearchMatch): string {
  const role = "role" in entry && entry.role ? `/${entry.role}` : "";
  return `${entry.entryType}${role}`;
}

export function formatSearchText(result: VigilSearchResult): string {
  const header = [`matches: ${result.matches.length}`];
  if (result.matches.length === 0) {
    return header.join("\n");
  }

  const blocks = result.matches.map((match) => {
    const parent = match.parentId ?? "null";
    const lines = [
      `${match.name} [${formatShortVigilId(match.id)}] · entry ${match.entryId} · parent ${parent}`,
      `${formatEntryIdentity(match)} · ${match.timestamp}`,
      match.match,
    ];
    return lines.join("\n");
  });

  return [...header, "", ...blocks].join("\n");
}

export function formatReadText(result: VigilReadResult): string {
  const header = [
    `child: ${result.name} [${formatShortVigilId(result.id)}]`,
    `anchor: ${result.anchorEntryId} · window: ${result.effectiveBefore} before, ${result.effectiveAfter} after · order: JSONL append order`,
  ];

  const entryBlocks = result.entries.map((entry) => {
    const anchorMarker = entry.isAnchor ? " (anchor)" : "";
    return [
      `${entry.entryId} · ${formatEntryIdentity(entry)} · ${entry.timestamp}${anchorMarker}`,
      entry.detail,
    ].join("\n");
  });

  return [...header, "", ...entryBlocks].join("\n");
}

export function readTranscriptWindow(
  transcript: ChildSessionTranscript,
  entryId: string,
  before: number,
  after: number,
): VigilReadContextEntry[] | { error: string } {
  const anchorIndex = transcript.entries.findIndex((entry) => entry.entryId === entryId);
  if (anchorIndex < 0) {
    return { error: `Unknown child session entry: ${entryId}` };
  }

  const start = Math.max(0, anchorIndex - before);
  const end = Math.min(transcript.entries.length - 1, anchorIndex + after);

  return transcript.entries.slice(start, end + 1).map((entry) => ({
    entryId: entry.entryId,
    parentId: entry.parentId,
    entryType: entry.entryType,
    ...(entry.role ? { role: entry.role } : {}),
    timestamp: entry.timestamp,
    detail: entry.detailText,
    isAnchor: entry.entryId === entryId,
  }));
}
