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
 * For each gemini message:
 * - Pushes a { role: 'model', parts: [...] } turn containing:
 *   - Any text content
 *   - Any toolCalls (functionCall parts)
 * - If those toolCalls have results → push a { role: 'user', parts: [functionResponse, ...] } turn
 */
export function buildHistoryFromMessages(messages: MessageRecord[]): Content[] {
  const history: Content[] = [];

  for (const m of messages) {
    if (m.type === 'user') {
      history.push({
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

      // 3. Pushes toolCalls (functionCall) only if they have results
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
        history.push({ role: 'model', parts: modelParts });
      }

      // 4. Tool call results (functionResponse)
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
          history.push({ role: 'user', parts: resParts });
        }
      }
    }
  }

  return history;
}
