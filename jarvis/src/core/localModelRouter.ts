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
- "personal": The request is about the USER's own traits, history, habits, preferences, past decisions, or ongoing projects. Examples: "What is my investment style?", "What did we discuss last week?", "What are my coding preferences?"
- "external": The request is about the outside world, general knowledge, third-party companies, public figures, or factual information unrelated to the user. Examples: "Who invested in Anthropic?", "What is the capital of France?", "How does TCP/IP work?"
- "mixed": The request requires BOTH personal context AND external knowledge to answer well. Examples: "Should I invest in NVDA given my risk profile?", "Is this architecture suitable for my project?"

SCORING FORMULA
complexity_score = knowledge_score * 0.6 + operation_score * 0.4
Round to the nearest integer.

OUTPUT RULES
- Respond ONLY with a raw JSON object.
- DO NOT wrap in markdown code blocks.
- DO NOT output any explanation outside the JSON.
- All fields are REQUIRED. Missing fields will cause a system error.

Required schema:
{"knowledge_score": <integer 1-100>, "operation_score": <integer 1-100>, "complexity_score": <integer 1-100>, "complexity_reasoning": "<one sentence>", "query_subject": "personal" | "external" | "mixed"}
`.trim();

export type QuerySubject = "personal" | "external" | "mixed";

export type RoutingResult = {
  model: string;
  score: number;
  classifierReason: string;
  decision: string;
  source: "local-router/ollama" | "local-router/fallback";
  querySubject: QuerySubject;
};

type ClassifyResult = {
  score: number;
  reason: string;
  querySubject: QuerySubject;
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
      const { score, reason, querySubject } = await this.classify(
        userPrompt,
        history,
      );
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
      };
    } catch (e: any) {
      return {
        model: this.proModel,
        score: -1,
        classifierReason: e.message,
        decision: `Classification failed, defaulting to ${this.proModel}`,
        source: "local-router/fallback",
        querySubject: FALLBACK_QUERY_SUBJECT,
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
    };
  }
}
