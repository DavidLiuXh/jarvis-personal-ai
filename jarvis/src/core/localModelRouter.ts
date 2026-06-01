/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaGenerateWithRetry } from "./ollamaClient.js";
import {
  FALLBACK_QUERY_SUBJECT,
  type ConversationTurn,
  type IntentFrame,
  type QuerySubject,
} from "./intentResolver.js";
import {
  DefaultIntentRuntime,
  type IntentRuntime,
} from "../intent-runtime/index.js";
import { JarvisIntentResolverAdapter } from "./jarvisIntentResolverAdapter.js";

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
  /** Full normalized intent frame used by downstream intent-aware policies. */
  intent: IntentFrame | null;
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
  intent: IntentFrame;
};

const TIME_SCOPED_CONVERSATION_RECALL_ROUTING_CAP = 58;
const EXTERNAL_PRODUCT_RECOMMENDATION_OPERATION_CAP = 35;

function hasExplicitTimeScope(intent: IntentFrame): boolean {
  return Boolean(
    intent.resolvedDateRange ||
      intent.dateFrom ||
      intent.dateTo ||
      typeof intent.timeWindowDays === "number",
  );
}

function isSimpleTimeScopedConversationRecall(intent: IntentFrame): boolean {
  if (intent.taskType !== "recall") return false;
  if (intent.semanticEvidence.memoryRecall.target !== "conversation_history") {
    return false;
  }
  if (!hasExplicitTimeScope(intent)) return false;
  if (
    intent.needsExternalKnowledge ||
    intent.needsTool ||
    intent.needsScheduling
  ) {
    return false;
  }
  if ((intent.candidateAgents ?? []).length > 0) return false;

  return intent.intentSteps.every((step) =>
    ["recall", "chat"].includes(step.type),
  );
}

function intentText(intent: IntentFrame): string {
  return [
    intent.reason,
    intent.richIntent.userGoal,
    intent.semanticEvidence.actionRequest.object ?? "",
    ...intent.evidence,
    ...intent.richIntent.targets.map((target) => target.value),
    ...intent.semanticEvidence.entityHints.technicalTerms,
    ...intent.semanticEvidence.entityHints.peopleOrCompanies,
  ].join("\n");
}

function isExternalProductRecommendation(intent: IntentFrame): boolean {
  if (intent.subject !== "external") return false;
  if (intent.needsMemory || intent.needsScheduling) return false;
  if (intent.taskType !== "chat" && intent.taskType !== "analyze") {
    return false;
  }
  const text = intentText(intent);
  const hasProductOrReviewCue =
    /用户评价|评价好|口碑|推荐|建议|哪(?:些|个).*(?:好|合适|值得)|best|top[-\s]?rated|review|reviews|recommend/i.test(
      text,
    );
  const hasPhysicalProductCue =
    /装置|配件|产品|工具|固定|收纳|行李|后备箱|后背箱|trunk|cargo|accessor(?:y|ies)|holder|organizer|mount|strap/i.test(
      text,
    );
  return hasProductOrReviewCue && hasPhysicalProductCue;
}

function hasGreetingPollutedReason(reason: string): boolean {
  return /initiating (?:a )?conversation|greeting|casual greeting|saying hi|寒暄|打招呼/i.test(
    reason,
  );
}

function calibrateRoutingIntent(intent: IntentFrame): {
  intent: IntentFrame;
  reasonSuffix: string;
  reasonOverride?: string;
} {
  if (!isExternalProductRecommendation(intent)) {
    return { intent, reasonSuffix: "" };
  }
  const knowledgeScore = intent.knowledgeScore ?? 65;
  const operationScore = Math.min(
    intent.operationScore ?? EXTERNAL_PRODUCT_RECOMMENDATION_OPERATION_CAP,
    EXTERNAL_PRODUCT_RECOMMENDATION_OPERATION_CAP,
  );
  const complexityScore = Math.round(
    knowledgeScore * 0.6 + operationScore * 0.4,
  );
  const calibrated =
    operationScore !== intent.operationScore ||
    complexityScore !== intent.complexityScore ||
    intent.taskType === "chat";
  if (!calibrated && !hasGreetingPollutedReason(intent.reason)) {
    return { intent, reasonSuffix: "" };
  }
  return {
    intent: {
      ...intent,
      taskType: intent.taskType === "chat" ? "analyze" : intent.taskType,
      operationScore,
      complexityScore,
      reason: hasGreetingPollutedReason(intent.reason)
        ? "External product recommendation/review lookup; low operational difficulty unless tool execution is explicitly requested."
        : intent.reason,
      evidence: intent.evidence.includes("routing_product_recommendation")
        ? intent.evidence
        : [...intent.evidence, "routing_product_recommendation"],
    },
    reasonSuffix: ` [routing_score=${complexityScore}, raw_complexity=${intent.complexityScore}, calibrated_operation=${operationScore}, calibration=external_product_recommendation]`,
    reasonOverride: hasGreetingPollutedReason(intent.reason)
      ? "External product recommendation/review lookup; low operational difficulty unless tool execution is explicitly requested."
      : undefined,
  };
}

function calibrateRoutingScore(intent: IntentFrame): {
  score: number;
  reasonSuffix: string;
} {
  const originalScore = intent.complexityScore;
  if (isSimpleTimeScopedConversationRecall(intent)) {
    const score = Math.min(
      originalScore,
      TIME_SCOPED_CONVERSATION_RECALL_ROUTING_CAP,
    );
    if (score !== originalScore) {
      return {
        score,
        reasonSuffix: ` [routing_score=${score}, raw_complexity=${originalScore}, calibration=time_scoped_conversation_recall]`,
      };
    }
  }
  return {
    score: originalScore,
    reasonSuffix: "",
  };
}

export class LocalModelRouter {
  private readonly intentRuntime?: IntentRuntime;

  constructor(
    private baseUrl: string = "http://localhost:11434",
    private classifierModel: string,
    private threshold: number = 70,
    private proModel: string = "gemini-2.5-pro",
    private flashModel: string = "gemini-2.5-flash",
    private timeoutMs: number = 30_000,
    private historyTurns: number = 5,
    private intentPolicyObservability: boolean = false,
    intentRuntime?: IntentRuntime,
  ) {
    this.intentRuntime = intentRuntime;
  }

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
        intent: classified.intent,
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
        intent: null,
      };
    }
  }

  private async classify(
    prompt: string,
    history: ConversationTurn[],
  ): Promise<ClassifyResult> {
    let intent = await this.resolveIntent(prompt, history);
    const intentCalibration = calibrateRoutingIntent(intent);
    intent = intentCalibration.intent;
    const knowledgeScore = intent.knowledgeScore;
    const operationScore = intent.operationScore;
    const routingScore = calibrateRoutingScore(intent);
    const breakdown =
      knowledgeScore !== null && operationScore !== null
        ? ` [knowledge=${knowledgeScore}, operation=${operationScore}]`
        : "";

    return {
      score: routingScore.score,
      reason: `${intentCalibration.reasonOverride ?? intent.reason}${breakdown}${intentCalibration.reasonSuffix}${routingScore.reasonSuffix}`,
      querySubject: intent.subject,
      topicShifted: intent.topicShifted,
      timeWindowDays: intent.timeWindowDays,
      dateFrom: intent.dateFrom,
      dateTo: intent.dateTo,
      resolvedDateRange: intent.resolvedDateRange,
      intent,
    };
  }

  async resolveIntent(
    userPrompt: string,
    history: ConversationTurn[] = [],
  ): Promise<IntentFrame> {
    const runtime =
      this.intentRuntime ??
      new DefaultIntentRuntime(
        new JarvisIntentResolverAdapter({
          baseUrl: this.baseUrl,
          model: this.classifierModel,
          timeoutMs: this.timeoutMs,
          historyTurns: this.historyTurns,
          intentPolicyObservability: this.intentPolicyObservability,
          modelSource: "local-model",
        }),
      );
    const result = await runtime.understand({
      userPrompt,
      history,
      executionContext: "interactive",
    });
    return result.intent;
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
      const raw = await ollamaGenerateWithRetry(this.classifierModel, prompt, {
        baseUrl: this.baseUrl,
        timeoutMs: Math.min(this.timeoutMs, 8_000),
        numPredict: 100,
        purpose: "local-router-topic-shift",
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
      const raw = await ollamaGenerateWithRetry(this.classifierModel, prompt, {
        baseUrl: this.baseUrl,
        timeoutMs: Math.min(this.timeoutMs, 10_000),
        numPredict: 60,
        purpose: "local-router-query-rewrite",
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
      const raw = await ollamaGenerateWithRetry(this.classifierModel, prompt, {
        baseUrl: this.baseUrl,
        timeoutMs: this.timeoutMs,
        purpose: "local-router-agent-route",
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
