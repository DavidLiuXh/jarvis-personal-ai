/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SqliteMemoryStore,
  type IntentFrame,
  type IntentStep,
} from "../memory-runtime/index.js";
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

function scheduleStep(overrides: Partial<IntentStep> = {}): IntentStep {
  return step({
    id: "step-1",
    type: "schedule",
    action: "添加定时任务",
    target: "每周五下午2点分析市场",
    operation: {
      domain: "task_management",
      action: "create",
      targetType: "task",
      target: "每周五下午2点分析市场",
      selector: "每周五下午2点分析市场",
      scope: "scheduled_tasks",
      riskLevel: "medium",
    },
    riskLevel: "medium",
    ...overrides,
  });
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

const tempDirs: string[] = [];

function tempDbPath() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-unified-runtime-"));
  tempDirs.push(dir);
  return path.join(dir, "memory.db");
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const toolRouter = {
    setCurrentMemoryContract: vi.fn(),
    setCurrentStepMemoryDecisions: vi.fn(),
    executeTools: vi.fn(async () => []),
  };
  const sqliteStore = new SqliteMemoryStore({
    dbPath: tempDbPath(),
    enableVectors: false,
  });
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
    memoryService: {
      skillIndexBuilding: false,
      getRuntimeSqliteMemoryStore: () => sqliteStore,
      searchConversationHistoryLexical: vi.fn().mockResolvedValue([]),
    },
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

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runJarvisUnifiedRuntimeTurn", () => {
  it("produces one shared external memory contract and system instruction", async () => {
    const input = baseInput();
    const result = await runJarvisUnifiedRuntimeTurn(input);

    expect(result.memoryContract.subjectBoundary).toBe("external");
    expect(result.memoryContract.constraints.allowPersonalFacts).toBe(false);
    expect(result.systemInstruction).toContain("external request");
    expect(result.systemInstruction).not.toContain("allow_personal_facts:");
    expect(result.systemInstruction).not.toContain("<runtime_memory_context>");
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

  it("passes TaskGraph recall artifacts into the LLM backend system context", async () => {
    const sqliteStore = new SqliteMemoryStore({
      dbPath: tempDbPath(),
      enableVectors: false,
    });
    const now = "2026-06-26T00:00:00.000Z";
    await sqliteStore.upsertFact({
      id: "hobby-bike",
      scope: "fact",
      subject: "profile",
      content: "爱好骑自行车",
      confidence: 0.8,
      sourceRefs: ["test"],
      createdAt: now,
      updatedAt: now,
      metadata: { category: "behavior", importance: 6 },
    });
    await sqliteStore.upsertFact({
      id: "hobby-hutong",
      scope: "fact",
      subject: "profile",
      content: "爱好逛胡同",
      confidence: 0.8,
      sourceRefs: ["test"],
      createdAt: now,
      updatedAt: now,
      metadata: { category: "behavior", importance: 6 },
    });
    const executeTools = vi.fn(async () => []);
    const toolRouter = {
      setCurrentMemoryContract: vi.fn(),
      setCurrentStepMemoryDecisions: vi.fn(),
      executeTools,
    };
    const recallStep = step({
      type: "recall",
      action: "recall",
      target: "我的爱好",
      operation: {
        domain: "memory",
        action: "recall",
        targetType: "memory",
        target: "我的爱好",
        selector: "我的爱好",
        scope: "user_memory",
        riskLevel: "low",
      },
      riskLevel: "low",
    });
    const recallIntent = intent({
      subject: "personal",
      taskType: "recall",
      needsMemory: true,
      needsExternalKnowledge: false,
      needsTool: false,
      reason: "recall user hobbies",
      evidence: ["还记得我的爱好吗？"],
      semanticEvidence: {
        personalContext: { present: true, reason: "personal", span: "我" },
        memoryRecall: {
          present: true,
          target: "user_memory",
          reason: "explicit recall",
          span: "记得我的爱好",
        },
        actionRequest: {
          present: true,
          action: "recall",
          object: "我的爱好",
        },
        entityHints: { tickers: [], technicalTerms: [], peopleOrCompanies: [] },
      },
      richIntent: {
        userGoal: "还记得我的爱好吗？",
        domain: "memory",
        action: "recall",
        primaryAction: "recall",
        targets: [{ type: "memory", value: "我的爱好" }],
        contextDependency: {
          recentConversation: false,
          longTermMemory: true,
          externalWorld: false,
          localWorkspace: false,
        },
        ambiguity: [],
        riskLevel: "low",
      },
      intentSteps: [recallStep],
    });
    let backendSystemContext = "";
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runJarvisUnifiedRuntimeTurn(
        baseInput({
          userPrompt: "还记得我的爱好吗？",
          querySubject: "personal",
          intent: recallIntent,
          toolRouter,
          memoryService: {
            skillIndexBuilding: false,
            getRuntimeSqliteMemoryStore: () => sqliteStore,
            searchConversationHistoryLexical: vi.fn().mockResolvedValue([]),
          },
          jarvisConfig: {
            memory: { writeObservability: true },
            agentRuntime: {
              enabled: true,
              executionMode: "execute",
              autonomousTaskRuntime: {
                enabled: true,
                mode: "execute",
                stateDir: path.dirname(tempDbPath()),
              },
            },
          },
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
                async *sendTurn(input: any) {
                  backendSystemContext =
                    input.messages.find(
                      (message: any) => message.role === "system",
                    )?.blocks?.[0]?.text ?? "";
                  yield {
                    type: "content" as const,
                    text: "你喜欢骑自行车和逛胡同。",
                  };
                },
              },
              promptCompiler: {
                compileInitialTurn: ({
                  systemContext,
                  initialMessages,
                }: any) => [
                  ...(systemContext?.trim()
                    ? [
                        {
                          role: "system",
                          blocks: [{ type: "text", text: systemContext }],
                        },
                      ]
                    : []),
                  ...initialMessages,
                ],
                compileToolResults: () => [],
                compileRetryPrompt: () => [],
              },
              toolExecutor: { executeTools: vi.fn(async () => []) },
              tools: [{ name: "recall_memory" }],
            },
            initialMessages: [
              {
                role: "user",
                blocks: [{ type: "text", text: "还记得我的爱好吗？" }],
              },
            ],
            signal: new AbortController().signal,
          },
        }),
      );

      expect(result.taskGraphExecution?.status).toBe("succeeded");
      expect(executeTools).not.toHaveBeenCalled();
      expect(result.llmLoop?.finalText).toBe("你喜欢骑自行车和逛胡同。");
      expect(backendSystemContext).toContain("<retrieved_memory>");
      expect(backendSystemContext).toContain("爱好骑自行车");
      expect(backendSystemContext).toContain("爱好逛胡同");
      expect(backendSystemContext).not.toContain("raw_content:");
      expect(backendSystemContext).not.toContain("<runtime_memory_context>");
      expect(backendSystemContext).not.toContain("<runtime_step_memory>");
      expect(backendSystemContext).not.toContain("<runtime_task_graph>");
      expect(backendSystemContext).not.toContain("- user: 还记得我的爱好吗？");
      expect(backendSystemContext).toContain(
        "recall_memory: disabled_for_this_turn",
      );
      const logs = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logs).toContain("🧭 [TaskGraph] artifact content:");
      expect(logs).toContain("<retrieved_memory>");
      expect(logs).toContain("爱好骑自行车");
      expect(logs).toContain("爱好逛胡同");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("adds a temporal recall boundary and passes the exact date range for time-scoped conversation recall", async () => {
    const range = {
      from: Date.parse("2026-06-01T00:00:00+08:00"),
      to: Date.parse("2026-06-02T00:00:00+08:00"),
    };
    const sqliteStore = new SqliteMemoryStore({
      dbPath: tempDbPath(),
      enableVectors: false,
    });
    const searchConversationHistoryLexical = vi.fn().mockResolvedValue([
      {
        text: "User: 昨天我们讨论了 Universal Memory Layer\nAssistant: 重点是三层记忆运行时。",
        score: 0.9,
        timestamp: Date.parse("2026-06-01T10:00:00+08:00"),
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
          getRuntimeSqliteMemoryStore: () => sqliteStore,
          searchConversationHistoryLexical,
        },
      }),
    );

    expect(searchConversationHistoryLexical).toHaveBeenCalledWith(
      expect.stringContaining("昨天我们讨论"),
      { limit: 8, dateRange: range },
    );
    expect(result.systemInstruction).toContain("<temporal_recall_boundary>");
    expect(result.systemInstruction).toContain(
      "requested_time_range: 2026-06-01~2026-06-01",
    );
    expect(result.systemInstruction).toContain(
      "Do not answer from the current/recent chat history",
    );
  });

  it("plans TaskGraph in the unified runtime when autonomous task runtime is plan_only", async () => {
    const result = await runJarvisUnifiedRuntimeTurn(
      baseInput({
        jarvisConfig: {
          memory: {},
          agentRuntime: {
            enabled: true,
            executionMode: "skip",
            autonomousTaskRuntime: {
              enabled: true,
              mode: "plan_only",
              stateDir: path.dirname(tempDbPath()),
            },
          },
        },
      }),
    );

    expect(result.taskGraph?.nodes.map((node) => node.kind)).toEqual([
      "analyze",
    ]);
    expect(result.taskGraphExecution).toBeNull();
    expect(result.systemInstruction).not.toContain("<runtime_task_graph>");
    expect(result.systemInstruction).not.toContain("execution: not_run");
  });

  it("executes deterministic TaskGraph nodes and injects the final response contract", async () => {
    const executeTools = vi.fn(async (requests) =>
      requests.map((request: any) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output:
          "✅ Jarvis internal task added and scheduled:\n  scheduler: Jarvis TaskScheduler (not system crontab)\n  id: market-weekly\n  cron: 0 14 * * 5\n  prompt: 分析市场",
      })),
    );
    const toolRouter = {
      setCurrentMemoryContract: vi.fn(),
      setCurrentStepMemoryDecisions: vi.fn(),
      executeTools,
    };
    const scheduleIntent = intent({
      subject: "personal",
      taskType: "schedule",
      needsMemory: true,
      needsExternalKnowledge: false,
      needsTool: true,
      needsScheduling: true,
      reason: "schedule task",
      evidence: ["添加一个定时任务：每周五下午2点分析市场"],
      semanticEvidence: {
        personalContext: { present: true, reason: "personal", span: "" },
        memoryRecall: { present: false, target: "none", reason: "", span: "" },
        actionRequest: {
          present: true,
          action: "schedule",
          object: "每周五下午2点分析市场",
        },
        entityHints: { tickers: [], technicalTerms: [], peopleOrCompanies: [] },
      },
      richIntent: {
        userGoal: "添加一个定时任务：每周五下午2点分析市场",
        domain: "task_management",
        action: "create",
        primaryAction: "schedule",
        targets: [{ type: "task", value: "分析市场" }],
        contextDependency: {
          recentConversation: false,
          longTermMemory: false,
          externalWorld: false,
          localWorkspace: false,
        },
        ambiguity: [],
        riskLevel: "medium",
      },
      intentSteps: [scheduleStep()],
    });

    const result = await runJarvisUnifiedRuntimeTurn(
      baseInput({
        userPrompt: "添加一个定时任务：每周五下午2点分析市场",
        querySubject: "personal",
        intent: scheduleIntent,
        toolRouter,
        jarvisConfig: {
          memory: {},
          agentRuntime: {
            enabled: true,
            executionMode: "execute",
            autonomousTaskRuntime: {
              enabled: true,
              mode: "execute",
              stateDir: path.dirname(tempDbPath()),
            },
          },
        },
      }),
    );

    expect(result.taskGraphExecution?.status).toBe("succeeded");
    expect(executeTools).toHaveBeenCalledTimes(1);
    expect(executeTools).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          name: "task_add",
          callId: "taskgraph-step-1-task_add",
        }),
      ],
      expect.any(Object),
    );
    expect(result.systemInstruction).not.toContain("<runtime_task_graph>");
    expect(result.systemInstruction).toContain("<runtime_execution_contract>");
    expect(result.systemInstruction).toContain("status: succeeded");
    expect(result.systemInstruction).toContain(
      "do not repeat completed recall/tool steps",
    );
    expect(result.systemInstruction).not.toContain(
      "All required task graph nodes passed acceptance",
    );
  });
});
