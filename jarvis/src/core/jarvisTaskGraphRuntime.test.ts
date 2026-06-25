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

function memoryContract(): MemoryContract {
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
): TaskRuntimePlanInput {
  return {
    context,
    intent: frame,
    memoryContract: memoryContract(),
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

  it("does not pre-execute graphs that require LLM-generated content before deterministic writes", async () => {
    const stateDir = tempStateDir();
    const executeTools = vi.fn(async () => []);
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
    expect(await taskRuntime.shouldExecute?.({ ...input, graph: graph! })).toBe(
      false,
    );
    expect(await taskRuntime.execute({ ...input, graph: graph! })).toBeNull();
    expect(executeTools).not.toHaveBeenCalled();
  });
});
