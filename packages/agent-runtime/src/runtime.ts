/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AutonomousTaskRuntimeResult,
  IntentRuntime,
  IntentRuntimeEvent,
  IntentRuntimeInput,
  IntentRuntimeResult,
  TaskGraph,
} from "@jarvis/intent-runtime";
import type {
  IntentExecutionResult,
  IntentExecutor,
  IntentExecutorContext,
  IntentExecutorEvent,
} from "@jarvis/intent-runtime";
import type {
  ConversationTurn,
  IntentFrame,
  MemoryContract,
  MemoryInjectionResult,
  MemoryRetrievalResult,
  MemoryRuntime,
  MemoryRuntimeEvent,
  StepMemoryDecision,
  TokenBudget,
} from "@jarvis/memory-runtime";
import {
  ToolLoopRuntime,
  type LlmMessage,
  type ToolLoopRuntimeOptions,
  type ToolLoopRunResult,
} from "./llmBackend.js";

export type RuntimeContext = {
  sessionId: string;
  userPrompt: string;
  history: ConversationTurn[];
  currentContent?: string;
  artifacts?: Record<string, string>;
  now: Date;
  executionContext: IntentRuntimeInput["executionContext"];
  interactiveChannel: boolean;
  metadata: Record<string, unknown>;
  intentResult: IntentRuntimeResult | null;
  intent: IntentFrame | null;
  memoryContract: MemoryContract | null;
  stepMemoryDecisions: StepMemoryDecision[];
  memoryRetrieval: MemoryRetrievalResult | null;
  memoryInjection: MemoryInjectionResult | null;
  skills: RuntimeSkill[];
  execution: IntentExecutionResult | null;
  taskGraph: TaskGraph | null;
  taskGraphExecution: AutonomousTaskRuntimeResult | null;
  llmLoop: ToolLoopRunResult | null;
  response: RuntimeResponse | null;
};

export type TaskRuntimeMode = "execute" | "plan_only" | "skip";

export type TaskRuntimePlanInput = {
  context: RuntimeContext;
  intent: IntentFrame;
  memoryContract: MemoryContract;
  stepMemoryDecisions: StepMemoryDecision[];
  skills: RuntimeSkill[];
};

export type TaskRuntimeExecuteInput = TaskRuntimePlanInput & {
  graph: TaskGraph;
  signal?: AbortSignal;
};

export type TaskRuntime = {
  mode?: TaskRuntimeMode;
  plan(input: TaskRuntimePlanInput): Promise<TaskGraph | null>;
  shouldExecute?(input: TaskRuntimeExecuteInput): boolean | Promise<boolean>;
  execute(
    input: TaskRuntimeExecuteInput,
  ): Promise<AutonomousTaskRuntimeResult | null>;
};

export type RuntimeSkill = {
  name: string;
  content?: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export type SkillRuntimeInput = {
  context: RuntimeContext;
  limit?: number;
  maxDistance?: number;
};

export type SkillRuntime = {
  retrieve(input: SkillRuntimeInput): Promise<RuntimeSkill[]>;
};

export type StepMemoryPlannerInput = {
  context: RuntimeContext;
  contract: MemoryContract;
  intent: IntentFrame;
};

export type StepMemoryPlanner = (
  input: StepMemoryPlannerInput,
) => Promise<StepMemoryDecision[]> | StepMemoryDecision[];

export type RuntimeResponse = {
  text: string;
  systemContext: string;
  instructions: string[];
  canClaimSuccess: boolean;
  metadata: Record<string, unknown>;
};

export type ResponseComposerInput = {
  context: RuntimeContext;
};

export type ResponseComposer = {
  compose(input: ResponseComposerInput): Promise<RuntimeResponse>;
};

export type AgentRuntimeExecutionMode = "execute" | "plan_only" | "skip";

export type AgentRuntimeEvent =
  | {
      type: "turn_started";
      sessionId: string;
      promptLength: number;
      historyTurns: number;
    }
  | { type: "intent_event"; event: IntentRuntimeEvent }
  | { type: "intent_completed"; result: IntentRuntimeResult }
  | { type: "memory_event"; event: MemoryRuntimeEvent }
  | { type: "memory_completed"; contract: MemoryContract }
  | { type: "skills_completed"; skills: RuntimeSkill[] }
  | { type: "task_graph_planned"; graph: TaskGraph | null }
  | {
      type: "task_graph_completed";
      result: AutonomousTaskRuntimeResult | null;
    }
  | { type: "execution_event"; event: IntentExecutorEvent }
  | { type: "execution_completed"; result: IntentExecutionResult | null }
  | { type: "response_composed"; response: RuntimeResponse }
  | { type: "turn_completed"; context: RuntimeContext }
  | { type: "turn_failed"; error: string; context: RuntimeContext };

export type AgentRuntimeObserver = (
  event: AgentRuntimeEvent,
) => void | Promise<void>;

export type AgentRuntimeOptions = {
  memoryBudget?: TokenBudget;
  executionMode?: AgentRuntimeExecutionMode;
  skillLimit?: number;
  skillMaxDistance?: number;
  observer?: AgentRuntimeObserver;
  llmLoop?: ToolLoopRuntimeOptions;
  taskRuntime?: TaskRuntime;
  /**
   * When an executable TaskRuntime is enabled, keep memory retrieval behind the
   * task graph. This lets explicit recall/search steps own memory access instead
   * of doing generic prewarm before the graph has been planned.
   */
  deferMemoryRetrievalForTaskGraph?: boolean;
};

export type AgentRuntimeInput = {
  sessionId: string;
  userPrompt: string;
  history?: ConversationTurn[];
  now?: Date;
  executionContext?: IntentRuntimeInput["executionContext"];
  interactiveChannel?: boolean;
  metadata?: Record<string, unknown>;
  currentContent?: string;
  artifacts?: Record<string, string>;
  signal?: AbortSignal;
  llmInitialMessages?: LlmMessage[];
  llmSystemContext?: string;
};

export type AgentRuntimeResult = {
  context: RuntimeContext;
  response: RuntimeResponse;
};

function emptyRetrieval(contract: MemoryContract): MemoryRetrievalResult {
  return { contract, session: [], facts: [], entries: [] };
}

function defaultMemoryBudget(contract: MemoryContract): TokenBudget {
  return {
    maxChars: contract.constraints.maxChars,
    maxFacts: contract.constraints.allowPersonalFacts ? undefined : 0,
    maxEntries: contract.constraints.allowEntries ? undefined : 0,
    maxSessionItems: contract.constraints.allowSessionHistory ? undefined : 0,
  };
}

function formatMemoryDecision(contract: MemoryContract | null): string {
  if (!contract) return "";
  return [
    "<memory_decision>",
    `subject: ${contract.subjectBoundary}`,
    `need_memory: ${contract.needMemory}`,
    `target: ${contract.memoryTarget}`,
    `scopes: ${contract.targetScopes.join(",") || "none"}`,
    `allow_personal_facts: ${contract.constraints.allowPersonalFacts}`,
    `allow_session_history: ${contract.constraints.allowSessionHistory}`,
    `allow_entries: ${contract.constraints.allowEntries}`,
    `query: ${contract.query.rewritten || contract.query.raw}`,
    `reasons: ${contract.reasons.join(",") || "none"}`,
    "</memory_decision>",
  ].join("\n");
}

function formatStepMemoryDecisions(decisions: StepMemoryDecision[]): string {
  if (decisions.length === 0) return "";
  return [
    "<step_memory_decisions>",
    ...decisions.map((decision) =>
      [
        `step: ${decision.stepId}`,
        `type: ${decision.stepType}`,
        `need_memory: ${decision.needMemory}`,
        `target: ${decision.memoryTarget}`,
        `scopes: ${decision.targetScopes.join(",") || "none"}`,
        `query: ${decision.query}`,
        `allow_personal_facts: ${decision.constraints.allowPersonalFacts}`,
        `allow_session_history: ${decision.constraints.allowSessionHistory}`,
        `allow_entries: ${decision.constraints.allowEntries}`,
        `reasons: ${decision.reasons.join(",") || "none"}`,
      ].join("; "),
    ),
    "</step_memory_decisions>",
  ].join("\n");
}

function formatSkills(skills: RuntimeSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "<runtime_skills>",
    ...skills.map((skill) =>
      [
        `name: ${skill.name}`,
        skill.description ? `description: ${skill.description}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    ),
    "</runtime_skills>",
  ].join("\n");
}

function compactArtifactContent(content: string, max = 4000): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function formatTaskGraphArtifacts(context: RuntimeContext): string {
  const artifacts = context.taskGraphExecution?.execution.artifacts ?? [];
  if (artifacts.length === 0) return "";
  return [
    "<runtime_task_artifacts>",
    ...artifacts.map((artifact) =>
      [
        `id: ${artifact.id}`,
        `node: ${artifact.nodeId}`,
        `type: ${artifact.type}`,
        artifact.path ? `path: ${artifact.path}` : "",
        artifact.taskId ? `task_id: ${artifact.taskId}` : "",
        artifact.content
          ? `content: ${compactArtifactContent(artifact.content)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "</runtime_task_artifacts>",
  ].join("\n");
}

function hasCompletedTaskGraphMemoryRecall(context: RuntimeContext): boolean {
  const execution = context.taskGraphExecution?.execution;
  if (!execution) return false;
  const succeededRecallNodeIds = new Set(
    execution.nodes
      .filter(
        (state) => state.node.kind === "recall" && state.status === "succeeded",
      )
      .map((state) => state.node.id),
  );
  if (succeededRecallNodeIds.size === 0) return false;
  return execution.artifacts.some(
    (artifact) =>
      artifact.type === "memory" && succeededRecallNodeIds.has(artifact.nodeId),
  );
}

function hasTaskGraphRecallNode(context: RuntimeContext): boolean {
  return (
    context.taskGraph?.nodes.some((node) => node.kind === "recall") === true
  );
}

function formatTaskGraphToolPolicy(context: RuntimeContext): string {
  if (!hasTaskGraphRecallNode(context)) return "";
  const completed = hasCompletedTaskGraphMemoryRecall(context);
  return [
    "<runtime_tool_policy>",
    "recall_memory: disabled_for_this_turn",
    `reason: ${completed ? "task_graph_memory_recall_completed" : "task_graph_owns_memory_recall"}`,
    completed
      ? "Use the memory artifacts in runtime_task_artifacts. Do not request another memory recall unless the user asks for a new recall scope."
      : "Honor the TaskGraph execution contract. Do not request memory recall outside the planned recall step.",
    "</runtime_tool_policy>",
  ].join("\n");
}

function withSuppressedTool(
  options: ToolLoopRuntimeOptions,
  toolName: string,
  reason: string,
): ToolLoopRuntimeOptions {
  return {
    ...options,
    tools: options.tools?.filter((tool) => tool.name !== toolName),
    toolExecutor: {
      executeTools: async (requests, signal) => {
        const allowed = requests.filter((request) => request.name !== toolName);
        const allowedResults =
          allowed.length > 0
            ? await options.toolExecutor.executeTools(allowed, signal)
            : [];
        const allowedByCallId = new Map(
          allowedResults.map((result) => [result.callId, result]),
        );
        return requests.map((request) => {
          if (request.name !== toolName) {
            return (
              allowedByCallId.get(request.callId) ?? {
                name: request.name,
                callId: request.callId,
                status: "failed" as const,
                output: {
                  ok: false,
                  error: "tool result missing after suppression filter",
                },
              }
            );
          }
          return {
            name: request.name,
            callId: request.callId,
            status: "failed" as const,
            output: { ok: false, error: reason },
          };
        });
      },
    },
  };
}

export class DefaultResponseComposer implements ResponseComposer {
  async compose({ context }: ResponseComposerInput): Promise<RuntimeResponse> {
    const memoryDecision = formatMemoryDecision(context.memoryContract);
    const stepMemory = formatStepMemoryDecisions(context.stepMemoryDecisions);
    const skills = formatSkills(context.skills);
    const memoryText = context.memoryInjection?.text ?? "";
    const taskArtifacts = formatTaskGraphArtifacts(context);
    const taskToolPolicy = formatTaskGraphToolPolicy(context);
    const taskGraphInstruction =
      context.taskGraphExecution?.execution.finalResponseContract.instruction ??
      "";
    const executionInstruction =
      taskGraphInstruction ||
      (context.execution?.finalResponseContract.instruction ?? "");
    const canClaimSuccess =
      context.taskGraphExecution?.execution.finalResponseContract
        .canClaimSuccess ??
      context.execution?.finalResponseContract.canClaimSuccess ??
      true;
    const instructions = [
      context.memoryContract?.subjectBoundary === "external"
        ? "Treat this as an external request. Do not use or infer personal memory unless explicitly provided by runtime context."
        : "",
      executionInstruction,
    ].filter(Boolean);
    const systemContext = [
      memoryDecision,
      stepMemory,
      skills,
      memoryText,
      taskArtifacts,
      taskToolPolicy,
      executionInstruction
        ? `<execution_contract>\n${executionInstruction}\n</execution_contract>`
        : "",
    ]
      .filter((part) => part.trim())
      .join("\n\n");

    return {
      text: "",
      systemContext,
      instructions,
      canClaimSuccess,
      metadata: {
        memoryChars: memoryText.length,
        skills: context.skills.map((skill) => skill.name),
        taskGraphStatus:
          context.taskGraphExecution?.status ??
          (context.taskGraph ? "planned" : "not_required"),
        executionStatus: context.execution?.status ?? "not_required",
      },
    };
  }
}

export class NoopSkillRuntime implements SkillRuntime {
  async retrieve(): Promise<RuntimeSkill[]> {
    return [];
  }
}

export class AgentRuntime {
  private readonly responseComposer: ResponseComposer;
  private readonly skillRuntime: SkillRuntime;
  private readonly executionMode: AgentRuntimeExecutionMode;

  constructor(
    private readonly intentRuntime: IntentRuntime,
    private readonly memoryRuntime: MemoryRuntime<IntentFrame>,
    private readonly executor?: IntentExecutor,
    options: AgentRuntimeOptions & {
      skillRuntime?: SkillRuntime;
      responseComposer?: ResponseComposer;
      stepMemoryPlanner?: StepMemoryPlanner;
    } = {},
  ) {
    this.skillRuntime = options.skillRuntime ?? new NoopSkillRuntime();
    this.responseComposer =
      options.responseComposer ?? new DefaultResponseComposer();
    this.executionMode =
      options.executionMode ?? (this.executor ? "execute" : "skip");
    this.options = options;
  }

  private readonly options: AgentRuntimeOptions & {
    stepMemoryPlanner?: StepMemoryPlanner;
  };

  async handleTurn(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const context: RuntimeContext = {
      sessionId: input.sessionId,
      userPrompt: input.userPrompt,
      history: input.history ?? [],
      currentContent: input.currentContent,
      artifacts: input.artifacts,
      now: input.now ?? new Date(),
      executionContext: input.executionContext ?? "interactive",
      interactiveChannel: input.interactiveChannel ?? true,
      metadata: input.metadata ?? {},
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
    };

    await this.emit({
      type: "turn_started",
      sessionId: context.sessionId,
      promptLength: context.userPrompt.length,
      historyTurns: context.history.length,
    });

    try {
      const intentResult = await this.intentRuntime.understand({
        userPrompt: context.userPrompt,
        history: context.history,
        now: context.now,
        executionContext: context.executionContext,
        interactiveChannel: context.interactiveChannel,
        metadata: context.metadata,
      });
      context.intentResult = intentResult;
      context.intent = intentResult.intent;
      await this.emit({ type: "intent_completed", result: intentResult });

      const memoryContract = await this.memoryRuntime.planMemory({
        prompt: context.userPrompt,
        history: context.history,
        intent: intentResult.intent,
      });
      context.memoryContract = memoryContract;
      context.stepMemoryDecisions = await this.planStepMemory(
        context,
        memoryContract,
        intentResult.intent,
      );
      const deferMemoryRetrieval =
        this.options.deferMemoryRetrievalForTaskGraph === true &&
        Boolean(this.options.taskRuntime) &&
        (this.options.taskRuntime?.mode ?? "skip") === "execute";
      const retrieval =
        memoryContract.needMemory && !deferMemoryRetrieval
          ? await this.memoryRuntime.retrieve(memoryContract)
          : emptyRetrieval(memoryContract);
      context.memoryRetrieval = retrieval;
      context.memoryInjection = await this.memoryRuntime.inject({
        prompt: context.userPrompt,
        intent: intentResult.intent,
        contract: memoryContract,
        retrieval,
        budget:
          this.options.memoryBudget ?? defaultMemoryBudget(memoryContract),
      });
      await this.emit({ type: "memory_completed", contract: memoryContract });

      context.skills = await this.skillRuntime.retrieve({
        context,
        limit: this.options.skillLimit,
        maxDistance: this.options.skillMaxDistance,
      });
      await this.emit({ type: "skills_completed", skills: context.skills });

      if (
        this.options.taskRuntime &&
        (this.options.taskRuntime.mode ?? "skip") !== "skip"
      ) {
        const taskRuntimeInput: TaskRuntimePlanInput = {
          context,
          intent: intentResult.intent,
          memoryContract,
          stepMemoryDecisions: context.stepMemoryDecisions,
          skills: context.skills,
        };
        context.taskGraph =
          await this.options.taskRuntime.plan(taskRuntimeInput);
        await this.emit({
          type: "task_graph_planned",
          graph: context.taskGraph,
        });
        if (
          context.taskGraph &&
          (this.options.taskRuntime.mode ?? "skip") === "execute"
        ) {
          const executeInput: TaskRuntimeExecuteInput = {
            ...taskRuntimeInput,
            graph: context.taskGraph,
            signal: input.signal,
          };
          const shouldExecute =
            (await this.options.taskRuntime.shouldExecute?.(executeInput)) ??
            true;
          context.taskGraphExecution = shouldExecute
            ? await this.options.taskRuntime.execute(executeInput)
            : null;
          await this.emit({
            type: "task_graph_completed",
            result: context.taskGraphExecution,
          });
        }
      }

      if (this.executionMode === "execute" && this.executor) {
        const executorContext: IntentExecutorContext = {
          userPrompt: context.userPrompt,
          currentContent: input.currentContent,
          artifacts: input.artifacts,
          metadata: {
            ...context.metadata,
            memoryContract,
            stepMemoryDecisions: context.stepMemoryDecisions,
            memoryInjection: context.memoryInjection,
            skills: context.skills,
          },
        };
        context.execution = await this.executor.execute({
          intent: intentResult.intent,
          plan: intentResult.executionPlan,
          context: executorContext,
          signal: input.signal,
        });
      }
      await this.emit({
        type: "execution_completed",
        result: context.execution,
      });

      context.response = await this.responseComposer.compose({ context });
      if (this.options.llmLoop && input.llmInitialMessages) {
        const shouldSuppressRecallMemoryTool =
          deferMemoryRetrieval && hasTaskGraphRecallNode(context);
        const llmLoopOptions = shouldSuppressRecallMemoryTool
          ? withSuppressedTool(
              this.options.llmLoop,
              "recall_memory",
              "TaskGraph owns memory recall for this turn.",
            )
          : this.options.llmLoop;
        context.llmLoop = await new ToolLoopRuntime(llmLoopOptions).run({
          userPrompt: context.userPrompt,
          systemContext:
            input.llmSystemContext ?? context.response.systemContext,
          initialMessages: input.llmInitialMessages,
          metadata: context.metadata,
          signal: input.signal ?? new AbortController().signal,
        });
      }
      await this.emit({
        type: "response_composed",
        response: context.response,
      });
      await this.emit({ type: "turn_completed", context });
      return { context, response: context.response };
    } catch (error: any) {
      await this.emit({
        type: "turn_failed",
        error: error?.message ?? String(error),
        context,
      });
      throw error;
    }
  }

  private async planStepMemory(
    context: RuntimeContext,
    contract: MemoryContract,
    intent: IntentFrame,
  ): Promise<StepMemoryDecision[]> {
    if (this.options.stepMemoryPlanner) {
      return this.options.stepMemoryPlanner({ context, contract, intent });
    }
    return intent.intentSteps.map((step) => ({
      stepId: step.id,
      stepType: step.type,
      target: step.target,
      needMemory: contract.needMemory && step.type !== "analyze",
      targetScopes: contract.targetScopes,
      memoryTarget: contract.memoryTarget,
      query: contract.query.rewritten || contract.query.raw,
      constraints: {
        allowPersonalFacts: contract.constraints.allowPersonalFacts,
        allowSessionHistory: contract.constraints.allowSessionHistory,
        allowEntries: contract.constraints.allowEntries,
      },
      reasons: ["inherited_from_memory_contract"],
    }));
  }

  private async emit(event: AgentRuntimeEvent): Promise<void> {
    await this.options.observer?.(event);
  }
}
