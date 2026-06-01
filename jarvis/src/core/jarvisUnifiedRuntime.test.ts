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
});
