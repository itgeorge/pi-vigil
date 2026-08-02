import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { VigilState } from "./types";

export const DEFAULT_SEARCH_MAX_RESULTS = 20;
export const MAX_SEARCH_MAX_RESULTS = 50;
export const MAX_SEARCH_EXCERPT_CHARS = 500;
export const DEFAULT_READ_CONTEXT = 1;
export const MAX_READ_CONTEXT = 10;
export const MAX_READ_WINDOW_ENTRIES = 21;
export const MAX_ENTRY_DETAIL_CHARS = 4_000;
export const MAX_DISPLAY_NAME_CHARS = 120;
export const MAX_DISPLAY_ID_CHARS = 128;
export const MAX_DISPLAY_METADATA_CHARS = 120;

const C0_C1_CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u0085\u2028\u2029]/g;
const ANSI_SEQUENCE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

export function stripTerminalControls(text: string, preserveNewlines = false): string {
  let cleaned = text.replace(OSC_SEQUENCE, "").replace(ANSI_SEQUENCE, "");
  cleaned = cleaned.replace(C0_C1_CONTROL, (character) => {
    if (preserveNewlines && (character === "\n" || character === "\r" || character === "\t")) {
      return character;
    }
    return "";
  });
  return cleaned;
}

export function sanitizeDisplayField(text: string, maxChars: number): string {
  const cleaned = stripTerminalControls(text).replace(/\s+/g, " ").trim();
  return truncateVisible(cleaned, maxChars);
}

export function sanitizeDisplayMultiline(text: string, maxChars: number): string {
  const cleaned = stripTerminalControls(text, true)
    .split("\n")
    .map((line) => line.replace(/\r/g, ""))
    .join("\n");
  return truncateVisible(cleaned, maxChars);
}

function validateExactOptionalId(value: string | undefined, label: string): string | { error: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== value.trim()) {
    return { error: `${label} must not contain leading or trailing whitespace` };
  }
  if (!value) {
    return { error: `${label} must be nonblank when supplied` };
  }
  return value;
}

function validateExactRequiredId(value: string | undefined, missingError: string, label: string): string | { error: string } {
  if (value === undefined || value === "") {
    return { error: missingError };
  }
  if (value !== value.trim()) {
    return { error: `${label} must not contain leading or trailing whitespace` };
  }
  if (!value) {
    return { error: missingError };
  }
  return value;
}

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
  return sanitizeDisplayField(serialized, maxChars);
}

function serializeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
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

  const validatedId =
    input.id === undefined ? undefined : validateExactOptionalId(input.id, "search id");
  if (validatedId && typeof validatedId === "object" && "error" in validatedId) {
    return validatedId;
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
    ...(typeof validatedId === "string" ? { id: validatedId } : {}),
  };
}

export function resolveReadPolicy(input: {
  id?: string;
  entryId?: string;
  before?: number;
  after?: number;
  includeCompleted?: boolean;
}): ReadPolicy | { error: string } {
  const id = validateExactRequiredId(input.id, "read requires id", "read id");
  if (typeof id === "object" && "error" in id) {
    return id;
  }

  const entryId = validateExactRequiredId(input.entryId, "read requires entryId", "read entryId");
  if (typeof entryId === "object" && "error" in entryId) {
    return entryId;
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
} | null {
  const role = entry.message?.role;
  if (typeof role !== "string" || !role) {
    return null;
  }

  if (role === "user") {
    const text = extractTextParts(entry.message.content);
    return {
      searchable: text,
      detail: sanitizeDisplayMultiline(text, MAX_ENTRY_DETAIL_CHARS),
      role,
    };
  }

  if (role === "assistant") {
    if (!Array.isArray(entry.message.content)) {
      return null;
    }
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
      detail: sanitizeDisplayMultiline(detailParts.join("\n"), MAX_ENTRY_DETAIL_CHARS),
      role,
    };
  }

  if (role === "toolResult") {
    const text = extractTextParts(entry.message.content);
    const toolName = entry.message.toolName?.trim() ?? "";
    const searchable = [toolName, text].filter(Boolean).join("\n");
    const detail = sanitizeDisplayMultiline(
      [toolName ? `tool: ${toolName}` : "", text].filter(Boolean).join("\n"),
      MAX_ENTRY_DETAIL_CHARS,
    );
    return { searchable, detail, role };
  }

  if (role === "bashExecution") {
    const command = entry.message.command ?? "";
    const output = entry.message.output ?? "";
    const searchable = [command, output].filter(Boolean).join("\n");
    const detail = sanitizeDisplayMultiline(
      [`$ ${command}`, output].filter((line) => line.length > 0).join("\n"),
      MAX_ENTRY_DETAIL_CHARS,
    );
    return { searchable, detail, role };
  }

  if (role === "custom") {
    const text = extractTextParts(entry.message.content);
    return {
      searchable: text,
      detail: sanitizeDisplayMultiline(text, MAX_ENTRY_DETAIL_CHARS),
      role,
    };
  }

  if (role === "branchSummary") {
    const summary = entry.message.summary ?? "";
    return {
      searchable: summary,
      detail: sanitizeDisplayMultiline(summary, MAX_ENTRY_DETAIL_CHARS),
      role,
    };
  }

  if (role === "compactionSummary") {
    const summary = entry.message.summary ?? "";
    return {
      searchable: summary,
      detail: sanitizeDisplayMultiline(summary, MAX_ENTRY_DETAIL_CHARS),
      role,
    };
  }

  return {
    searchable: "",
    detail: sanitizeDisplayField(`${role} entry`, MAX_ENTRY_DETAIL_CHARS),
    role,
  };
}

function isValidTranscriptBaseMetadata(entry: SessionEntry): boolean {
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.trim().length === 0) {
    return false;
  }
  if (entry.parentId !== null && typeof entry.parentId !== "string") {
    return false;
  }
  if (typeof entry.timestamp !== "string" || entry.timestamp.length === 0 || entry.timestamp.trim().length === 0) {
    return false;
  }
  return true;
}

export function projectTranscriptEntry(entry: SessionEntry): ChildSessionTranscriptEntry | null {
  if (!isValidTranscriptBaseMetadata(entry)) {
    return null;
  }

  const base = {
    entryId: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
  };

  if (entry.type === "message") {
    const projected = projectMessageSearchable(entry);
    if (!projected) {
      return null;
    }
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
      detailText: sanitizeDisplayMultiline(text, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "compaction") {
    const summary = entry.summary ?? "";
    return {
      ...base,
      entryType: "compaction",
      searchableText: summary,
      detailText: sanitizeDisplayMultiline(summary, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "branch_summary") {
    const summary = entry.summary ?? "";
    return {
      ...base,
      entryType: "branch_summary",
      searchableText: summary,
      detailText: sanitizeDisplayMultiline(summary, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "model_change") {
    const searchable = `${entry.provider}/${entry.modelId}`;
    return {
      ...base,
      entryType: "model_change",
      searchableText: searchable,
      detailText: sanitizeDisplayField(`model: ${searchable}`, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "thinking_level_change") {
    const searchable = entry.thinkingLevel ?? "";
    return {
      ...base,
      entryType: "thinking_level_change",
      searchableText: searchable,
      detailText: sanitizeDisplayField(`thinking level: ${searchable}`, MAX_ENTRY_DETAIL_CHARS),
    };
  }

  if (entry.type === "label") {
    const searchable = [entry.targetId, entry.label ?? ""].filter(Boolean).join(" ");
    return {
      ...base,
      entryType: "label",
      searchableText: searchable,
      detailText: sanitizeDisplayField(
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
      match: sanitizeDisplayMultiline(
        buildMatchExcerpt(entry.searchableText, query, MAX_SEARCH_EXCERPT_CHARS),
        MAX_SEARCH_EXCERPT_CHARS,
      ),
    });

    if (matches.length >= maxResults) {
      break;
    }
  }

  return matches;
}

function formatShortVigilId(id: string): string {
  const trimmed = sanitizeDisplayField(id, MAX_DISPLAY_ID_CHARS);
  if (!trimmed.startsWith("vigil-")) {
    return sanitizeDisplayField(trimmed, MAX_DISPLAY_ID_CHARS);
  }
  const suffix = trimmed.slice("vigil-".length).replace(/-/g, "");
  return suffix ? `vigil-${suffix.slice(0, 7)}` : "vigil-?";
}

function formatEntryIdentity(entry: VigilReadContextEntry | VigilSearchMatch): string {
  const role = "role" in entry && entry.role ? `/${sanitizeDisplayField(entry.role, MAX_DISPLAY_METADATA_CHARS)}` : "";
  return `${sanitizeDisplayField(entry.entryType, MAX_DISPLAY_METADATA_CHARS)}${role}`;
}

function formatTextEntryId(entryId: string): string {
  return sanitizeDisplayField(entryId, MAX_DISPLAY_ID_CHARS);
}

function formatTextParentId(parentId: string | null): string {
  return parentId === null ? "null" : sanitizeDisplayField(parentId, MAX_DISPLAY_ID_CHARS);
}

export function formatSearchText(result: VigilSearchResult): string {
  const header = [`matches: ${result.matches.length}`];
  if (result.matches.length === 0) {
    return header.join("\n");
  }

  const blocks = result.matches.map((match) => {
    const parent = formatTextParentId(match.parentId);
    const lines = [
      `${sanitizeDisplayField(match.name, MAX_DISPLAY_NAME_CHARS)} [${formatShortVigilId(match.id)}] · entry ${formatTextEntryId(match.entryId)} · parent ${parent}`,
      `${formatEntryIdentity(match)} · ${sanitizeDisplayField(match.timestamp, MAX_DISPLAY_METADATA_CHARS)}`,
      sanitizeDisplayMultiline(match.match, MAX_SEARCH_EXCERPT_CHARS),
    ];
    return lines.join("\n");
  });

  return [...header, "", ...blocks].join("\n");
}

export function formatReadText(result: VigilReadResult): string {
  const header = [
    `child: ${sanitizeDisplayField(result.name, MAX_DISPLAY_NAME_CHARS)} [${formatShortVigilId(result.id)}]`,
    `anchor: ${formatTextEntryId(result.anchorEntryId)} · window: ${result.effectiveBefore} before, ${result.effectiveAfter} after · order: JSONL append order`,
  ];

  const entryBlocks = result.entries.map((entry) => {
    const anchorMarker = entry.isAnchor ? " (anchor)" : "";
    return [
      `${formatTextEntryId(entry.entryId)} · ${formatEntryIdentity(entry)} · ${sanitizeDisplayField(entry.timestamp, MAX_DISPLAY_METADATA_CHARS)}${anchorMarker}`,
      sanitizeDisplayMultiline(entry.detail, MAX_ENTRY_DETAIL_CHARS),
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
