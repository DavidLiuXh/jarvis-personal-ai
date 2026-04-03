/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '../../../core/src/index.js';

type MessageRecord = {
  type: string;
  content: unknown;
  toolCalls?: Array<{ id?: string; name: string; args: any; result: unknown }>;
};

/**
 * Converts a persisted ConversationRecord messages array into a Content[]
 * history suitable for GeminiChat.resumeChat().
 *
 * This implementation strictly enforces role alternation (user -> model -> user)
 * by merging consecutive turns with the same role.
 */
export function buildHistoryFromMessages(messages: MessageRecord[]): Content[] {
  const rawTurns: Content[] = [];

  for (const m of messages) {
    if (m.type === 'user') {
      rawTurns.push({
        role: 'user',
        parts: Array.isArray(m.content)
          ? (m.content as Part[])
          : [{ text: String(m.content) }],
      });
    } else if (m.type === 'gemini') {
      const modelParts: Part[] = [];

      // 1. Model text reply
      const text = typeof m.content === 'string' ? m.content : '';
      if (text.trim()) {
        modelParts.push({ text });
      }

      // 2. Identify tool calls that HAVE results
      const toolCallsWithResults = (m.toolCalls || []).filter(
        (tc) => tc.result !== undefined && tc.result !== null,
      );

      // 3. Collect functionCall parts
      if (toolCallsWithResults.length > 0) {
        for (const tc of toolCallsWithResults) {
          modelParts.push({
            functionCall: {
              name: tc.name,
              args: tc.args || {},
            },
          });
        }
      }

      if (modelParts.length > 0) {
        rawTurns.push({ role: 'model', parts: modelParts });
      }

      // 4. Collect functionResponse parts (sent as 'user' role)
      if (toolCallsWithResults.length > 0) {
        const resParts: Part[] = [];
        for (const tc of toolCallsWithResults) {
          const response = Array.isArray(tc.result)
            ? {
                output: tc.result
                  .map((p: any) => p?.functionResponse?.response?.output ?? '')
                  .join('\n'),
              }
            : (tc.result as any);
          resParts.push({
            functionResponse: { name: tc.name, response },
          });
        }
        if (resParts.length > 0) {
          rawTurns.push({ role: 'user', parts: resParts });
        }
      }
    }
  }

  return mergeConsecutiveRoles(rawTurns);
}

/**
 * Merges consecutive Content nodes with the same role into a single node
 * with combined parts. This is required by the Gemini API.
 */
export function mergeConsecutiveRoles(history: Content[]): Content[] {
  if (history.length === 0) return [];

  const merged: Content[] = [];
  let current: Content = { ...history[0], parts: [...history[0].parts] };

  for (let i = 1; i < history.length; i++) {
    const next = history[i];
    if (next.role === current.role) {
      current.parts.push(...next.parts);
    } else {
      merged.push(current);
      current = { ...next, parts: [...next.parts] };
    }
  }
  merged.push(current);

  return merged;
}
