/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type SaveFactFn = (
  category: string,
  content: string,
  importance: number,
) => Promise<void>;

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
Extract persistent facts from the USER INPUT ONLY. Do NOT extract facts from the assistant output.

ENTITY ATTRIBUTION (CRITICAL):
- Only extract facts where the subject is the USER (e.g., "User likes X") or the JARVIS SYSTEM/PROJECT (e.g., "Jarvis must use Y").
- Do NOT extract facts about external entities, third-party projects, or topics being discussed conceptually (e.g., if user says "OpenClaw uses DNI", do NOT extract this as a fact about Jarvis or the user).
- If the subject is an external product or another AI, IGNORE it.

Source rule (CRITICAL):
- Extract ONLY from: "User input" below
- NOT from: the assistant's response, even if the assistant enumerates or summarizes user information
- If the user asks "what are my hobbies?" and the assistant lists them, extract NOTHING — the user stated no new facts
- Only extract what the user explicitly stated or revealed about themselves

Category definitions (mutually exclusive):
- identity: ONLY static facts about who the user IS — name, job title, profession, skills (e.g. "user is a software engineer named David", "user is good at cooking")
- behavior: User's habits, hobbies, interests, lifestyle, routines, or recurring patterns (e.g. "runs 3 times a week", "likes cycling", "interested in history", "always asks for background before details")
- preference: ONLY persistent, long-term response style preferences about FORMAT or STYLE — output format, tone, language, length. NOT personal traits, hobbies, or one-time/temporary instructions.
  Signs of persistence: "always", "every time", "from now on", "以后", "每次"
  Signs of one-time (IGNORE these): "this time", "just now", "for this response", "这次", "just say", test commands like "return exactly X"
- specification: Technical decisions, project constraints, or system rules FOR THIS PROJECT (e.g. "this project uses TypeScript", "do not modify gemini-cli source"). Must be a rule the user wants JARVIS to follow.

Importance scoring (1-10):
- 9-10: Core identity facts (name, profession), strong long-term preferences, critical project constraints
- 7-8:  Recurring behavior patterns, important project decisions, persistent style preferences
- 5-6:  Occasional habits, secondary preferences, project context that may change
- 3-4:  Weak signals, single-mention interests, low-confidence inferences
- 1-2:  Rarely useful, highly situational, almost certainly transient

Rules:
- Each fact belongs to exactly ONE category.
- Hobbies, interests, and things the user "likes" → behavior, NOT identity.
- identity = name/job/skill only. If unsure between identity/behavior, use behavior.
- "preference" means response style only. User hobbies/interests → behavior, NOT preference.
- Do not repeat the same information under different categories.
- If a fact is about an external entity (like "OpenClaw"), ignore it.
- Only extract facts that are genuinely new and worth remembering long-term.

Respond ONLY with JSON: {"found": true, "facts": [{"category": "identity|behavior|preference|specification", "content": "...", "importance": 1-10}]}
If zero new data worth persisting, respond: {"found": false}

User input: ${userPrompt}
Assistant output (context only, do NOT extract from this): ${assistantText}
`;

      const fullText = await this.generateText(frozenPrompt);

      const match = fullText.match(/\{[\s\S]*\}/);
      if (!match) return;

      const data = JSON.parse(match[0].replace(/\n/g, " ")) as {
        found: boolean;
        facts?: Array<{
          category: string;
          content: string;
          importance?: number;
        }>;
      };
      if (data.found && data.facts) {
        for (const fact of data.facts) {
          // Use LLM-assigned importance; clamp to [1, 10]; fallback to 5
          const importance = Math.min(
            10,
            Math.max(1, Math.round(fact.importance ?? 5)),
          );
          await this.saveFact(fact.category, fact.content, importance);
        }
      }
    } catch (e) {
      console.error("[BackgroundDistiller] distill failed:", e);
    }
  }
}
