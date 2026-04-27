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
    interaction_style: 7,
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
You are a memory probe that reads only the [USER_INPUT] field below and extracts persistent facts about the user or the Jarvis project.

DATA SOURCE:
- Your sole data source is [USER_INPUT].
- [ASSISTANT_OUTPUT] is provided as context only; treat it as read-only background.
- When the user asks a question and the assistant answers, the assistant's answer carries zero evidentiary weight — only what the user explicitly stated counts.
- When [USER_INPUT] contains no new persistent facts, respond with {"found": false}.

SUBJECT FILTER:
- Record facts whose subject is the USER or the JARVIS SYSTEM/PROJECT.
- Facts about third-party products, external projects, or conceptual topics belong to those entities, not to the user or Jarvis — leave them unrecorded.

CATEGORIES (assign each fact to exactly one):
- identity: static attributes that define who the user IS — name, job title, profession, skills (e.g. "user is a software engineer named David")
- behavior: the user's habits, hobbies, interests, lifestyle, routines, recurring patterns (e.g. "runs 3 times a week", "likes cycling")
- interaction_style: how the user wants Jarvis to FORMAT or STYLE its responses — output format, tone, language, length. Applies to persistent instructions only.
  Persistent signals: "always", "every time", "from now on", "以后", "每次"
  One-time signals (skip these): "this time", "just now", "for this response", "这次", test commands like "return exactly X"
- specification: technical decisions, project constraints, or rules the user wants Jarvis to follow in THIS PROJECT (e.g. "this project uses TypeScript")

CLASSIFICATION GUIDE:
- Hobbies, interests, things the user "likes" → behavior
- identity covers name / job / skill only; when unsure between identity and behavior, choose behavior
- preference covers response style only; personal interests go to behavior
- Each piece of information belongs to one category; record it once

IMPORTANCE (1-10):
- 9-10: Core identity facts, strong long-term preferences, critical project constraints
- 7-8:  Recurring behavior patterns, important project decisions, persistent style preferences
- 5-6:  Occasional habits, secondary preferences, project context that may change
- 3-4:  Weak signals, single-mention interests, low-confidence inferences
- 1-2:  Highly situational, almost certainly transient

OUTPUT FORMAT:
{"found": true, "facts": [{"category": "identity|behavior|interaction_style|specification", "content": "...", "importance": 1-10}]}
When nothing is worth recording: {"found": false}

[USER_INPUT]: ${userPrompt}
[ASSISTANT_OUTPUT]: ${assistantText}
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
