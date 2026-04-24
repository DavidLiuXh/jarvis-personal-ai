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

// ---------------------------------------------------------------------------
// Multi-factor importance scoring helpers
// ---------------------------------------------------------------------------

// A. Persistent intent patterns → explicitness 9
const PERSISTENT_INTENT_PATTERNS = [
  /以后(都|每次|总是)/,
  /每次都/,
  /永远/,
  /从现在开始/,
  /from now on/i,
  /always /i,
  /every time/i,
  /forever/i,
];

// B. Identity assertion patterns → explicitness 8 (only when category=identity)
const IDENTITY_PATTERNS = [
  /我是/,
  /我叫/,
  /我的职业/,
  /我的工作/,
  /I am /i,
  /my name is/i,
  /I'm a /i,
  /my job is/i,
];

// C. Preference statement patterns → explicitness 7
const PREFERENCE_PATTERNS = [
  /我喜欢/,
  /我更喜欢/,
  /我偏好/,
  /我通常用/,
  /我一般用/,
  /I like /i,
  /I prefer /i,
  /I usually /i,
  /I tend to /i,
];

// D. Strong behavior evidence patterns → explicitness 6
const BEHAVIOR_PATTERNS = [
  /我经常/,
  /我通常/,
  /我一般/,
  /我会先/,
  /I often /i,
  /I usually /i,
  /I tend to /i,
];

// F. Weak / uncertain patterns → explicitness 3
const WEAK_PATTERNS = [
  /可能/,
  /也许/,
  /暂时/,
  /试试/,
  /maybe/i,
  /perhaps/i,
  /for now/i,
];

/**
 * Returns the category base score used in the importance formula.
 * insight is excluded — it uses its own conservative mode in memory.ts.
 */
export function getCategoryBaseScore(category: string): number {
  const scores: Record<string, number> = {
    identity: 9,
    specification: 8,
    preference: 7,
    behavior: 6,
  };
  return scores[category] ?? 5;
}

/**
 * Computes explicitness score (3/5/6/7/8/9) based on expression strength.
 * Uses userPrompt as primary signal; factContent and category as auxiliaries.
 */
export function computeExplicitnessScore(
  userPrompt: string,
  factContent?: string,
  category?: string,
): number {
  // Primary signal: userPrompt only — this is the raw user expression.
  // factContent is LLM-produced and must NOT be used for pattern matching
  // because the LLM may strengthen weak expressions (e.g. "I sometimes run"
  // → "user always runs"), which would inflate explicitness scores.
  const primary = userPrompt.trim();

  // factContent is used only as a tiebreaker for the identity category check
  // (to confirm the fact is about the user's identity, not as a pattern source).
  // It is intentionally NOT concatenated into the pattern-matching text.

  // Check weak patterns first — they override everything else
  if (WEAK_PATTERNS.some((p) => p.test(primary))) return 3;

  // Persistent intent is the strongest signal
  if (PERSISTENT_INTENT_PATTERNS.some((p) => p.test(primary))) return 9;

  // Identity assertions are strong, but only meaningful for identity category
  if (
    category === "identity" &&
    IDENTITY_PATTERNS.some((p) => p.test(primary))
  ) {
    return 8;
  }

  // Explicit preference statements
  if (PREFERENCE_PATTERNS.some((p) => p.test(primary))) return 7;

  // Behavior patterns with clear evidence
  if (BEHAVIOR_PATTERNS.some((p) => p.test(primary))) return 6;

  // Default: inferred from context
  return 5;
}

/**
 * Normalizes an LLM-returned score to [1, 10], defaulting to 5.
 */
export function normalizeLlmScore(raw?: number): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) return 5;
  return Math.max(1, Math.min(10, Math.round(raw)));
}

/**
 * Clamps a computed score to the [1, 10] integer range.
 */
export function clampScore(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

/**
 * Computes the final importance for a regular fact (identity/specification/
 * preference/behavior) using the three-factor formula:
 *   importance = round(0.35 * category + 0.25 * explicitness + 0.40 * llm)
 *
 * insight is excluded — it uses its own conservative mode in memory.ts.
 */
export function computeFactImportance(params: {
  category: string;
  userPrompt: string;
  factContent: string;
  llmScore?: number;
}): number {
  const categoryScore = getCategoryBaseScore(params.category);
  const explicitnessScore = computeExplicitnessScore(
    params.userPrompt,
    params.factContent,
    params.category,
  );
  const llmScore = normalizeLlmScore(params.llmScore);

  const final = clampScore(
    0.35 * categoryScore + 0.25 * explicitnessScore + 0.4 * llmScore,
  );

  console.error(
    `[importance] category=${params.category} cat=${categoryScore} explicit=${explicitnessScore} llm=${llmScore} final=${final} content="${params.factContent.slice(0, 80)}"`,
  );

  return final;
}

// ---------------------------------------------------------------------------
// BackgroundDistiller
// ---------------------------------------------------------------------------

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
          // insight is managed by memory.ts conservative mode — skip here
          if (fact.category === "insight") continue;

          const importance = computeFactImportance({
            category: fact.category,
            userPrompt,
            factContent: fact.content,
            llmScore: fact.importance,
          });
          await this.saveFact(fact.category, fact.content, importance);
        }
      }
    } catch (e) {
      console.error("[BackgroundDistiller] distill failed:", e);
    }
  }
}
