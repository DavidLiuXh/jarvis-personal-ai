/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaGenerate } from "./ollamaClient.js";
import { extractDateRange, type DateRange } from "./dateRange.js";

/**
 * Build the classifier prompt. Date/time resolution is handled by
 * extractDateRange() in code — the LLM only needs to score and classify.
 * We still tell the LLM about the pre-resolved date range so it can use it
 * for query_subject classification (e.g. temporal personal queries).
 */
function buildClassifierPrompt(
  preResolvedRange: DateRange | null,
  now: Date,
): string {
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const todayName = DAY_NAMES[now.getDay()];

  const timeNote = preResolvedRange
    ? `NOTE: The system has already resolved the temporal reference to the date range ` +
      `[${new Date(preResolvedRange.from).toISOString().slice(0, 10)} ~ ` +
      `${new Date(preResolvedRange.to - 1).toISOString().slice(0, 10)}]. ` +
      `Output date_from=null, date_to=null, time_window_days=null — the system handles this.`
    : `If the request has NO clear temporal reference, output time_window_days=null, date_from=null, date_to=null.`;

  return `
Today is ${todayStr} (${todayName}).
You are a task analyst. Evaluate the user's request on THREE dimensions simultaneously.

DIMENSION 1 — Knowledge Depth (1-100)
1-25: Basic fact retrieval, simple summaries.
26-50: Integrating concepts, standard workflows.
51-75: Deep expertise, cross-disciplinary analysis.
76-100: Cross-domain fusion, abstract thinking, system design.

DIMENSION 2 — Operational Difficulty (1-100)
1-25: Reading, simple input — no multi-step execution.
26-50: Multi-step operations, standard tools.
51-75: Skilled tool usage, process design.
76-100: Algorithm design, debugging, architectural decisions.

DIMENSION 3 — Query Subject (CRITICAL for memory retrieval)
- "personal": About the USER's own history, habits, preferences, past decisions, or past conversations. ANY question about what was discussed, even if the topic is external.
- "external": PURELY about the outside world with NO user history reference.
- "mixed": Needs BOTH personal context AND external knowledge.

KEY RULE: "what did we discuss on Monday" → personal, even if the topic is external.

DIMENSION 4 — Time Window
${timeNote}

SCORING FORMULA
complexity_score = knowledge_score * 0.6 + operation_score * 0.4 (round to integer)

OUTPUT RULES
- Respond ONLY with a raw JSON object. No markdown, no explanation.
- All fields required. time_window_days / date_from / date_to may be null.

Required schema:
{"knowledge_score": <1-100>, "operation_score": <1-100>, "complexity_score": <1-100>, "complexity_reasoning": "<one sentence>", "query_subject": "personal"|"external"|"mixed", "time_window_days": <integer>|null, "date_from": "<YYYY-MM-DD>"|null, "date_to": "<YYYY-MM-DD>"|null}
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
  /** Days ago to start the time window (open-ended ranges). Null when resolvedDateRange is set. */
  timeWindowDays: number | null;
  /** Exact start date for specific-day queries (YYYY-MM-DD), for logging. */
  dateFrom: string | null;
  /** Exact end date for specific-day queries (YYYY-MM-DD), for logging. */
  dateTo: string | null;
  /** Pre-resolved date range as { from, to } ms timestamps. Preferred over dateFrom/dateTo strings. */
  resolvedDateRange: { from: number; to: number } | null;
  /** Whether the local model detected a topic shift from recent history. */
  topicShifted: boolean;
};

type ClassifyResult = {
  score: number;
  reason: string;
  querySubject: QuerySubject;
  timeWindowDays: number | null;
  dateFrom: string | null;
  dateTo: string | null;
  resolvedDateRange: { from: number; to: number } | null;
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
    detectShift: boolean = false,
  ): Promise<RoutingResult> {
    try {
      // Run complexity classification and topic shift detection in parallel
      const [classified, topicShifted] = await Promise.all([
        this.classify(userPrompt, history),
        detectShift && history.length >= 2
          ? this.detectTopicShift(userPrompt, history)
          : Promise.resolve(false),
      ]);
      const {
        score,
        reason,
        querySubject,
        timeWindowDays,
        dateFrom,
        dateTo,
        resolvedDateRange,
      } = classified;
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
        resolvedDateRange,
        topicShifted,
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
        resolvedDateRange: null,
        topicShifted: false,
      };
    }
  }

  private async classify(
    prompt: string,
    history: ConversationTurn[],
  ): Promise<ClassifyResult> {
    // Step 1: resolve date range in code — deterministic, no LLM needed.
    const now = new Date();
    const preResolved = extractDateRange(prompt, now);

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

    const fullPrompt = `${buildClassifierPrompt(preResolved, now)}${historySection}\nUser request: ${prompt}`;
    const raw = await ollamaGenerate(this.classifierModel, fullPrompt, {
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
    });

    // Strip markdown code fences if present
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    // Use first-{ / last-} to handle nested braces in LLM string values
    const _s = stripped.indexOf("{");
    const _e = stripped.lastIndexOf("}");
    if (_s === -1 || _e <= _s)
      throw new Error("No JSON in classifier response");
    const match = [stripped.slice(_s, _e + 1)];

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

    // Step 2: Resolve date range.
    // Pre-resolved (code) wins over LLM output — code is always correct.
    // If code found a range, use it and discard LLM time fields.
    // If code found nothing, try LLM date_from/date_to as fallback.
    let dateFrom: string | null = null;
    let dateTo: string | null = null;

    if (preResolved !== null) {
      // Convert ms timestamps back to YYYY-MM-DD for the RoutingResult fields
      const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      dateFrom = toIso(preResolved.from);
      // dateTo: preResolved.to is start-of-next-day; subtract 1ms to get last day
      dateTo = toIso(preResolved.to - 1);
      timeWindowDays = null;
    } else {
      // Fallback: try LLM-provided date_from/date_to
      const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      if (parsed.date_from && ISO_DATE_RE.test(String(parsed.date_from))) {
        dateFrom = String(parsed.date_from);
      }
      if (parsed.date_to && ISO_DATE_RE.test(String(parsed.date_to))) {
        dateTo = String(parsed.date_to);
      }
      if (dateFrom !== null && dateTo !== null) {
        timeWindowDays = null;
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
      dateFrom,
      dateTo,
      resolvedDateRange: preResolved,
    };
  }

  /**
   * Rewrite the user query into a concise memory search query.
   * Takes the current prompt + last N turns and produces focused keywords
   * that resolve pronouns/references and expand relevant terms.
   * Returns null on failure so the caller can fall back to the original query.
   */
  /**
   * Detect whether the new user message is about a completely different topic
   * from the recent conversation. Returns true only when the shift is clear;
   * defaults to false on any ambiguity or error (conservative — prefer false
   * positives over incorrectly clearing history).
   */
  async detectTopicShift(
    userPrompt: string,
    recentHistory: ConversationTurn[],
  ): Promise<boolean> {
    const turns = recentHistory.slice(-6);
    const historyText = turns
      .map(
        (t) =>
          `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 200)}`,
      )
      .join("\n");

    const prompt =
      `You are a conversation analyst. Determine if the new user message is about a COMPLETELY DIFFERENT and UNRELATED topic compared to the recent conversation.

Recent conversation:
${historyText}

New user message: ${userPrompt}

Rules:
- Answer true ONLY if the new message is clearly about an unrelated subject.
- Answer false if the new message continues, follows up, asks a related question, or is even loosely connected to the recent conversation.
- When in doubt, answer false.

Output ONLY a raw JSON object: {"shifted": true} or {"shifted": false}`.trim();

    try {
      const raw = await ollamaGenerate(this.classifierModel, prompt, {
        baseUrl: this.baseUrl,
        timeoutMs: Math.min(this.timeoutMs, 8_000),
        numPredict: 20,
      });
      const stripped = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const s = stripped.indexOf("{");
      const e = stripped.lastIndexOf("}");
      if (s === -1 || e <= s) return false;
      const parsed = JSON.parse(stripped.slice(s, e + 1)) as {
        shifted?: boolean;
      };
      const result = parsed.shifted === true;
      console.error(
        `🔀 [TopicShift] "${userPrompt.slice(0, 60)}" → shifted=${result}`,
      );
      return result;
    } catch {
      return false;
    }
  }

  async rewriteMemoryQuery(
    userPrompt: string,
    recentHistory: ConversationTurn[],
  ): Promise<string | null> {
    const turns = recentHistory.slice(-6); // last 3 pairs
    const historyText =
      turns.length > 0
        ? turns
            .map(
              (t) =>
                `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 200)}`,
            )
            .join("\n")
        : "(no prior context)";

    const prompt =
      `You are a memory retrieval assistant. Given a conversation snippet and the latest user message, produce a concise search query (under 20 words) that captures the key entities, topics, and intent for searching personal memory records. Resolve any pronouns or vague references using the conversation context.

Conversation context:
${historyText}

Latest user message: ${userPrompt}

Output ONLY the search query string. No explanation, no quotes, no JSON.`.trim();

    try {
      const raw = await ollamaGenerate(this.classifierModel, prompt, {
        baseUrl: this.baseUrl,
        timeoutMs: Math.min(this.timeoutMs, 10_000),
        numPredict: 60,
      });
      const rewritten = raw.trim().replace(/^["']|["']$/g, "");
      if (rewritten.length > 0 && rewritten.length < 300) {
        return rewritten;
      }
      return null;
    } catch {
      return null;
    }
  }

  async routeAgentCall(
    userPrompt: string,
    agents: any[],
  ): Promise<{ agentId: string; input: Record<string, any> } | null> {
    const prompt = `
You are an expert intent router. A user wants to launch a specialized professional agent.
Available Agents:
${agents
  .map(
    (a) =>
      `- ID: ${a.agentId}\n  Name: ${a.name}\n  Description: ${a.description}\n  Input Schema: ${JSON.stringify(a.inputSchema)}`,
  )
  .join("\n\n")}

User request (starts with 'agent:' prefix): "${userPrompt}"

Tasks:
1. Identify which Agent ID best matches the user's request.
2. Extract the required parameters for that agent according to its Input Schema.

OUTPUT STRICTURE (CRITICAL):
- Respond ONLY with a raw JSON object. 
- NO Markdown code blocks (no \` \` \`json).
- NO trailing commas.
- NO comments.
- NO explanation or text before/after the JSON.
- If no agent matches, respond with: {"agentId": null, "input": {}}

Correct Example:
{"agentId": "investment-analysis", "input": {"ticker": "NVDA"}}
`.trim();

    try {
      const raw = await ollamaGenerate(this.classifierModel, prompt, {
        baseUrl: this.baseUrl,
        timeoutMs: this.timeoutMs,
      });

      // 1. More robust JSON extraction
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end === -1 || end < start) {
        throw new Error("No JSON object found in response");
      }

      const jsonText = raw
        .substring(start, end + 1)
        .replace(/\n/g, " ") // Remove newlines
        .replace(/,\s*]/g, "]") // Fix trailing commas in arrays
        .replace(/,\s*}/g, "}"); // Fix trailing commas in objects

      try {
        return JSON.parse(jsonText);
      } catch (parseError: any) {
        console.error(
          `❌ [LocalModelRouter] JSON parse failed: ${parseError.message}`,
        );
        // Log diagnostic snippet around error position
        const posMatch = parseError.message.match(/position (\d+)/);
        if (posMatch) {
          const p = parseInt(posMatch[1]);
          console.error(
            `Context: ...${jsonText.substring(Math.max(0, p - 40), Math.min(jsonText.length, p + 40))}...`,
          );
        } else {
          console.error(`Raw text was: ${jsonText.substring(0, 200)}...`);
        }
        return null;
      }
    } catch (e: any) {
      console.error(`⚠️ [LocalModelRouter] Agent routing failed: ${e.message}`);
      return null;
    }
  }
}
