/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Content } from '../../../core/src/index.js';
import { buildHistoryFromMessages } from './resumeFromDisk.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionMessage = {
  type: string;
  content: unknown;
  timestamp?: number | string;
  toolCalls?: Array<{ name: string; result: unknown }>;
};

export type SummaryState = {
  /** The latest consolidated summary text. */
  summary: string;
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
  return files.filter(f => {
    const lastMtime = recorded[f.name];
    return lastMtime === undefined || f.mtime > lastMtime;
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const SUMMARY_FILENAME = 'session_summary.json';

export function loadSummaryState(memoryDir: string): SummaryState | null {
  const filePath = path.join(memoryDir, SUMMARY_FILENAME);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SummaryState;
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
    return existingSummary ?? '';
  }

  const newConversation = messagesToText(newMessages);

  const prompt = existingSummary
    ? `
You are summarizing a conversation history for an AI assistant called Jarvis.

Existing summary (already processed):
${existingSummary}

New conversation to incorporate:
${newConversation}

Task: Update the summary by merging the new conversation into the existing one.
- Keep all important facts about the user (name, profession, skills, interests, habits, preferences)
- Keep important technical decisions and project context
- Remove redundant or trivial information
- Write in third-person, concise English
- Maximum 500 words

Updated summary:
`.trim()
    : `
You are summarizing a conversation history for an AI assistant called Jarvis.

Conversation:
${newConversation}

Task: Write a concise summary of this conversation.
- Extract important facts about the user (name, profession, skills, interests, habits, preferences)
- Extract important technical decisions and project context
- Write in third-person, concise English
- Maximum 500 words

Summary:
`.trim();

  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await generateText(prompt);
    } catch (e: any) {
      const isLast = attempt === maxRetries;
      if (isLast) {
        console.error(`⚠️ [SessionSummarizer] Summary generation failed after ${maxRetries} attempts: ${e.message}. Using existing summary.`);
        return existingSummary ?? '';
      }
      console.error(`⚠️ [SessionSummarizer] Attempt ${attempt} failed: ${e.message}. Retrying in ${retryDelayMs}ms...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  return existingSummary ?? '';
}

// ---------------------------------------------------------------------------
// History construction
// ---------------------------------------------------------------------------

/**
 * Builds a Content[] history that starts with a summary prefix (if non-empty)
 * followed by the recent raw message turns.
 *
 * The summary is injected as a user→model exchange so the LLM treats it as
 * established context rather than a new instruction.
 */
export function buildHistoryWithSummary(
  summary: string,
  recentMessages: SessionMessage[],
): Content[] {
  const history: Content[] = [];

  if (summary.trim()) {
    // Inject summary as a user prompt + model acknowledgement pair
    history.push({
      role: 'user',
      parts: [{ text: `[CONVERSATION SUMMARY]\n${summary}` }],
    });
    history.push({
      role: 'model',
      parts: [{ text: 'Understood — summary noted. I have the full context of our previous conversations.' }],
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

function messagesToText(messages: SessionMessage[]): string {
  return messages
    .map(m => {
      const role = m.type === 'user' ? 'User' : 'Jarvis';
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as any[]).map(p => p.text ?? '').join(' ')
          : '';
      const toolInfo = m.toolCalls?.length
        ? ` [called tools: ${m.toolCalls.map(tc => tc.name).join(', ')}]`
        : '';
      return text.trim() ? `${role}: ${text}${toolInfo}` : null;
    })
    .filter(Boolean)
    .join('\n');
}
