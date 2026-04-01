/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GeminiChat,
  GeminiEventType,
  type Part,
} from '../../../core/src/index.js';

export type SaveFactFn = (category: string, content: string, importance: number) => Promise<void>;

/**
 * Runs a silent background LLM call after each turn to extract
 * administrative facts from the conversation and persist them to memory.
 * Uses an isolated GeminiChat instance so it never pollutes the main chat history.
 */
export class BackgroundDistiller {
  private client: {
    sendMessageStream: (
      parts: Part[],
      signal: AbortSignal,
      id: string,
      chat?: InstanceType<typeof GeminiChat>,
    ) => AsyncIterable<{ type: string; value: unknown }>;
  };
  private saveFact: SaveFactFn;

  constructor(
    client: {
      sendMessageStream: (
        parts: Part[],
        signal: AbortSignal,
        id: string,
        chat?: InstanceType<typeof GeminiChat>,
      ) => AsyncIterable<{ type: string; value: unknown }>;
    },
    saveFact: SaveFactFn,
  ) {
    this.client = client;
    this.saveFact = saveFact;
  }

  async distill(userPrompt: string, assistantText: string): Promise<void> {
    try {
      const frozenPrompt = `
Extract persistent facts from this interaction across four categories:
- identity: who the user is, their role, background, or name
- specification: technical decisions, system constraints, or project rules
- preference: how the user likes responses (format, length, style, e.g. "prefers tables", "wants concise answers")
- behavior: recurring patterns in how the user asks questions or works (e.g. "always asks for background first")

Respond ONLY with JSON: {"found": true, "facts": [{"category": "identity|specification|preference|behavior", "content": "..."}]}
If zero new data worth persisting, respond: {"found": false}

Interaction:
Input: ${userPrompt}
Output: ${assistantText}
`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stealthChat = new (GeminiChat as any)(this.client, '', [], []);
      const responseStream = this.client.sendMessageStream(
        [{ text: frozenPrompt }],
        new AbortController().signal,
        `distill-${Date.now()}`,
        stealthChat,
      );

      let fullText = '';
      try {
        for await (const chunk of responseStream) {
          if (chunk.type === GeminiEventType.Content) {
            fullText += chunk.value as string;
          }
        }
      } catch (_e) {}

      const match = fullText.match(/\{[\s\S]*\}/);
      if (!match) return;

      const data = JSON.parse(match[0].replace(/\n/g, ' ')) as {
        found: boolean;
        facts?: Array<{ category: string; content: string }>;
      };
      if (data.found && data.facts) {
        for (const fact of data.facts) {
          await this.saveFact(fact.category, fact.content, 10);
        }
      }
    } catch (_e) {}
  }
}
