/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";
import type { Content } from "../../../gemini-cli/packages/core/src/index.js";
import { buildHistoryFromMessages } from "./resumeFromDisk.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionMessage = {
  type: string;
  content: unknown;
  timestamp?: number | string;
  toolCalls?: Array<{ name: string; result: unknown }>;
};

// ---------------------------------------------------------------------------
// Structured context types
// ---------------------------------------------------------------------------

export type StructuredEntity = {
  type: string; // 'person' | 'system' | 'tool' | etc.
  name: string;
  attrs: Record<string, unknown>;
};

export type StructuredBehavior = {
  content: string;
  confidence: "high" | "medium" | "low";
};

export type StructuredDecision = {
  topic: string;
  content: string;
  date?: string;
};

export type StructuredPreference = {
  content: string;
};

export type StructuredProject = {
  name: string;
  status: string;
  key_rules: string[];
};

export type StructuredContext = {
  entities: StructuredEntity[];
  behaviors: StructuredBehavior[];
  decisions: StructuredDecision[];
  preferences: StructuredPreference[];
  projects: StructuredProject[];
};

export const EMPTY_STRUCTURED_CONTEXT: StructuredContext = {
  entities: [],
  behaviors: [],
  decisions: [],
  preferences: [],
  projects: [],
};

export type SummaryState = {
  /** Natural language summary (fallback). */
  summary: string;
  /** Structured JSON context (preferred). */
  structuredContext?: StructuredContext;
  /**
   * Map of filename → mtime (ms) at the time it was last processed.
   * A file is re-processed if its current mtime is newer than the recorded value.
   */
  processedFileMtimes: Record<string, number>;
  /** Unix timestamp (ms) when the summary was last updated. */
  updatedAt: number;
  /** @deprecated use processedFileMtimes instead */
  processedFiles?: string[];
};

/**
 * Returns files that are new or have been modified since they were last processed.
 */
export function getNewOrUpdatedFiles(
  files: Array<{ name: string; mtime: number }>,
  state: SummaryState | null,
): Array<{ name: string; mtime: number }> {
  if (!state) return files;
  const recorded = state.processedFileMtimes ?? {};
  return files.filter((f) => {
    const lastMtime = recorded[f.name];
    return lastMtime === undefined || f.mtime > lastMtime;
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const SUMMARY_FILENAME = "session_summary.json";

export function loadSummaryState(memoryDir: string): SummaryState | null {
  const filePath = path.join(memoryDir, SUMMARY_FILENAME);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as SummaryState;
  } catch (_e) {
    return null;
  }
}

export function saveSummaryState(memoryDir: string, state: SummaryState): void {
  const filePath = path.join(memoryDir, SUMMARY_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

export type SummaryOptions = {
  /** Max number of LLM call attempts. Default: 3. */
  maxRetries?: number;
  /** Delay between retries in ms. Default: 1000. */
  retryDelayMs?: number;
};

/**
 * Generates or updates the conversation summary.
 *
 * - If newMessages is empty, returns the existing summary unchanged (no LLM call).
 * - If existingSummary is null, summarizes newMessages from scratch.
 * - Otherwise, merges existingSummary + newMessages into an updated summary.
 * - Retries on transient network errors; falls back to existingSummary on all failures.
 */
export async function buildIncrementalSummary(
  newMessages: SessionMessage[],
  existingSummary: string | null,
  generateText: (prompt: string) => Promise<string>,
  options: SummaryOptions = {},
): Promise<string> {
  if (newMessages.length === 0) {
    return existingSummary ?? "";
  }

  const newConversation = messagesToText(newMessages);

  const prompt = existingSummary
    ? `
<system_role>
You are the Memory Engine for Jarvis, an advanced personal AI assistant.
Your goal is to maintain a coherent, evolving compressed history of the user's conversations.
</system_role>

<existing_summary>
${existingSummary}
</existing_summary>

<new_conversation>
${newConversation}
</new_conversation>

<task>
Update the compressed history by integrating the new conversation. Follow these rules:

1. **Time Priority (CRITICAL)**: If new information contradicts or supersedes the existing summary, overwrite the older facts with the newer ones. Never keep conflicting information.

2. **Keep Only Durable Signal**: Keep stable preferences, important decisions, active personal/technical/strategic project context, recurring behaviors, and unresolved follow-ups. Drop greetings, filler, repeated analysis, and temporary details that are unlikely to matter later.

3. **Format**: Rewrite into compact Markdown bullets grouped by topic. Do not write a narrative paragraph.

4. **Causal Relationships**: Preserve why something matters only when it changes future behavior, decisions, or constraints.

5. **Constraint**: Maximum 250 words. Prefer 6-12 bullets total. Concise professional English.
</task>

Updated compressed history (Markdown):
`.trim()
    : `
<system_role>
You are the Memory Engine for Jarvis, an advanced personal AI assistant.
Your goal is to create a compressed history of the user's conversations.
</system_role>

<new_conversation>
${newConversation}
</new_conversation>

<task>
Compress this conversation into compact Markdown bullets grouped by topic.

Keep only durable signal:
- stable preferences
- important decisions
- active personal, technical, or strategic project context
- recurring behaviors
- unresolved follow-ups

Drop greetings, filler, repeated analysis, and temporary details.
Keep causal context only when it affects future behavior, decisions, or constraints.
Maximum 250 words. Prefer 6-12 bullets total.
</task>

Compressed history (Markdown):
`.trim();

  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await generateText(prompt);
    } catch (e: any) {
      const isLast = attempt === maxRetries;
      if (isLast) {
        console.error(
          `⚠️ [SessionSummarizer] Summary generation failed after ${maxRetries} attempts: ${e.message}. Using existing summary.`,
        );
        return existingSummary ?? "";
      }
      console.error(
        `⚠️ [SessionSummarizer] Attempt ${attempt} failed: ${e.message}. Retrying in ${retryDelayMs}ms...`,
      );
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return existingSummary ?? "";
}

export type ChunkedSummaryOptions = SummaryOptions & {
  chunkSize?: number;
  maxSummaryLength?: number;
  onProgress?: (message: string) => void;
};

export async function buildChunkedRollingSummary(
  newMessages: SessionMessage[],
  existingSummary: string | null,
  generateText: (prompt: string) => Promise<string>,
  options: ChunkedSummaryOptions = {},
): Promise<string> {
  if (newMessages.length === 0) return existingSummary ?? "";

  const chunkSize = options.chunkSize ?? 100;
  const chunks: SessionMessage[][] =
    chunkSize > 0 && newMessages.length > chunkSize
      ? Array.from(
          { length: Math.ceil(newMessages.length / chunkSize) },
          (_, i) => newMessages.slice(i * chunkSize, (i + 1) * chunkSize),
        )
      : [newMessages];

  if (chunks.length > 1) {
    options.onProgress?.(
      `Chunked summarization: ${newMessages.length} messages -> ${chunks.length} chunks of ~${chunkSize}`,
    );
  }

  let rollingSummary = existingSummary || null;
  const maxLen = options.maxSummaryLength ?? 1200;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunks.length > 1) {
      options.onProgress?.(
        `Summarizing chunk ${i + 1}/${chunks.length} (${chunk.length} messages)...`,
      );
    }
    const newSummary = await buildIncrementalSummary(
      chunk,
      rollingSummary,
      generateText,
      {
        maxRetries: options.maxRetries,
        retryDelayMs: options.retryDelayMs,
      },
    );
    if (newSummary.trim().length > 0) {
      rollingSummary = await recompressSummaryIfNeeded(
        newSummary.trim(),
        maxLen,
        generateText,
        options.onProgress,
      );
    }
  }

  return rollingSummary ?? "";
}

async function recompressSummaryIfNeeded(
  summary: string,
  maxLen: number,
  generateText: (prompt: string) => Promise<string>,
  onProgress?: (message: string) => void,
): Promise<string> {
  if (maxLen <= 0 || summary.length <= maxLen) return summary;

  onProgress?.(
    `Summary too long (${summary.length} > ${maxLen} chars) - re-compressing...`,
  );
  try {
    const recompressed = await generateText(
      `Compress the following session summary to under ${maxLen} characters. ` +
        `Keep only durable preferences, important decisions, active project context, recurring behaviors, and unresolved follow-ups. ` +
        `Remove filler, repeated analysis, and temporary details.\n\n${summary}`,
    );
    if (
      recompressed.trim().length > 0 &&
      recompressed.length < summary.length
    ) {
      const trimmed = recompressed.trim();
      onProgress?.(`Re-compressed to ${trimmed.length} chars.`);
      return trimmed;
    }
  } catch (_e) {
    /* keep original if re-compression fails */
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Structured context
// ---------------------------------------------------------------------------

const STRUCTURED_CONTEXT_PROMPT = (conversation: string, existing: string) =>
  `
You are extracting structured knowledge about the USER from a conversation with Jarvis (an AI assistant).

${existing ? `Current knowledge (merge/update this, do not duplicate):\n${existing}\n\n` : ""}New conversation to process:
${conversation}

Output ONLY valid JSON with this exact structure. No markdown, no explanation, no extra keys.

STRICT RULES per field:

"entities": ONLY the user themselves as a person. Do not add tools, companies, AI systems, competitors, or concepts.
  Required attrs for the user: name, profession, skills (list what is known, leave empty array if unknown).
  Example: { "type": "person", "name": "David", "attrs": { "name": "David Liu", "profession": "software engineer", "skills": ["TypeScript", "system design"] } }

"behaviors": ONLY recurring, habitual actions the user does regularly — NOT one-time events or single-conversation topics.
  Must include frequency or regularity (e.g. "weekly", "regularly", "every day", "at least N times").
  Write as "user [verb]..." statements. Be specific.
  BAD (reject these): "user researches topics", "user works on projects", "user discussed X" (one-time)
  GOOD: "user runs at least 3 times a week", "user reads books regularly", "user cycles on weekends"
  Example: { "content": "user runs at least 3 times a week", "confidence": "high" }

"decisions": Important choices, strategies, or rules the user has committed to.
  Include investment strategies, architectural decisions, project rules.
  Example: { "topic": "investment", "content": "core-satellite strategy: 70% index funds + 30% individual stocks", "date": "2026-03" }

"preferences": ONLY how the user wants Jarvis to format or style responses.
  Response style, language, output format, tone. NOT personal interests or hobbies.
  Example: { "content": "prefers concise answers in Chinese with tables for data" }

"projects": Only projects the user actively owns or works on. Not upstream dependencies or tools.
  key_rules: constraints that Jarvis must follow for this project.
  Example: { "name": "jarvis-personal-ai", "status": "active", "key_rules": ["do not modify gemini-cli source code"] }

Merge rules:
- Same person entity → update attrs (do not create duplicate person entries)
- Same behavior content → keep higher confidence, do not duplicate
- Same decision topic+content → keep, do not duplicate
- Omit fields with no data (empty arrays are fine)

JSON output:
`.trim();

/**
 * Builds or updates a StructuredContext from new messages.
 * Falls back to existing context (or empty) on parse failure.
 */
export async function buildStructuredContext(
  newMessages: SessionMessage[],
  existing: StructuredContext | null,
  generateText: (prompt: string) => Promise<string>,
  options: SummaryOptions = {},
): Promise<StructuredContext> {
  if (newMessages.length === 0) {
    return existing ?? { ...EMPTY_STRUCTURED_CONTEXT };
  }

  const conversation = messagesToText(newMessages);
  const existingJson = existing ? JSON.stringify(existing, null, 2) : "";
  const prompt = STRUCTURED_CONTEXT_PROMPT(conversation, existingJson);

  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const raw = await generateText(prompt);
      // Extract JSON from response (may have surrounding text)
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON object found in response");
      const parsed = JSON.parse(match[0]) as StructuredContext;
      // Validate required fields
      if (!Array.isArray(parsed.entities))
        throw new Error("Invalid structure: missing entities");
      return {
        entities: parsed.entities ?? [],
        behaviors: parsed.behaviors ?? [],
        decisions: parsed.decisions ?? [],
        preferences: parsed.preferences ?? [],
        projects: parsed.projects ?? [],
      };
    } catch (e: any) {
      const isLast = attempt === maxRetries;
      if (isLast) {
        console.error(
          `⚠️ [SessionSummarizer] Structured context generation failed: ${e.message}. Using existing.`,
        );
        return existing ?? { ...EMPTY_STRUCTURED_CONTEXT };
      }
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return existing ?? { ...EMPTY_STRUCTURED_CONTEXT };
}

/**
 * Merges incoming StructuredContext into existing, deduplicating by name/content.
 */
export function mergeStructuredContext(
  existing: StructuredContext,
  incoming: StructuredContext,
): StructuredContext {
  // Merge entities: same name → merge attrs
  const entityMap = new Map<string, StructuredEntity>();
  for (const e of [...existing.entities, ...incoming.entities]) {
    const key = `${e.type}:${e.name.toLowerCase()}`;
    if (entityMap.has(key)) {
      entityMap.get(key)!.attrs = { ...entityMap.get(key)!.attrs, ...e.attrs };
    } else {
      entityMap.set(key, { ...e, attrs: { ...e.attrs } });
    }
  }

  // Merge behaviors: deduplicate by content similarity (exact match for now)
  const behaviorSet = new Set(
    existing.behaviors.map((b) => b.content.toLowerCase()),
  );
  const behaviors = [...existing.behaviors];
  for (const b of incoming.behaviors) {
    if (!behaviorSet.has(b.content.toLowerCase())) {
      behaviors.push(b);
      behaviorSet.add(b.content.toLowerCase());
    }
  }

  // Merge decisions: deduplicate by topic+content
  const decisionSet = new Set(
    existing.decisions.map((d) => `${d.topic}:${d.content}`),
  );
  const decisions = [...existing.decisions];
  for (const d of incoming.decisions) {
    if (!decisionSet.has(`${d.topic}:${d.content}`)) {
      decisions.push(d);
    }
  }

  // Merge preferences: deduplicate by content
  const prefSet = new Set(
    existing.preferences.map((p) => p.content.toLowerCase()),
  );
  const preferences = [...existing.preferences];
  for (const p of incoming.preferences) {
    if (!prefSet.has(p.content.toLowerCase())) {
      preferences.push(p);
    }
  }

  // Merge projects: same name → update
  const projectMap = new Map(
    existing.projects.map((p) => [p.name.toLowerCase(), { ...p }]),
  );
  for (const p of incoming.projects) {
    const key = p.name.toLowerCase();
    if (projectMap.has(key)) {
      const existing = projectMap.get(key)!;
      existing.status = p.status;
      existing.key_rules = [
        ...new Set([...existing.key_rules, ...p.key_rules]),
      ];
    } else {
      projectMap.set(key, { ...p });
    }
  }

  return {
    entities: [...entityMap.values()],
    behaviors,
    decisions,
    preferences,
    projects: [...projectMap.values()],
  };
}

/**
 * Renders StructuredContext as a compact text block for LLM injection.
 * Returns empty string if context is empty.
 */
export function renderStructuredContext(ctx: StructuredContext): string {
  const lines: string[] = [];

  if (ctx.entities.length > 0) {
    for (const e of ctx.entities) {
      const attrs = Object.entries(e.attrs)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      lines.push(
        `${e.type === "person" ? "👤" : "🔧"} ${e.name}${attrs ? ` (${attrs})` : ""}`,
      );
    }
  }

  if (ctx.behaviors.length > 0) {
    lines.push("Behaviors: " + ctx.behaviors.map((b) => b.content).join("; "));
  }

  if (ctx.preferences.length > 0) {
    lines.push(
      "Preferences: " + ctx.preferences.map((p) => p.content).join("; "),
    );
  }

  if (ctx.decisions.length > 0) {
    for (const d of ctx.decisions) {
      lines.push(
        `Decision [${d.topic}${d.date ? ", " + d.date : ""}]: ${d.content}`,
      );
    }
  }

  if (ctx.projects.length > 0) {
    for (const p of ctx.projects) {
      const rules =
        p.key_rules.length > 0 ? ` — rules: ${p.key_rules.join(", ")}` : "";
      lines.push(`Project: ${p.name} (${p.status})${rules}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// History construction
// ---------------------------------------------------------------------------

/**
 * Builds a Content[] history that starts with a context prefix followed by
 * the recent raw message turns.
 *
 * The compressed history is injected as a user→model exchange so the LLM
 * treats it as established context rather than a new instruction.
 */
export function buildHistoryWithSummary(
  summary: string,
  recentMessages: SessionMessage[],
): Content[] {
  const history: Content[] = [];

  if (summary.trim()) {
    history.push({
      role: "user",
      parts: [{ text: `[CONVERSATION HISTORY SUMMARY]\n${summary}` }],
    });
    history.push({
      role: "model",
      parts: [
        {
          text: "Understood. I will use this compressed history summary as context.",
        },
      ],
    });
  }

  // Append recent raw turns
  const recentHistory = buildHistoryFromMessages(recentMessages);
  history.push(...recentHistory);

  return history;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUMMARY_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "as",
  "at",
  "by",
  "from",
  "this",
  "that",
  "it",
  "user",
  "jarvis",
  "请",
  "帮",
  "一下",
  "一个",
  "我们",
  "你",
  "我",
]);

function tokenizeForRelevance(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  const tokens: string[] = [];

  for (const rawToken of matches) {
    if (SUMMARY_STOPWORDS.has(rawToken)) continue;
    tokens.push(rawToken);

    if (/^\p{Script=Han}+$/u.test(rawToken) && rawToken.length > 2) {
      for (let size = 2; size <= Math.min(4, rawToken.length); size++) {
        for (let i = 0; i <= rawToken.length - size; i++) {
          tokens.push(rawToken.slice(i, i + size));
        }
      }
    }
  }

  return [...new Set(tokens)];
}

export function extractSummaryChunks(summary: string): string[] {
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let currentHeading = "";

  const splitBullet = (text: string): string[] => {
    // Split on sentence-ending punctuation followed by whitespace.
    // For " - " (hyphen), only split when both sides are long enough (>= 15
    // chars) to avoid severing labels from values like "NVDA - target $1200".
    const sentenceParts = text.split(/(?<=[。！？.!?；;])\s+/u);
    const parts: string[] = [];
    for (const part of sentenceParts) {
      const dashSplit = part.split(/\s+-\s+/);
      if (
        dashSplit.length > 1 &&
        dashSplit.every((s) => s.trim().length >= 15)
      ) {
        parts.push(...dashSplit.map((s) => s.trim()));
      } else {
        parts.push(part.trim());
      }
    }
    return parts.filter(Boolean).length > 0
      ? parts.filter(Boolean)
      : [text.trim()];
  };

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      currentHeading = line.replace(/^#{1,6}\s+/, "").trim();
      continue;
    }

    const bullet = line.replace(/^[-*]\s+/, "").trim();
    if (!bullet) continue;

    for (const part of splitBullet(bullet)) {
      if (part.length < 8) continue;
      chunks.push(currentHeading ? `${currentHeading}: ${part}` : part);
    }
  }

  if (chunks.length === 0 && summary.trim()) {
    chunks.push(summary.trim());
  }

  return chunks;
}

export function summarizeChunkPreview(chunks: string[], limit = 4): string[] {
  return chunks.slice(0, limit).map((chunk) => {
    const cleaned = chunk.replace(/\s+/g, " ").trim();
    return cleaned.length <= 80
      ? cleaned
      : `${cleaned.slice(0, 80).trimEnd()}…`;
  });
}

export function buildSummarySectionFromChunks(chunks: string[]): string {
  if (chunks.length === 0) {
    return "";
  }

  const compactSnippet = (text: string, maxLen = 300): string => {
    const cleaned = text.replace(/\s+/g, " ").trim();
    const firstSentence =
      cleaned.split(/(?<=[。！？.!?；;])/u)[0]?.trim() ?? cleaned;
    if (firstSentence.length <= maxLen) return firstSentence;
    return `${firstSentence.slice(0, maxLen).trimEnd()}…`;
  };

  return (
    "\n<relevant_session_summary>\n" +
    chunks.map((item) => `- ${compactSnippet(item)}`).join("\n") +
    "\n</relevant_session_summary>"
  );
}

export function buildRelevantSummarySectionFallback(
  summary: string,
  userPrompt: string,
  maxItems = 3,
  minScore = 2,
): string {
  if (!summary.trim() || !userPrompt.trim() || maxItems <= 0) {
    return "";
  }

  const promptTokens = new Set(tokenizeForRelevance(userPrompt));
  if (promptTokens.size === 0) {
    return "";
  }

  const rankedChunks = extractSummaryChunks(summary)
    .map((chunk, index) => {
      const lowerChunk = chunk.toLowerCase();
      let score = 0;
      for (const token of promptTokens) {
        if (lowerChunk.includes(token)) {
          score += token.length >= 4 ? 3 : 2;
        }
      }
      return { chunk, score, index };
    })
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxItems);

  if (rankedChunks.length === 0) {
    return "";
  }

  return buildSummarySectionFromChunks(rankedChunks.map((item) => item.chunk));
}

function messagesToText(messages: SessionMessage[]): string {
  return messages
    .map((m) => {
      const role = m.type === "user" ? "User" : "Jarvis";
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as any[]).map((p) => p.text ?? "").join(" ")
            : "";
      const toolInfo = m.toolCalls?.length
        ? ` [called tools: ${m.toolCalls.map((tc) => tc.name).join(", ")}]`
        : "";
      return text.trim() ? `${role}: ${text}${toolInfo}` : null;
    })
    .filter(Boolean)
    .join("\n");
}
