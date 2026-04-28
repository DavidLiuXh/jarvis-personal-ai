/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaGenerate } from "./ollamaClient.js";

const CLASSIFIER_SYSTEM_PROMPT = `
You are a task analyst. Evaluate the user's request on THREE dimensions simultaneously.

DIMENSION 1 — Knowledge Depth (1-100)
How much theoretical knowledge, domain expertise, or abstract reasoning is required?
1-25: Basic fact retrieval, simple summaries, applying known formulas.
26-50: Integrating multiple concepts, simple logical reasoning, standard workflows.
51-75: Deep domain expertise, cross-disciplinary analysis, creative problem-solving.
76-100: Cross-domain knowledge fusion, highly abstract thinking, innovative system design.

DIMENSION 2 — Operational Difficulty (1-100)
How complex are the actual steps, tool usage, or execution required?
1-25: Reading, copying, simple input — no multi-step execution needed.
26-50: Multi-step operations, using standard tools, following a defined process.
51-75: Skilled tool usage, process design, coordinating multiple components.
76-100: Algorithm design, system debugging, complex data processing, architectural decisions.

DIMENSION 3 — Query Subject (CRITICAL for memory retrieval)
Classify what the request is asking ABOUT. Choose exactly one:
- "personal": The request is about the USER's own traits, history, habits, preferences, past decisions, or ongoing projects. ALSO includes any question about past conversations or what was discussed — even if the topic itself is an external entity. Examples: "What is my investment style?", "What did we discuss last week?", "Did we talk about Anthropic yesterday?", "Have I asked about NVDA before?"
- "external": The request is PURELY about the outside world with NO reference to the user's history or personal context. Examples: "Who invested in Anthropic?", "What is the capital of France?", "How does TCP/IP work?", "What is AWS's market share?"
- "mixed": The request requires BOTH personal context AND external knowledge to answer well. Examples: "Should I invest in NVDA given my risk profile?", "Is this architecture suitable for my project?"

KEY RULE: If the user is asking whether something was discussed or what happened in a past conversation, classify as "personal" regardless of the topic.

DIMENSION 4 — Time Window (for memory retrieval)
If the request refers to a specific past time period, output the number of days ago that period starts from today.
- "yesterday" / "昨天" → 1
- "today" / "今天" → 0
- "the day before yesterday" / "前天" → 2
- "last week" / "上周" → 7
- "last month" / "上个月" → 30
- "recently" / "最近" / "这两天" → 3
- "two days ago" / "两天前" → 2
- No time reference → null
Output the LARGEST number that covers the full period mentioned. If uncertain, output null.

SCORING FORMULA
complexity_score = knowledge_score * 0.6 + operation_score * 0.4
Round to the nearest integer.

OUTPUT RULES
- Respond ONLY with a raw JSON object.
- DO NOT wrap in markdown code blocks.
- DO NOT output any explanation outside the JSON.
- All fields are REQUIRED except time_window_days which can be null.

Required schema:
{"knowledge_score": <integer 1-100>, "operation_score": <integer 1-100>, "complexity_score": <integer 1-100>, "complexity_reasoning": "<one sentence>", "query_subject": "personal" | "external" | "mixed", "time_window_days": <integer> | null}
`.trim();

export type QuerySubject = "personal" | "external" | "mixed";

export type RoutingResult = {
  model: string;
  score: number;
  classifierReason: string;
  decision: string;
  source: "local-router/ollama" | "local-router/fallback";
  querySubject: QuerySubject;
  /** Days ago to start the time window, or null if no temporal intent. */
  timeWindowDays: number | null;
};

type ClassifyResult = {
  score: number;
  reason: string;
  querySubject: QuerySubject;
  timeWindowDays: number | null;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

// Fallback when classification fails: conservative defaults that avoid
// both over-injection (external queries) and under-injection (personal queries).
const FALLBACK_QUERY_SUBJECT: QuerySubject = "mixed";

export class LocalModelRouter {
  constructor(
    private baseUrl: string = "http://localhost:11434",
    private classifierModel: string,
    private threshold: number = 70,
    private proModel: string = "gemini-2.5-pro",
    private flashModel: string = "gemini-2.5-flash",
    private timeoutMs: number = 30_000,
    private historyTurns: number = 5,
  ) {}

  async route(
    userPrompt: string,
    history: ConversationTurn[] = [],
  ): Promise<RoutingResult> {
    try {
      const { score, reason, querySubject, timeWindowDays } =
        await this.classify(userPrompt, history);
      const model = score >= this.threshold ? this.proModel : this.flashModel;
      return {
        model,
        score,
        classifierReason: reason,
        decision:
          score >= this.threshold
            ? `Score ${score} >= threshold ${this.threshold} → ${this.proModel}`
            : `Score ${score} < threshold ${this.threshold} → ${this.flashModel}`,
        source: "local-router/ollama",
        querySubject,
        timeWindowDays,
      };
    } catch (e: any) {
      return {
        model: this.proModel,
        score: -1,
        classifierReason: e.message,
        decision: `Classification failed, defaulting to ${this.proModel}`,
        source: "local-router/fallback",
        querySubject: FALLBACK_QUERY_SUBJECT,
        timeWindowDays: null,
      };
    }
  }

  private async classify(
    prompt: string,
    history: ConversationTurn[],
  ): Promise<ClassifyResult> {
    const recentTurns = history.slice(-this.historyTurns * 2);
    const historySection =
      recentTurns.length > 0
        ? `\n# Recent Conversation Context\n${recentTurns
            .map(
              (t) =>
                `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 200)}`,
            )
            .join("\n")}\n`
        : "";

    const fullPrompt = `${CLASSIFIER_SYSTEM_PROMPT}${historySection}\nUser request: ${prompt}`;
    const raw = await ollamaGenerate(this.classifierModel, fullPrompt, {
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
    });

    // Strip markdown code fences if present
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const match = stripped.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error("No JSON in classifier response");

    const parsed = JSON.parse(match[0]) as {
      complexity_score?: number;
      knowledge_score?: number;
      operation_score?: number;
      complexity_reasoning?: string;
      query_subject?: string;
      time_window_days?: number | null;
    };

    // Validate complexity_score
    const score = Number(parsed.complexity_score);
    if (isNaN(score) || score < 1 || score > 100) {
      throw new Error(`Invalid complexity_score: ${parsed.complexity_score}`);
    }

    // Validate and normalise query_subject with strict allowlist
    const rawSubject = parsed.query_subject?.toLowerCase().trim();
    const VALID_SUBJECTS = new Set<QuerySubject>([
      "personal",
      "external",
      "mixed",
    ]);
    const querySubject: QuerySubject = VALID_SUBJECTS.has(
      rawSubject as QuerySubject,
    )
      ? (rawSubject as QuerySubject)
      : FALLBACK_QUERY_SUBJECT;

    if (!VALID_SUBJECTS.has(rawSubject as QuerySubject)) {
      console.error(
        `⚠️ [LocalModelRouter] Invalid query_subject "${rawSubject}", using fallback "${FALLBACK_QUERY_SUBJECT}"`,
      );
    }

    // Parse time_window_days — must be a non-negative integer or null
    let timeWindowDays: number | null = null;
    if (
      parsed.time_window_days !== null &&
      parsed.time_window_days !== undefined
    ) {
      const raw = Number(parsed.time_window_days);
      if (!isNaN(raw) && raw >= 0 && Number.isInteger(raw)) {
        timeWindowDays = raw;
      } else {
        console.error(
          `⚠️ [LocalModelRouter] Invalid time_window_days "${parsed.time_window_days}", using null`,
        );
      }
    }

    const knowledgeScore = parsed.knowledge_score ?? null;
    const operationScore = parsed.operation_score ?? null;
    const breakdown =
      knowledgeScore !== null && operationScore !== null
        ? ` [knowledge=${knowledgeScore}, operation=${operationScore}]`
        : "";

    return {
      score,
      reason: `${parsed.complexity_reasoning ?? "(no reason)"}${breakdown}`,
      querySubject,
      timeWindowDays,
    };
  }
}
