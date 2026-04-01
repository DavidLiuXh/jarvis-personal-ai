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
Extract persistent facts from this interaction. Use exactly one category per fact — do NOT write the same fact under multiple categories.

Category definitions (mutually exclusive):
- identity: ONLY static facts about who the user IS — name, job title, profession (e.g. "user is a software engineer named David")
- behavior: user's habits, lifestyle, routines, or recurring patterns in how they work or live (e.g. "runs 3 times a week", "always asks for background before details")
- preference: ONLY how the user wants Jarvis to respond — output format, tone, length (e.g. "prefers table format", "wants concise answers in Chinese")
- specification: technical decisions, project constraints, or system rules (e.g. "project uses TypeScript", "do not modify gemini-cli source")

Rules:
- Each fact belongs to exactly ONE category. If unsure between identity/behavior, use behavior.
- Do not repeat the same information under different categories.
- Only extract facts that are genuinely new and worth remembering long-term.

Respond ONLY with JSON: {"found": true, "facts": [{"category": "identity|behavior|preference|specification", "content": "..."}]}
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
