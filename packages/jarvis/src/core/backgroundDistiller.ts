/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type SaveFactFn = (category: string, content: string, importance: number) => Promise<void>;

/**
 * A function that sends a prompt to an LLM and returns the full text response.
 * Provided by the caller so BackgroundDistiller stays decoupled from any
 * specific SDK or client instance.
 */
export type GenerateTextFn = (prompt: string) => Promise<string>;

/**
 * Runs a silent background LLM call after each turn to extract
 * persistent facts from the conversation and persist them to memory.
 * Uses a caller-supplied generateText function so it never touches the
 * main GeminiClient chat history.
 */
export class BackgroundDistiller {
  constructor(
    private generateText: GenerateTextFn,
    private saveFact: SaveFactFn,
  ) {}

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

      const fullText = await this.generateText(frozenPrompt);

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
    } catch (e) {
      console.error('[BackgroundDistiller] distill failed:', e);
    }
  }
}
