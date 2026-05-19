/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame } from "./intentResolver.js";
import {
  buildRecentConversationRecallCandidates,
  extractConversationRecallTerms,
} from "./conversationRecall.js";

function intent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  return {
    subject: "personal",
    taskType: "recall",
    needsMemory: true,
    needsExternalKnowledge: false,
    needsTool: false,
    needsScheduling: false,
    candidateAgents: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 40,
    knowledgeScore: 40,
    operationScore: 40,
    reason: "test",
    confidence: 0.8,
    confidenceByDimension: {
      subject: 0.8,
      taskType: 0.8,
      memoryTarget: 0.8,
      action: 0.8,
      entityHints: 0.8,
      topicShift: 0.8,
      richIntent: 0.8,
    },
    evidence: [],
    semanticEvidence: {
      personalContext: { present: false, reason: "", span: "" },
      memoryRecall: {
        present: true,
        target: "conversation_history",
        reason: "",
        span: "",
      },
      actionRequest: { present: false, action: "none", object: "" },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    richIntent: {
      userGoal: "summarize prior Zitong discussion",
      primaryAction: "recall",
      targets: [{ type: "memory", value: "梓潼相关讨论" }],
      contextDependency: {
        recentConversation: false,
        longTermMemory: true,
        localWorkspace: false,
        externalWorld: false,
      },
      ambiguity: [],
      riskLevel: "low",
    },
    intentSteps: [],
    topicAnalysis: {
      history: {
        label: "Previous discussion about Zitong",
        evidence: ["还记得之前我们讨论的梓潼相关的内容吗？"],
        sourceTurns: [-2],
        confidence: 0.8,
      },
      current: {
        label: "Summarize previous discussion",
        evidence: ["帮我汇总之前梓潼相关的探讨内容"],
        sourceTurns: [0],
        confidence: 0.8,
      },
      relation: "adjacent_topic",
      relationReason: "",
      confidence: 0.8,
      lowGrounding: false,
    },
    source: "local-intent/ollama",
    ...overrides,
  };
}

describe("conversation recall helpers", () => {
  it("extracts specific Chinese recall terms from generic phrasing", () => {
    const terms = extractConversationRecallTerms(
      "帮我汇总之前梓潼相关的探讨内容",
      intent(),
    );

    expect(terms).toContain("梓潼");
    expect(terms).not.toContain("之前");
    expect(terms).not.toContain("相关");
  });

  it("builds recent conversation candidates for conversation-history recall", () => {
    const candidates = buildRecentConversationRecallCandidates({
      userPrompt: "帮我汇总之前梓潼相关的探讨内容",
      intent: intent(),
      conversationHistory: [
        {
          role: "user",
          content: "还记得之前我们讨论的梓潼相关的内容吗？",
        },
        {
          role: "assistant",
          content:
            "我们之前聊过，您对梓潼、文昌帝君以及古蜀道等相关的文化和符号象征很感兴趣。",
        },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.matchedTerms).toContain("梓潼");
    expect(candidates[0]?.text).toContain("文昌帝君");
    expect(candidates[0]?.text).toContain("古蜀道");
  });

  it("does not build candidates for non-conversation memory targets", () => {
    const candidates = buildRecentConversationRecallCandidates({
      userPrompt: "帮我汇总之前梓潼相关的探讨内容",
      intent: intent({
        semanticEvidence: {
          ...intent().semanticEvidence,
          memoryRecall: {
            present: true,
            target: "user_memory",
            reason: "",
            span: "",
          },
        },
      }),
      conversationHistory: [
        {
          role: "assistant",
          content: "我们之前聊过梓潼。",
        },
      ],
    });

    expect(candidates).toHaveLength(0);
  });
});
