import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeContext,
  TaskRuntimePlanInput,
} from "../agent-runtime/index.js";
import type {
  IntentFrame,
  IntentStep,
  MemoryContract,
  MemoryRetrievalResult,
} from "../memory-runtime/index.js";
import { createJarvisTaskRuntime } from "./jarvisTaskGraphRuntime.js";

const tempDirs: string[] = [];

function tempStateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-task-graph-"));
  tempDirs.push(dir);
  return dir;
}

function step(overrides: Partial<IntentStep> = {}): IntentStep {
  return {
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
    dependsOn: [],
    requiresConfirmation: false,
    riskLevel: "medium",
    ...overrides,
  };
}

function intent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  const intentSteps = overrides.intentSteps ?? [step()];
  return {
    subject: "personal",
    taskType: "schedule",
    needsMemory: true,
    needsExternalKnowledge: false,
    needsTool: true,
    needsScheduling: true,
    candidateAgents: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 60,
    knowledgeScore: 20,
    operationScore: 90,
    reason: "schedule task",
    confidence: 0.95,
    confidenceByDimension: {
      subject: 1,
      taskType: 1,
      memoryTarget: 0.9,
      action: 1,
      entityHints: 0.8,
      topicShift: 1,
      richIntent: 1,
    },
    evidence: ["添加一个定时任务：每周五下午2点分析市场"],
    semanticEvidence: {
      personalContext: { present: true, reason: "user task", span: "" },
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
    intentSteps,
    topicAnalysis: {
      relation: "unknown",
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0 },
      current: {
        label: "schedule",
        evidence: ["添加一个定时任务：每周五下午2点分析市场"],
        sourceTurns: [0],
        confidence: 1,
      },
      relationReason: "test",
      confidence: 1,
      lowGrounding: false,
    },
    policyTrace: [],
    source: "test",
    ...overrides,
  };
}

function memoryContract(
  overrides: Partial<MemoryContract> = {},
): MemoryContract {
  return {
    needMemory: true,
    subjectBoundary: "personal",
    targetScopes: ["fact", "entry"],
    memoryTarget: "user_memory",
    query: { raw: "task", entities: [] },
    confidence: { subject: 1, target: 1, query: 1 },
    constraints: {
      allowPersonalFacts: true,
      allowSessionHistory: true,
      allowEntries: true,
      maxChars: 1000,
    },
    reasons: ["test"],
    policyTrace: [],
    ...overrides,
  };
}

function runtimeContext(
  overrides: Partial<RuntimeContext> = {},
): RuntimeContext {
  return {
    sessionId: "s1",
    userPrompt: "添加一个定时任务：每周五下午2点分析市场",
    history: [],
    now: new Date("2026-06-25T12:00:00+08:00"),
    executionContext: "interactive",
    interactiveChannel: true,
    metadata: {},
    intentResult: null,
    intent: null,
    memoryContract: null,
    stepMemoryDecisions: [],
    memoryRetrieval: null,
    memoryInjection: null,
    skills: [],
    execution: null,
    taskGraph: null,
    taskGraphExecution: null,
    llmLoop: null,
    response: null,
    ...overrides,
  };
}

function planInput(
  frame: IntentFrame,
  context = runtimeContext(),
  contract = memoryContract(),
): TaskRuntimePlanInput {
  return {
    context,
    intent: frame,
    memoryContract: contract,
    stepMemoryDecisions: [],
    skills: [],
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("createJarvisTaskRuntime", () => {
  it("plans and executes schedule nodes through Jarvis task_add", async () => {
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async (requests) =>
      requests.map((request: any) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output:
          "✅ Jarvis internal task added and scheduled:\n  scheduler: Jarvis TaskScheduler (not system crontab)\n  id: market-weekly\n  cron: 0 14 * * 5\n  prompt: 分析市场",
      })),
    );
    const taskRuntime = createJarvisTaskRuntime({
      sessionId: "s1",
      toolRouter: { executeTools } as any,
      config: {
        agentRuntime: {
          autonomousTaskRuntime: {
            enabled: true,
            mode: "execute",
            stateDir,
            observability: false,
          },
        },
      } as any,
    })!;
    const input = planInput(intent());
    const graph = await taskRuntime.plan(input);

    expect(graph?.nodes[0]).toMatchObject({
      id: "step-1",
      kind: "schedule",
      requiredCapabilities: ["task.schedule"],
    });
    expect(await taskRuntime.shouldExecute?.({ ...input, graph: graph! })).toBe(
      true,
    );

    const result = await taskRuntime.execute({ ...input, graph: graph! });

    expect(result?.status).toBe("succeeded");
    expect(executeTools).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          name: "task_add",
          callId: "taskgraph-step-1-task_add",
          args: expect.objectContaining({
            cron: "每周五下午2点",
            prompt: expect.stringContaining("分析市场"),
          }),
        }),
      ],
      expect.any(Object),
    );
    expect(result?.execution.artifacts[0]).toMatchObject({
      type: "scheduled_task",
      taskId: "market-weekly",
    });
    expect(result?.snapshot.id).toBe(graph?.id);
  });

  it("executes recall-only graphs through Jarvis memory recall instead of delegating to LLM active recall", async () => {
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async () => []);
    const memoryRecall = vi.fn(async (contract: MemoryContract) => {
      const now = "2026-06-26T00:00:00.000Z";
      return {
        contract,
        session: [],
        facts: [
          {
            item: {
              id: "1050",
              scope: "fact",
              subject: "profile",
              content: "爱好逛胡同",
              confidence: 0.8,
              sourceRefs: ["test"],
              createdAt: now,
              updatedAt: now,
              metadata: { category: "behavior", importance: 6 },
            },
            score: 0.3,
            reason: "sqlite_fact",
          },
          {
            item: {
              id: "1049",
              scope: "fact",
              subject: "profile",
              content: "爱好骑自行车",
              confidence: 0.8,
              sourceRefs: ["test"],
              createdAt: now,
              updatedAt: now,
              metadata: { category: "behavior", importance: 6 },
            },
            score: 0.29,
            reason: "sqlite_fact",
          },
        ],
        entries: [
          {
            item: {
              id: "entry-1",
              scope: "entry",
              kind: "conversation",
              content: "user: 还记得我的爱好吗？",
              entities: ["爱好"],
              timestamp: now,
              sourceRefs: ["s1"],
            },
            score: 0.9,
            reason: "sqlite_entry",
          },
          {
            item: {
              id: "entry-2",
              scope: "entry",
              kind: "conversation",
              content: "user: 还记得我的爱好吗？",
              entities: ["爱好"],
              timestamp: now,
              sourceRefs: ["s1"],
            },
            score: 0.88,
            reason: "sqlite_entry",
          },
          {
            item: {
              id: "entry-3",
              scope: "entry",
              kind: "conversation",
              content: "爱好骑自行车",
              entities: ["爱好"],
              timestamp: now,
              sourceRefs: ["s1"],
            },
            score: 0.85,
            reason: "sqlite_entry",
          },
        ],
      } satisfies MemoryRetrievalResult;
    });
    const taskRuntime = createJarvisTaskRuntime({
      sessionId: "s1",
      toolRouter: { executeTools } as any,
      memoryRecall,
      config: {
        agentRuntime: {
          autonomousTaskRuntime: {
            enabled: true,
            mode: "execute",
            stateDir,
            observability: false,
          },
        },
      } as any,
    })!;
    const recallStep = step({
      type: "recall",
      action: "recall",
      target: "user hobbies",
      operation: {
        domain: "memory",
        action: "recall",
        targetType: "memory",
        target: "user hobbies",
        selector: "user hobbies",
        scope: "user_memory",
        riskLevel: "low",
      },
      riskLevel: "low",
    });
    const frame = intent({
      taskType: "recall",
      needsScheduling: false,
      semanticEvidence: {
        personalContext: { present: true, reason: "personal", span: "" },
        memoryRecall: {
          present: true,
          target: "user_memory",
          reason: "explicit recall",
          span: "还记得我的爱好吗",
        },
        actionRequest: {
          present: true,
          action: "recall",
          object: "user hobbies",
        },
        entityHints: { tickers: [], technicalTerms: [], peopleOrCompanies: [] },
      },
      richIntent: {
        ...intent().richIntent,
        userGoal: "还记得我的爱好吗？",
        domain: "memory",
        action: "recall",
        primaryAction: "recall",
        contextDependency: {
          recentConversation: false,
          longTermMemory: true,
          externalWorld: false,
          localWorkspace: false,
        },
        riskLevel: "low",
      },
      intentSteps: [recallStep],
    });
    const input = planInput(
      frame,
      runtimeContext({ userPrompt: "还记得我的爱好吗？" }),
      memoryContract({
        memoryTarget: "user_memory",
        query: {
          raw: "还记得我的爱好吗？",
          rewritten: "爱好 hobbies",
          entities: ["爱好"],
        },
      }),
    );
    const graph = await taskRuntime.plan(input);

    expect(graph?.nodes.map((node) => node.kind)).toEqual(["recall"]);
    expect(await taskRuntime.shouldExecute?.({ ...input, graph: graph! })).toBe(
      true,
    );

    const result = await taskRuntime.execute({ ...input, graph: graph! });

    expect(executeTools).not.toHaveBeenCalled();
    expect(memoryRecall).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryTarget: "user_memory",
        targetScopes: ["fact", "entry"],
        query: expect.objectContaining({ rewritten: "爱好 hobbies" }),
      }),
    );
    expect(result?.status).toBe("succeeded");
    expect(result?.execution.artifacts[0]).toMatchObject({
      type: "memory",
      memoryItems: ["[behavior] 爱好逛胡同", "[behavior] 爱好骑自行车"],
      metadata: expect.objectContaining({
        factCount: 2,
        entryCount: 0,
        rawEntryCount: 3,
      }),
    });

    const secondResult = await taskRuntime.execute({ ...input, graph: graph! });

    expect(executeTools).not.toHaveBeenCalled();
    expect(memoryRecall).toHaveBeenCalledTimes(2);
    expect(secondResult?.status).toBe("succeeded");
    expect(secondResult?.execution.artifacts[0]).toMatchObject({
      type: "memory",
      memoryItems: ["[behavior] 爱好逛胡同", "[behavior] 爱好骑自行车"],
    });
  });

  it("recalls time-scoped conversation history with session and entry scopes", async () => {
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async () => []);
    const timeRange = {
      from: Date.parse("2026-06-27T00:00:00+08:00"),
      to: Date.parse("2026-06-28T00:00:00+08:00"),
    };
    const memoryRecall = vi.fn(async (contract: MemoryContract) => ({
      contract,
      facts: [],
      session: [
        {
          item: {
            scope: "session" as const,
            sessionId: "session-yesterday",
            summary:
              "昨天讨论了 TaskGraph 修复、美国市场预测文档读取、conversation history 召回策略。",
            turns: [
              {
                role: "user" as const,
                content: "昨天我们讨论了哪些问题？",
                timestamp: "2026-06-27T10:00:00+08:00",
              },
            ],
          },
          score: 0.92,
          reason: "sqlite_summary",
        },
      ],
      entries: [
        {
          item: {
            id: "entry-yesterday",
            scope: "entry" as const,
            kind: "conversation" as const,
            content:
              "User: 修复 TaskGraph 路径读取和 conversation_history recall。",
            entities: ["TaskGraph", "conversation_history"],
            timestamp: "2026-06-27T11:00:00+08:00",
            sourceRefs: ["session-yesterday"],
          },
          score: 0.83,
          reason: "sqlite_entry",
        },
      ],
    }));
    const taskRuntime = createJarvisTaskRuntime({
      sessionId: "s1",
      toolRouter: { executeTools } as any,
      memoryRecall,
      config: {
        agentRuntime: {
          autonomousTaskRuntime: {
            enabled: true,
            mode: "execute",
            stateDir,
            observability: false,
          },
        },
      } as any,
    })!;
    const recallStep = step({
      type: "recall",
      action: "recall",
      target: "conversation_history",
      operation: {
        domain: "memory",
        action: "recall",
        targetType: "memory",
        target: "conversation_history",
        selector: "昨天我们讨论了哪些问题？",
        scope: "conversation_history",
        riskLevel: "low",
      },
      riskLevel: "low",
    });
    const frame = intent({
      taskType: "recall",
      needsScheduling: false,
      timeWindowDays: null,
      dateFrom: "2026-06-27",
      dateTo: "2026-06-27",
      resolvedDateRange: timeRange,
      semanticEvidence: {
        personalContext: { present: false, reason: "", span: "" },
        memoryRecall: {
          present: true,
          target: "conversation_history",
          reason: "asks about yesterday's discussion",
          span: "昨天我们讨论了哪些问题",
        },
        actionRequest: {
          present: true,
          action: "recall",
          object: "昨天我们讨论了哪些问题",
        },
        entityHints: { tickers: [], technicalTerms: [], peopleOrCompanies: [] },
      },
      richIntent: {
        ...intent().richIntent,
        userGoal: "昨天我们讨论了哪些问题？",
        domain: "memory",
        action: "recall",
        primaryAction: "recall",
        targets: [{ type: "memory", value: "conversation_history" }],
        contextDependency: {
          recentConversation: false,
          longTermMemory: true,
          externalWorld: false,
          localWorkspace: false,
        },
        riskLevel: "low",
      },
      intentSteps: [recallStep],
    });
    const contract = memoryContract({
      memoryTarget: "conversation_history",
      targetScopes: ["session", "entry"],
      query: {
        raw: "昨天我们讨论了哪些问题？",
        entities: [],
        timeRange,
      },
      constraints: {
        allowPersonalFacts: false,
        allowSessionHistory: true,
        allowEntries: true,
        maxChars: 1800,
      },
      reasons: ["time_scoped_conversation_history"],
    });
    const input = planInput(
      frame,
      runtimeContext({ userPrompt: "昨天我们讨论了哪些问题？" }),
      contract,
    );
    const graph = await taskRuntime.plan(input);

    expect(graph?.nodes.map((node) => node.kind)).toEqual(["recall"]);

    const result = await taskRuntime.execute({ ...input, graph: graph! });

    expect(memoryRecall).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryTarget: "conversation_history",
        targetScopes: ["session", "entry"],
        query: expect.objectContaining({
          raw: "昨天我们讨论了哪些问题？",
          timeRange,
        }),
      }),
    );
    expect(memoryRecall.mock.calls[0]?.[0].query).not.toHaveProperty(
      "rewritten",
    );
    expect(result?.status).toBe("succeeded");
    expect(result?.execution.artifacts[0]).toMatchObject({
      type: "memory",
      memoryItems: expect.arrayContaining([
        expect.stringContaining("昨天讨论了 TaskGraph 修复"),
        expect.stringContaining("修复 TaskGraph 路径读取"),
      ]),
      metadata: expect.objectContaining({
        memoryTarget: "conversation_history",
        targetScopes: ["session", "entry"],
        rawSessionCount: 1,
        rawEntryCount: 1,
        sessionCount: 1,
        entryCount: 1,
        timeScopedSessionCount: 1,
        timeScopedEntryCount: 1,
      }),
    });
  });

  it("resumes persisted successful nodes without repeating deterministic tools", async () => {
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async (requests) =>
      requests.map((request: any) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output:
          "✅ Jarvis internal task added and scheduled:\n  scheduler: Jarvis TaskScheduler (not system crontab)\n  id: market-weekly\n  cron: 0 14 * * 5\n  prompt: 分析市场",
      })),
    );
    const taskRuntime = createJarvisTaskRuntime({
      sessionId: "s1",
      toolRouter: { executeTools } as any,
      config: {
        agentRuntime: {
          autonomousTaskRuntime: {
            enabled: true,
            mode: "execute",
            stateDir,
          },
        },
      } as any,
    })!;
    const input = planInput(intent());
    const graph = await taskRuntime.plan(input);

    const first = await taskRuntime.execute({ ...input, graph: graph! });
    const second = await taskRuntime.execute({ ...input, graph: graph! });

    expect(first?.status).toBe("succeeded");
    expect(second?.status).toBe("succeeded");
    expect(executeTools).toHaveBeenCalledTimes(1);
  });

  it("emits actionable autonomous task runtime logs when observability is enabled", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stateDir = tempStateDir();
      const executeTools = vi.fn(async (requests) =>
        requests.map((request: any) => ({
          name: request.name,
          callId: request.callId,
          status: "success",
          output:
            "✅ Jarvis internal task added and scheduled:\n  scheduler: Jarvis TaskScheduler (not system crontab)\n  id: market-weekly\n  cron: 0 14 * * 5\n  prompt: 分析市场",
        })),
      );
      const taskRuntime = createJarvisTaskRuntime({
        sessionId: "s1",
        toolRouter: { executeTools } as any,
        config: {
          agentRuntime: {
            autonomousTaskRuntime: {
              enabled: true,
              mode: "execute",
              stateDir,
              observability: true,
              maxRecoveryAttempts: 3,
            },
          },
        } as any,
      })!;
      const input = planInput(intent());
      const graph = await taskRuntime.plan(input);
      const shouldExecute = await taskRuntime.shouldExecute?.({
        ...input,
        graph: graph!,
      });
      const result = await taskRuntime.execute({ ...input, graph: graph! });
      const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");

      expect(shouldExecute).toBe(true);
      expect(result?.status).toBe("succeeded");
      expect(logs).toContain("[TaskGraph] runtime config mode=execute");
      expect(logs).toContain("maxRecoveryAttempts=3");
      expect(logs).toContain("[TaskGraph] context subject=personal");
      expect(logs).toContain("[TaskGraph] acceptance plan:");
      expect(logs).toContain("[TaskGraph] execution decision");
      expect(logs).toContain("execute=true");
      expect(logs).toContain("adapter=jarvis-task-schedule");
      expect(logs).toContain("caps=task.schedule");
      expect(logs).toContain("node acceptance id=step-1");
      expect(logs).toContain("task-scheduled:pass");
      expect(logs).toContain("artifacts:");
      expect(logs).toContain("taskId=market-weekly");
      expect(logs).toContain("snapshotStatus=succeeded");
      expect(logs).toContain("canClaimSuccess=true");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not pass schedule acceptance when task_add output has no observable task id", async () => {
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async (requests) =>
      requests.map((request: any) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output: "✅ Task was accepted by the scheduler.",
      })),
    );
    const taskRuntime = createJarvisTaskRuntime({
      sessionId: "s1",
      toolRouter: { executeTools } as any,
      config: {
        agentRuntime: {
          autonomousTaskRuntime: {
            enabled: true,
            mode: "execute",
            stateDir,
          },
        },
      } as any,
    })!;
    const input = planInput(intent());
    const graph = await taskRuntime.plan(input);

    const result = await taskRuntime.execute({ ...input, graph: graph! });

    expect(result?.status).toBe("failed");
    expect(result?.execution.failedReasons.join("\n")).toContain(
      "no scheduled task id observed",
    );
  });

  it("executes file write nodes only when concrete content is available", async () => {
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async (requests) =>
      requests.map((request: any) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output: JSON.stringify({
          ok: true,
          tool: "write_file",
          result: { path: "notes.md", mode: "overwrite", bytes: 12 },
        }),
      })),
    );
    const taskRuntime = createJarvisTaskRuntime({
      sessionId: "s1",
      toolRouter: { executeTools } as any,
      config: {
        agentRuntime: {
          autonomousTaskRuntime: {
            enabled: true,
            mode: "execute",
            stateDir,
          },
        },
      } as any,
    })!;
    const writeStep = step({
      type: "execute",
      action: "保存",
      target: "notes.md",
      operation: {
        domain: "general_chat",
        action: "create",
        targetType: "file",
        target: "notes.md",
        selector: "notes.md",
        scope: "workspace",
        riskLevel: "low",
      },
      riskLevel: "low",
    });
    const frame = intent({
      taskType: "execute",
      needsScheduling: false,
      richIntent: {
        ...intent().richIntent,
        userGoal: "保存到 notes.md",
        action: "create",
        primaryAction: "create",
        contextDependency: {
          recentConversation: true,
          longTermMemory: false,
          externalWorld: false,
          localWorkspace: true,
        },
      },
      intentSteps: [writeStep],
    });
    const input = planInput(
      frame,
      runtimeContext({
        userPrompt: "保存到 notes.md",
        currentContent: "hello world",
      }),
    );
    const graph = await taskRuntime.plan(input);
    const result = await taskRuntime.execute({ ...input, graph: graph! });

    expect(result?.status).toBe("succeeded");
    expect(executeTools).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          name: "write_file",
          args: {
            file_path: "notes.md",
            content: "hello world",
            mode: "overwrite",
          },
        }),
      ],
      expect.any(Object),
    );
    expect(result?.execution.artifacts[0]).toMatchObject({
      type: "file",
      path: "notes.md",
      exists: true,
      content: "hello world",
    });
  });

  it("writes current content for follow-up save-to-local-document requests", async () => {
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async (requests) =>
      requests.map((request: any) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output: JSON.stringify({
          ok: true,
          tool: "write_file",
          result: {
            path: request.args.file_path,
            mode: "overwrite",
            bytes: request.args.content.length,
          },
        }),
      })),
    );
    const taskRuntime = createJarvisTaskRuntime({
      sessionId: "s1",
      toolRouter: { executeTools } as any,
      config: {
        agentRuntime: {
          autonomousTaskRuntime: {
            enabled: true,
            mode: "execute",
            stateDir,
          },
        },
      } as any,
    })!;
    const writeStep = step({
      type: "chat",
      action: "save",
      target: "本地文档",
      operation: {
        domain: "general_chat",
        action: "create",
        targetType: "current_context",
        target: "本地文档",
        selector: "本地文档",
        scope: "workspace",
        riskLevel: "low",
      },
      riskLevel: "low",
    });
    const frame = intent({
      subject: "mixed",
      taskType: "chat",
      needsScheduling: false,
      referencesRecentHistory: false,
      semanticEvidence: {
        ...intent().semanticEvidence,
        memoryRecall: { present: false, target: "none", reason: "", span: "" },
        actionRequest: {
          present: true,
          action: "save",
          object: "本地文档",
        },
      },
      richIntent: {
        ...intent().richIntent,
        userGoal: "帮我保存到本地文档",
        domain: "general_chat",
        action: "answer",
        primaryAction: "chat",
        contextDependency: {
          recentConversation: false,
          longTermMemory: false,
          externalWorld: false,
          localWorkspace: false,
        },
      },
      intentSteps: [writeStep],
    });
    const input = planInput(
      frame,
      runtimeContext({
        userPrompt: "帮我保存到本地文档",
        currentContent: "PPO 到 DPO 的算法演进分析",
      }),
    );
    const graph = await taskRuntime.plan(input);
    const result = await taskRuntime.execute({ ...input, graph: graph! });

    expect(result?.status).toBe("succeeded");
    expect(executeTools).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          name: "write_file",
          args: expect.objectContaining({
            content: "PPO 到 DPO 的算法演进分析",
            mode: "overwrite",
          }),
        }),
      ],
      expect.any(Object),
    );
  });

  it("pre-executes only deterministic upstream nodes before LLM-dependent nodes", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async (requests) =>
      requests.map((request: any) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output: "source: authoritative AI Agent trend data",
      })),
    );
    try {
      const taskRuntime = createJarvisTaskRuntime({
        sessionId: "s1",
        toolRouter: { executeTools } as any,
        config: {
          agentRuntime: {
            autonomousTaskRuntime: {
              enabled: true,
              mode: "execute",
              stateDir,
              observability: true,
            },
          },
        } as any,
      })!;
      const collect = step({
        id: "step-1",
        type: "execute",
        action: "运行",
        target: "curl -s https://example.com/ai-agent-trends",
        operation: {
          domain: "general_chat",
          action: "run",
          targetType: "command",
          target: "curl -s https://example.com/ai-agent-trends",
          selector: "curl -s https://example.com/ai-agent-trends",
          scope: "workspace",
          riskLevel: "medium",
        },
        riskLevel: "medium",
      });
      const analyze = step({
        id: "step-2",
        type: "analyze",
        action: "分析",
        target: "AI Agent trend data",
        operation: {
          domain: "general_chat",
          action: "analyze",
          targetType: "external_entity",
          target: "AI Agent trend data",
          selector: "AI Agent trend data",
          scope: "external",
          riskLevel: "medium",
        },
        dependsOn: ["step-1"],
        riskLevel: "medium",
      });
      const write = step({
        id: "step-3",
        type: "execute",
        action: "保存",
        target: "agent_trend.md",
        operation: {
          domain: "general_chat",
          action: "create",
          targetType: "file",
          target: "agent_trend.md",
          selector: "agent_trend.md",
          scope: "workspace",
          riskLevel: "low",
        },
        dependsOn: ["step-2"],
        riskLevel: "low",
      });
      const frame = intent({
        taskType: "execute",
        needsScheduling: false,
        richIntent: {
          ...intent().richIntent,
          userGoal: "收集 AI Agent 趋势资料，分析后保存到 agent_trend.md",
          action: "create",
          primaryAction: "create",
          contextDependency: {
            recentConversation: false,
            longTermMemory: false,
            externalWorld: true,
            localWorkspace: true,
          },
        },
        intentSteps: [collect, analyze, write],
      });
      const input = planInput(
        frame,
        runtimeContext({
          userPrompt:
            "运行 curl -s https://example.com/ai-agent-trends，分析后保存到 agent_trend.md",
        }),
      );
      const graph = await taskRuntime.plan(input);

      expect(graph?.nodes.map((node) => node.kind)).toEqual([
        "run_shell",
        "analyze",
        "write_file",
      ]);
      expect(
        await taskRuntime.shouldExecute?.({ ...input, graph: graph! }),
      ).toBe(true);
      const result = await taskRuntime.execute({ ...input, graph: graph! });

      expect(result?.status).toBe("succeeded");
      expect(result?.graph.nodes.map((node) => node.id)).toEqual(["step-1"]);
      expect(executeTools).toHaveBeenCalledTimes(1);
      expect(executeTools).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: "run_shell_command",
            callId: "taskgraph-step-1-run_shell_command",
          }),
        ],
        expect.any(Object),
      );
      expect(result?.execution.finalResponseContract.canClaimSuccess).toBe(
        false,
      );
      expect(
        result?.execution.finalResponseContract.incompleteNodes.map(
          (node) => node.nodeId,
        ),
      ).toEqual(["step-2", "step-3"]);
      const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logs).toContain("execute=true");
      expect(logs).toContain("executable=step-1");
      expect(logs).toContain("llmBlocking=step-2");
      expect(logs).toContain("deferred=step-2,step-3");
      expect(logs).toContain("executedGraph=");
      expect(logs).toContain("canClaimSuccess=false");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("pre-executes source acquisition as research rather than workspace file writing", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async (requests) =>
      requests.map((request) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output: JSON.stringify({
          ok: true,
          tool: request.name,
          result: {
            command: request.args.command,
            stdout:
              "Title: AI Agent development trends\nURL Source: https://example.com/ai-agent-trends\nSummary: authoritative source data",
            stderr: "",
            exit_code: 0,
            timed_out: false,
          },
        }),
      })),
    );
    try {
      const taskRuntime = createJarvisTaskRuntime({
        sessionId: "s1",
        toolRouter: { executeTools } as any,
        config: {
          agentRuntime: {
            autonomousTaskRuntime: {
              enabled: true,
              mode: "execute",
              stateDir,
            },
          },
        } as any,
      })!;
      const collectSources = step({
        id: "step-1",
        type: "execute",
        action: "execute",
        target: "collect authoritative websites on AI Agent development trends",
        operation: {
          domain: "general_chat",
          action: "create",
          targetType: "file",
          target:
            "collect authoritative websites on AI Agent development trends",
          selector: "AI Agent development trends",
          scope: "workspace",
          riskLevel: "medium",
        },
        riskLevel: "medium",
      });
      const analyze = step({
        id: "step-2",
        type: "analyze",
        action: "analyze",
        target: "collected data",
        operation: {
          domain: "general_chat",
          action: "analyze",
          targetType: "external_entity",
          target: "collected data",
          selector: "collected data",
          scope: "external",
          riskLevel: "medium",
        },
        dependsOn: ["step-1"],
        riskLevel: "medium",
      });
      const frame = intent({
        taskType: "execute",
        needsScheduling: false,
        richIntent: {
          ...intent().richIntent,
          userGoal:
            "collect authoritative websites and analyze AI Agent development trends",
          action: "create",
          primaryAction: "create",
          contextDependency: {
            recentConversation: false,
            longTermMemory: false,
            externalWorld: true,
            localWorkspace: true,
          },
        },
        intentSteps: [collectSources, analyze],
      });
      const input = planInput(
        frame,
        runtimeContext({
          userPrompt:
            "collect authoritative websites and analyze AI Agent development trends",
          currentContent: "",
        }),
      );
      const graph = await taskRuntime.plan(input);

      expect(graph?.nodes.map((node) => node.kind)).toEqual([
        "research",
        "analyze",
      ]);
      expect(graph?.nodes[0].outputs).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "source" })]),
      );
      expect(graph?.nodes[0].acceptanceCriteria).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "source_count" }),
        ]),
      );
      expect(
        await taskRuntime.shouldExecute?.({ ...input, graph: graph! }),
      ).toBe(true);
      const result = await taskRuntime.execute({ ...input, graph: graph! });
      expect(result?.status).toBe("succeeded");
      expect(result?.execution.finalResponseContract.canClaimSuccess).toBe(
        false,
      );
      expect(result?.execution.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "step-1",
            type: "source",
            content: expect.stringContaining("AI Agent development trends"),
          }),
        ]),
      );
      expect(executeTools).toHaveBeenCalledTimes(1);
      expect(executeTools).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: "run_shell_command",
            callId: "taskgraph-step-1-web_search",
            args: expect.objectContaining({
              command: expect.stringContaining("https://s.jina.ai/"),
            }),
          }),
        ],
        expect.any(AbortSignal),
      );
      const command = executeTools.mock.calls[0][0][0].args.command;
      expect(command).toContain("AI%20Agent%20development%20trends");
      const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logs).toContain("executable=step-1");
      expect(logs).toContain("llmBlocking=step-2");
      expect(logs).toContain("step-2:deferred_to_main_llm_loop:analyze");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails open when optional research pre-execution times out", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async (requests) =>
      requests.map((request) => ({
        name: request.name,
        callId: request.callId,
        status: "failed",
        output: "curl: (28) Connection timed out after 20005 milliseconds",
      })),
    );
    try {
      const taskRuntime = createJarvisTaskRuntime({
        sessionId: "s1",
        toolRouter: { executeTools } as any,
        config: {
          agentRuntime: {
            autonomousTaskRuntime: {
              enabled: true,
              mode: "execute",
              stateDir,
            },
          },
        } as any,
      })!;
      const collectSources = step({
        id: "step-1",
        type: "execute",
        action: "execute",
        target: "collect authoritative websites on AI Agent development trends",
        operation: {
          domain: "external_knowledge",
          action: "create",
          targetType: "external_entity",
          target:
            "collect authoritative websites on AI Agent development trends",
          selector: "AI Agent development trends",
          scope: "external",
          riskLevel: "medium",
        },
        riskLevel: "medium",
      });
      const analyze = step({
        id: "step-2",
        type: "analyze",
        action: "analyze",
        target: "collected data",
        operation: {
          domain: "external_knowledge",
          action: "analyze",
          targetType: "external_entity",
          target: "collected data",
          selector: "collected data",
          scope: "external",
          riskLevel: "medium",
        },
        dependsOn: ["step-1"],
        riskLevel: "medium",
      });
      const input = planInput(
        intent({
          taskType: "execute",
          needsScheduling: false,
          richIntent: {
            ...intent().richIntent,
            userGoal:
              "collect authoritative websites and analyze AI Agent development trends",
            contextDependency: {
              recentConversation: false,
              longTermMemory: false,
              externalWorld: true,
              localWorkspace: false,
            },
          },
          intentSteps: [collectSources, analyze],
        }),
        runtimeContext({
          userPrompt:
            "collect authoritative websites and analyze AI Agent development trends",
        }),
      );
      const graph = await taskRuntime.plan(input);

      const result = await taskRuntime.execute({ ...input, graph: graph! });

      expect(result?.status).toBe("succeeded");
      expect(result?.replanDecisions).toEqual([]);
      expect(result?.execution.graph.nodes).toHaveLength(1);
      expect(result?.execution.graph.nodes[0].optional).toBe(true);
      expect(result?.execution.failedReasons).toEqual([
        "step-1: curl: (28) Connection timed out after 20005 milliseconds",
      ]);
      expect(result?.execution.finalResponseContract.incompleteNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "step-1",
            status: "failed",
            reason: "curl: (28) Connection timed out after 20005 milliseconds",
          }),
          expect.objectContaining({
            nodeId: "step-2",
            status: "pending",
          }),
        ]),
      );
      const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logs).not.toContain("source-repair");
      expect(logs).not.toContain("recovery_attempts_exhausted");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not pre-execute graphs that require LLM-generated content before deterministic writes", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async () => []);
    try {
      const taskRuntime = createJarvisTaskRuntime({
        sessionId: "s1",
        toolRouter: { executeTools } as any,
        config: {
          agentRuntime: {
            autonomousTaskRuntime: {
              enabled: true,
              mode: "execute",
              stateDir,
            },
          },
        } as any,
      })!;
      const analyze = step({
        id: "step-1",
        type: "analyze",
        action: "分析",
        target: "市场走势",
        operation: {
          domain: "general_chat",
          action: "analyze",
          targetType: "external_entity",
          target: "市场走势",
          selector: "市场走势",
          scope: "external",
          riskLevel: "medium",
        },
        riskLevel: "medium",
      });
      const write = step({
        id: "step-2",
        type: "execute",
        action: "保存",
        target: "market.md",
        operation: {
          domain: "general_chat",
          action: "create",
          targetType: "file",
          target: "market.md",
          selector: "market.md",
          scope: "workspace",
          riskLevel: "low",
        },
        dependsOn: ["step-1"],
        riskLevel: "low",
      });
      const frame = intent({
        taskType: "execute",
        needsScheduling: false,
        richIntent: {
          ...intent().richIntent,
          userGoal: "分析市场走势并保存到 market.md",
          action: "create",
          primaryAction: "create",
          contextDependency: {
            recentConversation: false,
            longTermMemory: false,
            externalWorld: true,
            localWorkspace: true,
          },
        },
        intentSteps: [analyze, write],
      });
      const input = planInput(frame, runtimeContext({ currentContent: "" }));
      const graph = await taskRuntime.plan(input);

      expect(graph?.nodes.map((node) => node.kind)).toEqual([
        "analyze",
        "write_file",
      ]);
      expect(
        await taskRuntime.shouldExecute?.({ ...input, graph: graph! }),
      ).toBe(false);
      expect(await taskRuntime.execute({ ...input, graph: graph! })).toBeNull();
      expect(executeTools).not.toHaveBeenCalled();
      const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logs).toContain("execute=false");
      expect(logs).toContain("llm_nodes_deferred_to_main_loop=step-1");
      expect(logs).toContain("llmBlocking=step-1");
      expect(logs).toContain("step-2:waiting_for_unexecuted_dependency:step-1");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("pre-executes repaired local directory reads before deferred analysis", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async (requests) =>
      requests.map((request: any) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output: {
          ok: true,
          path: request.args.path ?? request.args.paths?.[0],
          content: "market forecast notes",
        },
      })),
    );
    try {
      const taskRuntime = createJarvisTaskRuntime({
        sessionId: "s1",
        toolRouter: { executeTools } as any,
        config: {
          agentRuntime: {
            autonomousTaskRuntime: {
              enabled: true,
              mode: "execute",
              stateDir,
            },
          },
        } as any,
      })!;
      const userPrompt =
        "在/Users/lw/Documents/投资/美国市场预测目录下是最近一段时间对美国市场的预测，分析和复盘。以这些文档作参考，完成一篇分析，保存在本地文档中。";
      const frame = intent({
        subject: "external",
        taskType: "execute",
        needsMemory: false,
        needsScheduling: false,
        richIntent: {
          ...intent().richIntent,
          userGoal:
            "perform a deep unique analysis of US market predictions and save final document",
          action: "create",
          primaryAction: "create",
          contextDependency: {
            recentConversation: false,
            longTermMemory: false,
            externalWorld: false,
            localWorkspace: true,
          },
        },
        intentSteps: [
          step({
            id: "step-1",
            type: "analyze",
            action: "execute",
            target: "local_file_analysis",
            operation: {
              domain: "data_analysis",
              action: "analyze",
              targetType: "file",
              target: "local_file_analysis",
              riskLevel: "medium",
            },
            riskLevel: "medium",
          }),
          step({
            id: "step-2",
            type: "analyze",
            action: "analyze",
            target: "analysis_generation",
            operation: {
              domain: "data_analysis",
              action: "analyze",
              targetType: "external_entity",
              target: "analysis_generation",
              riskLevel: "medium",
            },
            dependsOn: ["step-1"],
            riskLevel: "medium",
          }),
          step({
            id: "step-3",
            type: "chat",
            action: "save",
            target: "final_document",
            operation: {
              domain: "document_generation",
              action: "answer",
              targetType: "current_context",
              target: "final_document",
              riskLevel: "low",
            },
            dependsOn: ["step-2"],
            riskLevel: "low",
          }),
        ],
      });
      const input = planInput(
        frame,
        runtimeContext({ userPrompt }),
        memoryContract({ subjectBoundary: "external", needMemory: false }),
      );
      const graph = await taskRuntime.plan(input);

      expect(graph?.nodes.map((node) => node.kind)).toEqual([
        "read_many_files",
        "analyze",
        "analyze",
        "respond",
        "write_file",
      ]);
      expect(
        await taskRuntime.shouldExecute?.({ ...input, graph: graph! }),
      ).toBe(true);

      const result = await taskRuntime.execute({ ...input, graph: graph! });

      expect(executeTools).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: "read_many_files",
            args: expect.objectContaining({
              paths: ["/Users/lw/Documents/投资/美国市场预测"],
              include: "*.md",
              recursive: false,
            }),
          }),
        ],
        expect.any(AbortSignal),
      );
      expect(result?.execution.graph.nodes).toHaveLength(1);
      expect(result?.execution.finalResponseContract.canClaimSuccess).toBe(
        false,
      );
      expect(result?.execution.finalResponseContract.incompleteNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: "step-1", status: "pending" }),
          expect.objectContaining({
            nodeId: "repair-write-final-artifact",
            status: "pending",
          }),
        ]),
      );
      const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logs).not.toContain("repair-read-local-input:missing_file_path");
    } finally {
      logSpy.mockRestore();
    }
  });
});
