/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '../../../core/src/index.js';

type MessageRecord = {
  type: string;
  content: unknown;
  toolCalls?: Array<{ name: string; result: unknown }>;
};

/**
 * Converts a persisted ConversationRecord messages array into a Content[]
 * history suitable for GeminiChat.resumeChat().
 *
 * For each gemini message:
 * - If it has text content → push a { role: 'model', parts: [{ text }] } turn
 * - If it has toolCalls with results → push a { role: 'user', parts: [functionResponse, ...] } turn
 *
 * Previously only functionResponse turns were pushed, causing the model's
 * text replies to be lost on resume.
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
      // 1. Model text reply
      const text = typeof m.content === 'string' ? m.content : '';
      if (text.trim()) {
        history.push({ role: 'model', parts: [{ text }] });
      }

      // 2. Tool call results (sent back as user/functionResponse)
      if (m.toolCalls && m.toolCalls.length > 0) {
        const resParts: Part[] = [];
        for (const tc of m.toolCalls) {
          if (tc.result) {
            resParts.push({
              functionResponse: { name: tc.name, response: tc.result as any },
            });
          }
        }
        if (resParts.length > 0) {
          history.push({ role: 'user', parts: resParts });
        }
      }
    }
  }

  return history;
}
