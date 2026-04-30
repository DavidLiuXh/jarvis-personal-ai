/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaGenerate } from "./ollamaClient.js";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function buildClassifierPrompt(): string {
  const now = new Date();
  const todayName = DAY_NAMES[now.getDay()];
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  // Days since Monday (0=Mon … 6=Sun); used to compute "this Monday" offset
  const daysSinceMonday = (now.getDay() + 6) % 7;
  return buildClassifierPromptTemplate(todayStr, todayName, daysSinceMonday);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildClassifierPromptTemplate(
  todayStr: string,
  todayName: string,
  daysSinceMonday: number,
): string {
  // Pre-compute ISO date for each weekday so LLM never has to do arithmetic.
  // weekdayIndex: 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun
  const daysAgo = (weekdayIndex: number) =>
    (daysSinceMonday - weekdayIndex + 7) % 7;
  const weekdayDate = (weekdayIndex: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo(weekdayIndex));
    return isoDate(d);
  };
  const monDate = weekdayDate(0);
  const tueDate = weekdayDate(1);
  const wedDate = weekdayDate(2);
  const thuDate = weekdayDate(3);
  const friDate = weekdayDate(4);
  const satDate = weekdayDate(5);
  const sunDate = weekdayDate(6);
  // Last-week dates (7 days earlier)
  const lastMonDate = isoDate(
    new Date(new Date().setDate(new Date().getDate() - daysAgo(0) - 7)),
  );
  const lastFriDate = isoDate(
    new Date(new Date().setDate(new Date().getDate() - daysAgo(4) - 7)),
  );

  return `
Today is ${todayStr} (${todayName}).
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
When the request refers to a time period, output EITHER:
  A) date_from + date_to  (for specific days: a weekday, a calendar date, yesterday, today)
  B) time_window_days     (for open-ended ranges: "last week", "recently", "last month")
Never output both. Leave both null if no time reference.

Rules for specific days — use date_from/date_to (exact ISO dates, pre-computed below):
- "today" / "今天" → date_from="${todayStr}", date_to="${todayStr}"
- "yesterday" / "昨天" → date_from="${isoDate(new Date(new Date().setDate(new Date().getDate() - 1)))}", date_to="${isoDate(new Date(new Date().setDate(new Date().getDate() - 1)))}"
- "the day before yesterday" / "前天" → date_from="${isoDate(new Date(new Date().setDate(new Date().getDate() - 2)))}", date_to="${isoDate(new Date(new Date().setDate(new Date().getDate() - 2)))}"
- "Monday" / "周一" / "星期一" → date_from="${monDate}", date_to="${monDate}"
- "Tuesday" / "周二" / "星期二" → date_from="${tueDate}", date_to="${tueDate}"
- "Wednesday" / "周三" / "星期三" → date_from="${wedDate}", date_to="${wedDate}"
- "Thursday" / "周四" / "星期四" → date_from="${thuDate}", date_to="${thuDate}"
- "Friday" / "周五" / "星期五" → date_from="${friDate}", date_to="${friDate}"
- "Saturday" / "周六" / "星期六" → date_from="${satDate}", date_to="${satDate}"
- "Sunday" / "周日" / "星期日" → date_from="${sunDate}", date_to="${sunDate}"
- "last Monday" / "上周一" → date_from="${lastMonDate}", date_to="${lastMonDate}"
- "last Friday" / "上周五" → date_from="${lastFriDate}", date_to="${lastFriDate}"
- Any specific "YYYY-MM-DD" or "Month Day" date → compute the ISO date and use date_from=date_to=that date

Rules for open ranges — use time_window_days (integer, no date_from/date_to):
- "last week" / "上周" / "this week" → 7
- "last month" / "上个月" → 30
- "recently" / "最近" / "这两天" → 3
- "last N days" → N

Output null for both if there is no time reference at all.

SCORING FORMULA
complexity_score = knowledge_score * 0.6 + operation_score * 0.4
Round to the nearest integer.

OUTPUT RULES
- Respond ONLY with a raw JSON object.
- DO NOT wrap in markdown code blocks.
- DO NOT output any explanation outside the JSON.
- All fields are REQUIRED. time_window_days, date_from, date_to may be null.
- Use EITHER time_window_days OR date_from+date_to, never both.

Required schema:
{"knowledge_score": <integer 1-100>, "operation_score": <integer 1-100>, "complexity_score": <integer 1-100>, "complexity_reasoning": "<one sentence>", "query_subject": "personal" | "external" | "mixed", "time_window_days": <integer> | null, "date_from": "<YYYY-MM-DD>" | null, "date_to": "<YYYY-MM-DD>" | null}
`.trim();
}

export type QuerySubject = "personal" | "external" | "mixed";

export type RoutingResult = {
  model: string;
  score: number;
  classifierReason: string;
  decision: string;
  source: "local-router/ollama" | "local-router/fallback";
  querySubject: QuerySubject;
  /** Days ago to start the time window (open-ended ranges). Null when date_from/date_to is set. */
  timeWindowDays: number | null;
  /** Exact start date for specific-day queries (YYYY-MM-DD). */
  dateFrom: string | null;
  /** Exact end date for specific-day queries (YYYY-MM-DD). */
  dateTo: string | null;
};

type ClassifyResult = {
  score: number;
  reason: string;
  querySubject: QuerySubject;
  timeWindowDays: number | null;
  dateFrom: string | null;
  dateTo: string | null;
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
      const { score, reason, querySubject, timeWindowDays, dateFrom, dateTo } =
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
        dateFrom,
        dateTo,
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
        dateFrom: null,
        dateTo: null,
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

    const fullPrompt = `${buildClassifierPrompt()}${historySection}\nUser request: ${prompt}`;
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
      date_from?: string | null;
      date_to?: string | null;
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

    // Parse date_from / date_to — must be YYYY-MM-DD strings or null.
    // When present, they take priority over time_window_days (clear it).
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    if (parsed.date_from && ISO_DATE_RE.test(String(parsed.date_from))) {
      dateFrom = String(parsed.date_from);
    }
    if (parsed.date_to && ISO_DATE_RE.test(String(parsed.date_to))) {
      dateTo = String(parsed.date_to);
    }
    // If LLM provided date range, discard time_window_days to avoid conflict.
    if (dateFrom !== null && dateTo !== null) {
      timeWindowDays = null;
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
      dateFrom,
      dateTo,
    };
  }
}
