/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaGenerate } from "./ollamaClient.js";
import {
  FALLBACK_QUERY_SUBJECT,
  IntentResolver,
  type ConversationTurn,
  type IntentFrame,
  type QuerySubject,
} from "./intentResolver.js";

export type {
  ConversationTurn,
  IntentFrame,
  QuerySubject,
} from "./intentResolver.js";

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
  topicShifted: boolean;
};

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
      const classified = await this.classify(userPrompt, history);
      const {
        score,
        reason,
        querySubject,
        topicShifted,
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
    const intent = await this.resolveIntent(prompt, history);
    const knowledgeScore = intent.knowledgeScore;
    const operationScore = intent.operationScore;
    const breakdown =
      knowledgeScore !== null && operationScore !== null
        ? ` [knowledge=${knowledgeScore}, operation=${operationScore}]`
        : "";

    return {
      score: intent.complexityScore,
      reason: `${intent.reason}${breakdown}`,
      querySubject: intent.subject,
      topicShifted: intent.topicShifted,
      timeWindowDays: intent.timeWindowDays,
      dateFrom: intent.dateFrom,
      dateTo: intent.dateTo,
      resolvedDateRange: intent.resolvedDateRange,
    };
  }

  async resolveIntent(
    userPrompt: string,
    history: ConversationTurn[] = [],
  ): Promise<IntentFrame> {
    const resolver = new IntentResolver({
      baseUrl: this.baseUrl,
      model: this.classifierModel,
      timeoutMs: this.timeoutMs,
      historyTurns: this.historyTurns,
    });
    return resolver.resolve({ userPrompt, history });
  }

  /**
   * Rewrite the user query into a concise memory search query.
   * Takes the current prompt + last N turns and produces focused keywords
   * that resolve pronouns/references and expand relevant terms.
   * Returns null on failure so the caller can fall back to the original query.
   */
  /**
   * @deprecated topic_shifted is now a dimension in classify() — no separate
   * Ollama call needed. This method exists only for standalone unit testing.
   * Do not call it in production code; use the topicShifted field from route().
   *
   * Detect whether the new user message is about a completely different topic
   * from the recent conversation. Returns true only when the shift is clear;
   * defaults to false on any ambiguity or error.
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
        numPredict: 100,
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
