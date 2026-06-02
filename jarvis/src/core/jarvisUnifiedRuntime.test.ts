/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import type { IntentFrame, IntentStep } from "../memory-runtime/index.js";
import { SystemPromptBuilder } from "./systemPromptBuilder.js";
import { MemoryInjectionPlanner } from "./memoryInjectionPlanner.js";
import { runJarvisUnifiedRuntimeTurn } from "./jarvisUnifiedRuntime.js";

function step(overrides: Partial<IntentStep> = {}): IntentStep {
  return {
    id: "step-1",
    type: "analyze",
    action: "answer",
    target: "question",
    operation: {
      domain: "general_chat",
      action: "analyze",
      targetType: "external_entity",
      target: "question",
      selector: "question",
      scope: "external",
      riskLevel: "low",
    },
    dependsOn: [],
    requiresConfirmation: false,
    riskLevel: "low",
    ...overrides,
  };
}

function intent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  return {
    subject: "external",
    taskType: "analyze",
    needsMemory: false,
    needsExternalKnowledge: true,
    needsTool: false,
    needsScheduling: false,
    candidateAgents: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 60,
    knowledgeScore: 70,
    operationScore: 0,
    reason: "external analysis",
    confidence: 0.95,
    confidenceByDimension: {
      subject: 0.95,
      taskType: 0.95,
      memoryTarget: 0.95,
      action: 0.9,
      entityHints: 0.8,
      topicShift: 0.95,
      richIntent: 0.9,
    },
    evidence: ["解释一下欧盟 AI Act"],
    semanticEvidence: {
      personalContext: { present: false, reason: "", span: "" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: {
        present: false,
        action: "none",
        object: "",
      },
      entityHints: { tickers: [], technicalTerms: [], peopleOrCompanies: [] },
    },
    richIntent: {
      userGoal: "解释一下欧盟 AI Act",
      domain: "general_chat",
      action: "analyze",
      primaryAction: "analyze",
      targets: [{ type: "external_entity", value: "EU AI Act" }],
      contextDependency: {
        recentConversation: false,
        longTermMemory: false,
        externalWorld: true,
        localWorkspace: false,
      },
      ambiguity: [],
      riskLevel: "low",
    },
    intentSteps: [step()],
    topicAnalysis: {
      relation: "unknown",
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0 },
      current: {
        label: "EU AI Act analysis",
        evidence: ["解释一下欧盟 AI Act"],
        sourceTurns: [0],
        confidence: 0.95,
      },
      relationReason: "standalone",
      confidence: 0.95,
      lowGrounding: false,
    },
    policyTrace: [],
    source: "test",
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const toolRouter = {
    setCurrentMemoryContract: vi.fn(),
    setCurrentStepMemoryDecisions: vi.fn(),
  };
  return {
    sessionId: "s1",
    userPrompt: "解释一下欧盟 AI Act",
    querySubject: "external" as const,
    timeWindowDays: null,
    resolvedDateRange: null,
    conversationHistory: [],
    intent: intent(),
    jarvisConfig: {
      memory: {},
      agentRuntime: { enabled: true, executionMode: "skip" },
    },
    memoryService: { skillIndexBuilding: false },
    availableSkills: [],
    conversationSummary: "",
    localModelRouter: null,
    promptBuilder: new SystemPromptBuilder(),
    toolRouter,
    runtimeIntentFeedbackCollector: { recordMemoryEvent: vi.fn() },
    interactiveChannel: true,
    buildMemoryInjectionPlanner: () =>
      new MemoryInjectionPlanner({
        maxTotalChars: 4000,
        maxFactChars: 1200,
        maxSummaryChars: 1200,
        maxPrewarmChars: 1200,
      }),
    ...overrides,
  } as any;
}

describe("runJarvisUnifiedRuntimeTurn", () => {
  it("produces one shared external memory contract and system instruction", async () => {
    const input = baseInput();
    const result = await runJarvisUnifiedRuntimeTurn(input);

    expect(result.memoryContract.subjectBoundary).toBe("external");
    expect(result.memoryContract.constraints.allowPersonalFacts).toBe(false);
    expect(result.systemInstruction).toContain("allow_personal_facts: false");
    expect(input.toolRouter.setCurrentMemoryContract).toHaveBeenCalledWith(
      result.memoryContract,
    );
  });

  it("can run the backend LLM loop from the unified runtime entry", async () => {
    const result = await runJarvisUnifiedRuntimeTurn(
      baseInput({
        llmRuntime: {
          options: {
            backend: {
              getModel: () => "mock",
              getCapabilities: () => ({
                streaming: true,
                nativeToolCalling: true,
                jsonMode: false,
                multimodalInput: false,
                maxContextTokens: 4096,
                modes: ["native_tool_calling"],
              }),
              async *sendTurn() {
                yield { type: "content" as const, text: "done" };
              },
            },
            promptCompiler: {
              compileInitialTurn: ({ initialMessages }: any) => initialMessages,
              compileToolResults: () => [],
              compileRetryPrompt: () => [],
            },
            toolExecutor: { executeTools: vi.fn(async () => []) },
          },
          initialMessages: [
            {
              role: "user",
              blocks: [{ type: "text", text: "解释一下欧盟 AI Act" }],
            },
          ],
          signal: new AbortController().signal,
        },
      }),
    );

    expect(result.llmLoop?.finalText).toBe("done");
  });

  it("adds a temporal recall boundary and passes the exact date range for time-scoped conversation recall", async () => {
    const range = {
      from: Date.parse("2026-06-01T00:00:00+08:00"),
      to: Date.parse("2026-06-02T00:00:00+08:00"),
    };
    const searchWithScore = vi.fn().mockResolvedValue([
      {
        text: "User: 昨天我们讨论了 Universal Memory Layer\nAssistant: 重点是三层记忆运行时。",
        score: 0.9,
      },
    ]);

    const result = await runJarvisUnifiedRuntimeTurn(
      baseInput({
        userPrompt: "汇总下昨天我们讨论了什么内容",
        querySubject: "personal",
        resolvedDateRange: range,
        intent: intent({
          subject: "personal",
          taskType: "recall",
          needsMemory: true,
          needsExternalKnowledge: false,
          timeWindowDays: null,
          dateFrom: "2026-06-01",
          dateTo: "2026-06-01",
          resolvedDateRange: range,
          semanticEvidence: {
            personalContext: {
              present: true,
              reason: "asks about prior conversation",
              span: "我们讨论",
            },
            memoryRecall: {
              present: true,
              target: "conversation_history",
              reason: "asks about yesterday conversation",
              span: "昨天我们讨论",
            },
            actionRequest: {
              present: false,
              action: "none",
              object: "",
            },
            entityHints: {
              tickers: [],
              technicalTerms: [],
              peopleOrCompanies: [],
            },
          },
          richIntent: {
            userGoal: "汇总昨天对话",
            domain: "memory_management",
            action: "recall",
            primaryAction: "recall",
            targets: [{ type: "memory", value: "conversation_history" }],
            contextDependency: {
              recentConversation: false,
              longTermMemory: true,
              externalWorld: false,
              localWorkspace: false,
            },
            ambiguity: [],
            riskLevel: "low",
          },
          intentSteps: [
            step({
              type: "recall",
              action: "summarize conversation history",
              target: "conversation_history",
              operation: {
                domain: "memory_management",
                action: "recall",
                targetType: "memory",
                target: "conversation_history",
                selector: "yesterday",
                scope: "long_term",
                riskLevel: "low",
              },
            }),
          ],
        }),
        memoryService: {
          skillIndexBuilding: false,
          searchFacts: vi.fn().mockResolvedValue([]),
          searchWithScore,
          searchSummaryChunks: vi.fn().mockResolvedValue([]),
        },
      }),
    );

    expect(searchWithScore).toHaveBeenCalledWith(
      expect.stringContaining("conversation_history"),
      expect.any(Number),
      null,
      range,
      expect.any(Number),
    );
    expect(result.systemInstruction).toContain("<temporal_recall_boundary>");
    expect(result.systemInstruction).toContain(
      "requested_time_range: 2026-06-01~2026-06-01",
    );
    expect(result.systemInstruction).toContain(
      "Do not answer from the current/recent chat history",
    );
  });
});
