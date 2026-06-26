import { describe, expect, it, vi } from "vitest";
import {
  AgentRuntime,
  DefaultResponseComposer,
  type RuntimeSkill,
} from "./index.js";
import {
  DefaultIntentRuntime,
  IntentExecutor,
  StaticIntentResolverAdapter,
  type AutonomousTaskRuntimeResult,
  type RuntimeToolRequest,
  type RuntimeToolResult,
  type TaskGraph,
  type ToolExecutorAdapter,
} from "../../intent-runtime/src/index.js";
import {
  DefaultMemoryRuntime,
  type ConversationTurn,
  type IntentFrame,
  type IntentStep,
  type MemoryContract,
  type MemoryInjectionResult,
  type MemoryRetrievalResult,
} from "../../memory-runtime/src/index.js";

function step(overrides: Partial<IntentStep> = {}): IntentStep {
  return {
    id: "step-1",
    type: "schedule",
    action: "明天早上9点提醒我复盘",
    target: "明天早上9点提醒我复盘",
    operation: {
      domain: "task_management",
      action: "create",
      targetType: "task",
      target: "明天早上9点提醒我复盘",
      selector: "明天早上9点提醒我复盘",
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
    complexityScore: 40,
    knowledgeScore: 10,
    operationScore: 80,
    reason: "schedule reminder",
    confidence: 0.95,
    confidenceByDimension: {
      subject: 0.95,
      taskType: 0.95,
      memoryTarget: 0.95,
      action: 0.95,
      entityHints: 0.95,
      topicShift: 0.95,
      richIntent: 0.95,
    },
    evidence: ["明天早上9点提醒我复盘"],
    semanticEvidence: {
      personalContext: { present: true, reason: "personal", span: "我" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: {
        present: true,
        action: "schedule",
        object: "明天早上9点提醒我复盘",
      },
      entityHints: { tickers: [], technicalTerms: [], peopleOrCompanies: [] },
    },
    richIntent: {
      userGoal: "明天早上9点提醒我复盘",
      domain: "task_management",
      action: "create",
      primaryAction: "schedule",
      targets: [{ type: "task", value: "复盘" }],
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
        label: "schedule request",
        evidence: ["明天早上9点提醒我复盘"],
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

function memoryContract(
  overrides: Partial<MemoryContract> = {},
): MemoryContract {
  return {
    needMemory: true,
    subjectBoundary: "personal",
    targetScopes: ["fact", "entry"],
    memoryTarget: "user_memory",
    query: { raw: "复盘", entities: ["复盘"] },
    confidence: { subject: 0.95, target: 0.9, query: 0.9 },
    constraints: {
      allowPersonalFacts: true,
      allowSessionHistory: false,
      allowEntries: true,
      maxChars: 1200,
    },
    reasons: ["test"],
    policyTrace: [],
    ...overrides,
  };
}

function memoryRuntime(contract = memoryContract()) {
  const retrieval: MemoryRetrievalResult = {
    contract,
    session: [],
    facts: [],
    entries: [],
  };
  const injection: MemoryInjectionResult = {
    text: "<memory>user likes concise reminders</memory>",
    usedChars: 43,
    injected: { session: 0, facts: 0, entries: 1 },
    rejected: [],
    trace: [],
  };
  const planMemory = vi.fn(async () => contract);
  const retrieve = vi.fn(async () => retrieval);
  const inject = vi.fn(async () => injection);
  return {
    runtime: new DefaultMemoryRuntime<IntentFrame>({
      understand: async () => intent(),
      planMemory,
      retrieve,
      inject,
    }),
    retrieval,
    injection,
    planMemory,
    retrieve,
    inject,
  };
}

function recallTaskGraph(): TaskGraph {
  return {
    id: "graph-recall",
    rootTaskId: "task-recall",
    nodes: [
      {
        id: "step-1",
        title: "recall user memory",
        kind: "recall",
        requiredCapabilities: ["memory.recall"],
        inputs: [],
        outputs: [
          {
            id: "step-1-memory",
            type: "memory",
            description: "retrieved memory",
            required: true,
          },
        ],
        acceptanceCriteria: [
          {
            id: "step-1-memory-retrieved",
            scope: "step",
            type: "memory_retrieved",
            description: "memory retrieved",
            required: true,
            validator: "memory_retrieved",
            params: { minItems: 1 },
          },
        ],
        retryPolicy: { maxAttempts: 1, strategy: "none" },
        optional: false,
      },
    ],
    edges: [],
    globalConstraints: [],
    acceptanceCriteria: [
      {
        id: "final-memory-retrieved",
        scope: "final_response",
        type: "memory_retrieved",
        description: "memory retrieved",
        required: true,
        validator: "memory_retrieved",
        params: { minItems: 1 },
      },
    ],
    status: "planned",
    blockedReasons: [],
  };
}

function recallTaskGraphResult(
  graph = recallTaskGraph(),
): AutonomousTaskRuntimeResult {
  return {
    status: "succeeded",
    graph,
    execution: {
      status: "succeeded",
      graph,
      nodes: [
        {
          node: graph.nodes[0],
          status: "succeeded",
          attempts: 1,
          output: { ok: true },
          artifacts: [
            {
              id: "step-1-memory",
              nodeId: "step-1",
              type: "memory",
              content: "user likes tea and hiking",
              memoryItems: [{ text: "user likes tea and hiking" }],
            },
          ],
          acceptanceResults: [
            {
              criterionId: "step-1-memory-retrieved",
              ok: true,
              blocking: true,
              reason: "memory retrieved",
            },
          ],
          lastError: null,
        },
      ],
      artifacts: [
        {
          id: "step-1-memory",
          nodeId: "step-1",
          type: "memory",
          content: "user likes tea and hiking",
          memoryItems: [{ text: "user likes tea and hiking" }],
        },
      ],
      blockedReasons: [],
      failedReasons: [],
      finalResponseContract: {
        canClaimSuccess: true,
        incompleteNodes: [],
        instruction: "Use the retrieved memory artifact.",
      },
    },
    snapshot: {} as AutonomousTaskRuntimeResult["snapshot"],
    replanDecisions: [],
  };
}

function toolExecutor(
  fn: (request: RuntimeToolRequest) => RuntimeToolResult,
): ToolExecutorAdapter {
  return {
    executeTools: vi.fn(async (requests: RuntimeToolRequest[]) =>
      requests.map(fn),
    ),
  };
}

describe("AgentRuntime", () => {
  it("runs the full intent-memory-skill-execution-response lifecycle", async () => {
    const frame = intent();
    const events: string[] = [];
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime();
    const toolAdapter = toolExecutor((request) => ({
      name: request.name,
      callId: request.callId,
      status: "success",
      output: "✅ Jarvis internal task added",
    }));
    const executor = new IntentExecutor(toolAdapter);
    const skills: RuntimeSkill[] = [
      { name: "scheduler", description: "Create Jarvis scheduled tasks" },
    ];
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, executor, {
      skillRuntime: { retrieve: vi.fn(async () => skills) },
      observer: (event) => events.push(event.type),
    });

    const result = await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "明天早上9点提醒我复盘",
      history: [],
    });

    expect(result.context.intent).toBe(frame);
    expect(result.context.memoryContract?.memoryTarget).toBe("user_memory");
    expect(result.context.stepMemoryDecisions).toHaveLength(1);
    expect(result.context.skills.map((skill) => skill.name)).toEqual([
      "scheduler",
    ]);
    expect(result.context.execution?.status).toBe("succeeded");
    expect(result.response.canClaimSuccess).toBe(true);
    expect(result.response.systemContext).toContain("<memory_decision>");
    expect(result.response.systemContext).toContain("<runtime_skills>");
    expect(toolAdapter.executeTools).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "turn_started",
      "intent_completed",
      "memory_completed",
      "skills_completed",
      "execution_completed",
      "response_composed",
      "turn_completed",
    ]);
  });

  it("shares external memory boundaries with response composition and step decisions", async () => {
    const frame = intent({ subject: "external", needsMemory: false });
    const contract = memoryContract({
      needMemory: false,
      subjectBoundary: "external",
      targetScopes: [],
      memoryTarget: "none",
      constraints: {
        allowPersonalFacts: false,
        allowSessionHistory: false,
        allowEntries: false,
        maxChars: 0,
      },
      reasons: ["external_subject"],
    });
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime(contract);
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, undefined, {
      executionMode: "skip",
      responseComposer: new DefaultResponseComposer(),
    });

    const result = await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "Gemini Spark 发布了吗？",
    });

    expect(result.context.memoryRetrieval?.entries).toEqual([]);
    expect(result.context.stepMemoryDecisions[0].constraints).toMatchObject({
      allowPersonalFacts: false,
      allowSessionHistory: false,
      allowEntries: false,
    });
    expect(result.response.instructions.join("\n")).toContain(
      "external request",
    );
    expect(result.response.systemContext).toContain(
      "allow_personal_facts: false",
    );
  });

  it("blocks success claims in composed response when execution is incomplete", async () => {
    const frame = intent();
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime();
    const executor = new IntentExecutor(
      toolExecutor((request) => ({
        name: request.name,
        callId: request.callId,
        status: "failed",
        output: "❌ scheduler unavailable",
      })),
      undefined,
      { maxAttemptsPerStep: 1 },
    );
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, executor);

    const result = await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "明天早上9点提醒我复盘",
    });

    expect(result.context.execution?.status).toBe("blocked");
    expect(result.response.canClaimSuccess).toBe(false);
    expect(result.response.systemContext).toContain("Do not claim completion");
  });

  it("can orchestrate the backend LLM tool loop from handleTurn", async () => {
    const frame = intent({
      subject: "personal",
      taskType: "execute",
      needsMemory: false,
    });
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime(
      memoryContract({
        needMemory: false,
        targetScopes: [],
        memoryTarget: "none",
        constraints: {
          allowPersonalFacts: false,
          allowSessionHistory: false,
          allowEntries: false,
          maxChars: 0,
        },
      }),
    );
    const toolAdapter = toolExecutor((request) => ({
      name: request.name,
      callId: request.callId,
      status: "success",
      output: { ok: true },
    }));
    let backendTurns = 0;
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, undefined, {
      llmLoop: {
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
            backendTurns++;
            if (backendTurns === 1) {
              yield {
                type: "tool_call",
                request: {
                  name: "task_add",
                  callId: "call-1",
                  args: { title: "review" },
                },
              };
            } else {
              yield { type: "content", text: "done" };
            }
          },
        },
        promptCompiler: {
          compileInitialTurn: ({ initialMessages }) => initialMessages,
          compileToolResults: () => [],
          compileRetryPrompt: () => [],
        },
        toolExecutor: toolAdapter,
      },
    });

    const result = await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "schedule review",
      llmInitialMessages: [
        { role: "user", blocks: [{ type: "text", text: "schedule review" }] },
      ],
      signal: new AbortController().signal,
    });

    expect(result.context.llmLoop?.toolsCalled.has("task_add")).toBe(true);
    expect(toolAdapter.executeTools).toHaveBeenCalledOnce();
  });

  it("defers memory retrieval when executable TaskGraph runtime owns memory access", async () => {
    const frame = intent({
      taskType: "recall",
      needsMemory: true,
      intentSteps: [
        step({
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
        }),
      ],
    });
    const graph = recallTaskGraph();
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime();
    const plan = vi.fn(async () => {
      expect(memory.retrieve).not.toHaveBeenCalled();
      return graph;
    });
    const execute = vi.fn(async () => {
      expect(memory.retrieve).not.toHaveBeenCalled();
      return recallTaskGraphResult(graph);
    });
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, undefined, {
      taskRuntime: { mode: "execute", plan, execute },
      deferMemoryRetrievalForTaskGraph: true,
    });

    const result = await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "还记得我的爱好吗？",
    });

    expect(plan).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(memory.retrieve).not.toHaveBeenCalled();
    expect(memory.inject).toHaveBeenCalledWith(
      expect.objectContaining({
        retrieval: expect.objectContaining({
          session: [],
          facts: [],
          entries: [],
        }),
      }),
    );
    expect(result.response.systemContext).toContain(
      "task_graph_memory_recall_completed",
    );
    expect(result.response.systemContext).toContain("memory_items:");
    expect(result.response.systemContext).toContain(
      '{"text":"user likes tea and hiking"}',
    );
  });

  it("suppresses recall_memory in the LLM loop after TaskGraph memory recall succeeds", async () => {
    const frame = intent({
      taskType: "recall",
      needsMemory: true,
      intentSteps: [
        step({
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
        }),
      ],
    });
    const graph = recallTaskGraph();
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime();
    const toolAdapter = toolExecutor((request) => ({
      name: request.name,
      callId: request.callId,
      status: "success",
      output: { ok: true },
    }));
    const observedTools: string[][] = [];
    let backendTurns = 0;
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, undefined, {
      taskRuntime: {
        mode: "execute",
        plan: vi.fn(async () => graph),
        execute: vi.fn(async () => recallTaskGraphResult(graph)),
      },
      deferMemoryRetrievalForTaskGraph: true,
      llmLoop: {
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
          async *sendTurn(input) {
            observedTools.push(input.tools?.map((tool) => tool.name) ?? []);
            backendTurns++;
            if (backendTurns === 1) {
              yield {
                type: "tool_call",
                request: {
                  name: "recall_memory",
                  callId: "recall-1",
                  args: { query: "hobbies" },
                },
              };
            } else {
              yield { type: "content", text: "done" };
            }
          },
        },
        promptCompiler: {
          compileInitialTurn: ({ initialMessages }) => initialMessages,
          compileToolResults: () => [
            {
              role: "tool",
              blocks: [
                {
                  type: "tool_result",
                  name: "recall_memory",
                  callId: "recall-1",
                  result: { ok: false },
                },
              ],
            },
          ],
          compileRetryPrompt: () => [],
        },
        toolExecutor: toolAdapter,
        tools: [{ name: "recall_memory" }, { name: "task_add" }],
      },
    });

    const result = await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "还记得我的爱好吗？",
      llmInitialMessages: [
        {
          role: "user",
          blocks: [{ type: "text", text: "还记得我的爱好吗？" }],
        },
      ],
      signal: new AbortController().signal,
    });

    expect(observedTools[0]).toEqual([]);
    expect(toolAdapter.executeTools).not.toHaveBeenCalled();
    expect(result.context.llmLoop?.finalText).toBe("done");
  });

  it("selects only intent-relevant tools when no TaskGraph has taken ownership", async () => {
    const frame = intent({
      taskType: "schedule",
      needsMemory: false,
      needsTool: true,
      needsScheduling: true,
      intentSteps: [step()],
    });
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime(
      memoryContract({ needMemory: false, memoryTarget: "none" }),
    );
    const observedTools: string[][] = [];
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, undefined, {
      llmLoop: {
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
          async *sendTurn(input) {
            observedTools.push(input.tools?.map((tool) => tool.name) ?? []);
            yield { type: "content", text: "scheduled" };
          },
        },
        promptCompiler: {
          compileInitialTurn: ({ initialMessages }) => initialMessages,
          compileToolResults: () => [],
          compileRetryPrompt: () => [],
        },
        toolExecutor: toolExecutor((request) => ({
          name: request.name,
          callId: request.callId,
          status: "success",
          output: {},
        })),
        tools: [
          { name: "recall_memory" },
          { name: "task_add" },
          { name: "task_list" },
          { name: "write_file" },
          { name: "run_shell_command" },
        ],
      },
    });

    await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "明天早上9点提醒我复盘",
      llmInitialMessages: [
        {
          role: "user",
          blocks: [{ type: "text", text: "明天早上9点提醒我复盘" }],
        },
      ],
      signal: new AbortController().signal,
    });

    expect(observedTools[0]).toEqual(["task_add", "task_list"]);
  });

  it("sends no tools for plain answer intents", async () => {
    const frame = intent({
      taskType: "answer",
      needsMemory: false,
      needsTool: false,
      needsScheduling: false,
      intentSteps: [],
      richIntent: {
        ...intent().richIntent,
        action: "answer",
        primaryAction: "answer",
        contextDependency: {
          recentConversation: false,
          longTermMemory: false,
          localWorkspace: false,
          externalWorld: false,
        },
        targets: [],
      },
    });
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime(
      memoryContract({ needMemory: false, memoryTarget: "none" }),
    );
    const observedTools: string[][] = [];
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, undefined, {
      llmLoop: {
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
          async *sendTurn(input) {
            observedTools.push(input.tools?.map((tool) => tool.name) ?? []);
            yield { type: "content", text: "answer" };
          },
        },
        promptCompiler: {
          compileInitialTurn: ({ initialMessages }) => initialMessages,
          compileToolResults: () => [],
          compileRetryPrompt: () => [],
        },
        toolExecutor: toolExecutor((request) => ({
          name: request.name,
          callId: request.callId,
          status: "success",
          output: {},
        })),
        tools: [
          { name: "recall_memory" },
          { name: "task_add" },
          { name: "write_file" },
          { name: "run_shell_command" },
        ],
      },
    });

    await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "你好",
      llmInitialMessages: [
        { role: "user", blocks: [{ type: "text", text: "你好" }] },
      ],
      signal: new AbortController().signal,
    });

    expect(observedTools[0]).toEqual([]);
  });
});
