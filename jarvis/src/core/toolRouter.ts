/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ClarificationQuestion,
  MemoryContract,
} from "../memory-runtime/index.js";
import type { StepMemoryDecision } from "../memory-runtime/types.js";
import {
  JarvisSafetyPolicyEngine,
  type SafetyPolicyEngine,
} from "./safetyPolicyEngine.js";
import type {
  RuntimeToolRequest,
  RuntimeToolResult,
  ToolExecutorAdapter,
  FunctionResponseLike,
} from "../intent-runtime/index.js";
import { getCategoryBaseScore, clampScore } from "./backgroundDistiller.js";
import { WorkspaceTools } from "./workspaceTools.js";
import { formatActivatedSkill, type SkillRuntime } from "./skillRuntime.js";

export type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  callId: string;
  metadata?: Record<string, unknown>;
};

export type ToolCallResponse = {
  name: string;
  status: string;
  output: unknown;
  callId: string;
};

export type MemoryServiceHandle = {
  saveFactToRuntime: (
    category: string,
    content: string,
    importance: number,
    source?: string,
  ) => Promise<unknown>;
  search: (
    query: string,
    limit: number,
    timeWindowDays?: number | null,
    dateRange?: { from: number; to: number } | null,
    maxDistanceOverride?: number,
  ) => Promise<string[]>;
  searchFacts: (
    query: string,
  ) => Promise<Array<{ category: string; content: string }>>;
};

export type DynamicRegistryHandle = {
  runSkill: (name: string, args: Record<string, unknown>) => Promise<string>;
};

export type SchedulerHandle = {
  schedule: (
    requests: ToolCallRequest[],
    signal: AbortSignal,
  ) => Promise<CompletedToolCall[]>;
};

type CompletedToolCall = {
  request: { name: string; callId: string };
  status: string;
  response: { responseParts?: FunctionResponseLike[]; resultDisplay?: unknown };
};

type ClientHandle = {
  getChat: () => {
    getModel: () => string;
    recordCompletedToolCalls: (
      model: string,
      calls: CompletedToolCall[],
    ) => void;
  };
  getCurrentSequenceModel: () => string | null;
  config: { api?: { apiVersion?: string } };
};

export function createStandaloneSchedulerHandle(): SchedulerHandle {
  return {
    async schedule(requests) {
      return requests.map((request) => ({
        request,
        status: "failed",
        response: {
          responseParts: [
            {
              functionResponse: {
                id: request.callId,
                name: request.name,
                response: {
                  error:
                    "Tool is not available in standalone runtime. Use Jarvis-native tools or register a runtime tool adapter.",
                },
              },
            },
          ],
          resultDisplay:
            "Tool is not available in standalone runtime. Use Jarvis-native tools or register a runtime tool adapter.",
        },
      }));
    },
  };
}

export function createStandaloneClientHandle(): ClientHandle {
  return {
    getChat: () => ({
      getModel: () => "standalone",
      recordCompletedToolCalls: () => {},
    }),
    getCurrentSequenceModel: () => null,
    config: { api: { apiVersion: "runtime" } },
  };
}

export type ToolInteractionRecorder = {
  record(config: unknown, completedCalls: unknown[]): Promise<void>;
};

const JARVIS_NATIVE_TOOLS = new Set([
  "save_memory",
  "recall_memory",
  "activate_skill",
  "ask_user",
  "push_to_channel",
  "read_file",
  "write_file",
  "read_many_files",
  "glob",
  "grep",
  "run_shell_command",
]);

// Prefix-style commands: anchored to start of string to avoid matching
// mid-sentence occurrences like "I remember: we used TypeScript before"
const REMEMBER_PREFIX_PATTERNS = [
  /^remember\b\s*[:：\-–—]/i, // Remember: / remember - / remember – etc.
  /^记住\b/,
  /^记下来\b/,
];

// In-sentence explicit requests
const REMEMBER_INTENT_PATTERNS = [
  /记住(这个|一下|这点)?/,
  /你记一下/,
  /别忘了/,
  /remember (this|that|me|it)/i,
  /please remember/i,
  /make a note/i,
  /don't forget/i,
];

const RECALL_QUERY_STOPWORDS = new Set([
  "还",
  "记得",
  "之前",
  "以前",
  "过去",
  "讨论",
  "聊",
  "聊过",
  "相关",
  "关于",
  "我们",
  "的",
  "吗",
  "么",
  "有",
  "没有",
  "what",
  "did",
  "we",
  "discuss",
  "talk",
  "about",
  "before",
  "previously",
  "earlier",
  "remember",
  "related",
]);

function normalizePushChannel(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "wechat" ||
    normalized === "微信" ||
    normalized === "weixin"
  ) {
    return "wechat";
  }
  if (
    normalized === "feishu" ||
    normalized === "飞书" ||
    normalized === "lark"
  ) {
    return "feishu";
  }
  return "";
}

function derivePushChannelFromPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (
    lower.includes("wechat") ||
    lower.includes("weixin") ||
    prompt.includes("微信")
  ) {
    return "wechat";
  }
  if (
    lower.includes("feishu") ||
    lower.includes("lark") ||
    prompt.includes("飞书")
  ) {
    return "feishu";
  }
  return "";
}

function decodeShellEchoPayload(payload: string): string {
  return payload
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function extractEchoContent(command: string): string {
  const trimmed = command.trim();
  const quoted = trimmed.match(
    /^echo\s+(["'])([\s\S]*)\1\s*(?:\|\s*pbcopy\s*)?$/i,
  );
  if (quoted) return decodeShellEchoPayload(quoted[2]).trim();

  const unquoted = trimmed.match(/^echo\s+([\s\S]+?)(?:\s*\|\s*pbcopy\s*)?$/i);
  return unquoted ? decodeShellEchoPayload(unquoted[1]).trim() : "";
}

function isShellPushWorkaround(req: ToolCallRequest): boolean {
  if (req.name !== "run_shell_command") return false;
  const command =
    typeof req.args.command === "string" ? req.args.command.toLowerCase() : "";
  const description =
    typeof req.args.description === "string"
      ? req.args.description.toLowerCase()
      : "";

  return (
    command.includes("pbcopy") ||
    description.includes("clipboard") ||
    description.includes("copy") ||
    description.includes("剪贴板") ||
    description.includes("粘贴") ||
    description.includes("手动")
  );
}

function buildPushRequestFromShellWorkarounds(
  requests: ToolCallRequest[],
  currentUserPrompt: string,
): ToolCallRequest | null {
  const channel = derivePushChannelFromPrompt(currentUserPrompt);
  if (!channel) return null;

  for (const req of requests) {
    if (!isShellPushWorkaround(req)) continue;
    const command =
      typeof req.args.command === "string" ? req.args.command : "";
    const content = extractEchoContent(command);
    if (!content) continue;
    return {
      name: "push_to_channel",
      callId: `${req.callId}-push_to_channel`,
      args: {
        channel,
        content,
        chat_id: "",
      },
    };
  }

  return null;
}

const SCHEDULE_TIME_PATTERNS = [
  /(?:北京时间\s*)?(?:每\s*)?(?:周|星期)[一二三四五六日天](?:\s*(?:早上|上午|中午|下午|晚上|傍晚|夜间|凌晨))?\s*\d{1,2}(?::\d{2})?\s*[点时]?/i,
  /(?:北京时间\s*)?(?:每天|每日|每\s*天|每\s*日)(?:\s*(?:早上|上午|中午|下午|晚上|傍晚|夜间|凌晨))?\s*\d{1,2}(?::\d{2})?\s*[点时]?/i,
  /(?:今天|明天|后天|今晚|下周[一二三四五六日天]?|本周[一二三四五六日天]?)(?:\s*(?:早上|上午|中午|下午|晚上|傍晚|夜间|凌晨))?\s*\d{1,2}(?::\d{2})?\s*[点时]?/i,
  /\b(?:every\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  /\b(?:daily|every day|weekdays)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  /\b\d{1,2}:\d{2}\b/,
  /\b(?:\d+|\*)\s+(?:\d+|\*)\s+(?:\d+|\*)\s+(?:\d+|\*)\s+(?:[\d*,-]+)\b/,
];

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[\s,，:：;；。]+|[\s,，:：;；。]+$/g, "")
    .trim();
}

function extractScheduleTimeText(text: string): string {
  for (const pattern of SCHEDULE_TIME_PATTERNS) {
    const match = text.match(pattern);
    const value = normalizeText(match?.[0] ?? "");
    if (value) return value;
  }
  return "";
}

function stripScheduleWrapper(text: string, cronText: string): string {
  let result = normalizeText(text);
  result = result
    .replace(
      /^(?:请|帮我|麻烦)?(?:添加|创建|新增|设置|建立)?(?:一个|一条)?(?:定时任务|定时|任务|提醒|schedule|scheduled task)\s*[:：,，-]*/i,
      "",
    )
    .replace(/^(?:北京时间|当地时间)\s*[:：,，-]*/i, "")
    .replace(/^(?:并且|然后|再|同时)\s*/i, "");
  for (const variant of [
    cronText,
    cronText.replace(/^(?:北京时间|当地时间)\s*/i, ""),
  ]) {
    const normalized = normalizeText(variant);
    if (normalized) result = normalizeText(result.replace(normalized, " "));
  }
  return normalizeText(result.replace(/^(?:并且|然后|再|同时)\s*/i, ""));
}

function isShellScheduleWorkaround(req: ToolCallRequest): boolean {
  if (req.name !== "run_shell_command") return false;
  const command =
    typeof req.args.command === "string" ? req.args.command.toLowerCase() : "";
  const description =
    typeof req.args.description === "string"
      ? req.args.description.toLowerCase()
      : "";
  return /crontab|launchctl|\.plist|cron\s+job|scheduled?\s+task|定时任务|系统定时|计划任务/.test(
    `${command} ${description}`,
  );
}

function buildTaskAddRequestFromShellScheduleWorkarounds(
  requests: ToolCallRequest[],
  currentUserPrompt: string,
): ToolCallRequest | null {
  const shellRequest = requests.find(isShellScheduleWorkaround);
  if (!shellRequest) return null;

  const cronText = extractScheduleTimeText(currentUserPrompt);
  const prompt = stripScheduleWrapper(currentUserPrompt, cronText);
  if (!cronText || !prompt) return null;

  return {
    name: "task_add",
    callId: `${shellRequest.callId}-task_add`,
    args: {
      cron: cronText,
      prompt,
    },
  };
}

/** Returns 9 if the text contains an explicit "remember" intent, 6 otherwise. */
function computeRememberIntentScore(text?: string): number {
  if (!text) return 6;
  const normalized = text.trim();
  if (REMEMBER_PREFIX_PATTERNS.some((p) => p.test(normalized))) return 9;
  if (REMEMBER_INTENT_PATTERNS.some((p) => p.test(normalized))) return 9;
  return 6;
}

function deriveRecallQuery(userPrompt: string): string {
  const normalized = userPrompt
    .replace(/[？?！!。.,，；;:：()[\]{}"'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const rawTokens =
    normalized.match(/[\p{Script=Han}]+|[A-Za-z0-9][A-Za-z0-9_-]*/gu) ?? [];
  const tokens: string[] = [];

  for (const rawToken of rawTokens) {
    const lower = rawToken.toLowerCase();
    if (RECALL_QUERY_STOPWORDS.has(lower)) continue;

    if (/^\p{Script=Han}+$/u.test(rawToken)) {
      let token = rawToken;
      for (const stopword of RECALL_QUERY_STOPWORDS) {
        token = token.replaceAll(stopword, "");
      }
      if (token.length >= 2) tokens.push(token);
    } else if (lower.length >= 2) {
      tokens.push(lower);
    }
  }

  return tokens.join(" ").trim() || normalized;
}

/**
 * Computes importance for manually saved facts (save_memory tool).
 * Uses a two-factor formula: 0.7 * category + 0.3 * rememberIntent
 * This is intentionally simpler than the distiller's three-factor formula
 * because save_memory lacks the LLM content-analysis signal.
 */
function computeManualMemoryImportance(params: {
  category?: string;
  requestText?: string;
}): number {
  const categoryScore = getCategoryBaseScore(
    params.category ?? "interaction_style",
  );
  const rememberIntentScore = computeRememberIntentScore(params.requestText);
  const final = clampScore(0.7 * categoryScore + 0.3 * rememberIntentScore);
  console.error(
    `[importance/manual] category=${params.category} cat=${categoryScore} rememberIntent=${rememberIntentScore} final=${final}`,
  );
  return final;
}

function isNativeTool(name: string): boolean {
  return (
    name.startsWith("run_evolved_skill_") ||
    name.startsWith("task_") ||
    JARVIS_NATIVE_TOOLS.has(name)
  );
}

type ChannelRegistryHandle = {
  pushSafe: (channel: string, chatId: string, text: string) => Promise<boolean>;
};

export type AskUserQuestion = ClarificationQuestion;

/** Converts ask_user answers map into LLM-readable text. */
function buildAnswersText(
  questions: AskUserQuestion[],
  answers: Record<string, string>,
): string {
  const lines = ["User provided the following answers:"];
  questions.forEach((q, i) => {
    const key = `${i}_${q.header ?? q.question.slice(0, 20)}`;
    const val = answers[key] ?? answers[String(i)] ?? "(no answer)";
    lines.push(`  ${q.header ?? `Q${i + 1}`}: ${val}`);
  });
  lines.push("", "Please continue with the task using these answers.");
  return lines.join("\n");
}

/**
 * Converts an ask_user tool call into a structured prompt that lets the LLM
 * auto-select the recommended option and inform the user of all choices.
 */
function buildAskUserResponse(questions: AskUserQuestion[]): string {
  const parts: string[] = [
    "SYSTEM: ask_user tool is not available in server mode. Auto-selecting recommended options.",
    "",
  ];

  for (const q of questions) {
    parts.push(`Question: ${q.question}`);
    if (q.options && q.options.length > 0) {
      parts.push("Options:");
      q.options.forEach((opt, i) => {
        const isRecommended = opt.description
          ?.toLowerCase()
          .includes("recommended");
        const marker = isRecommended
          ? " ← AUTO-SELECTED (recommended default)"
          : "";
        parts.push(
          `  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}${marker}`,
        );
      });
    }
    parts.push("");
  }

  parts.push(
    "Instructions for your response:",
    "1. Proceed with the AUTO-SELECTED option(s) above.",
    "2. Inform the user of all available options and which one was auto-selected.",
    "3. Tell the user they can change the selection by replying naturally",
    '   (e.g. "use option 2" or "use the global location").',
  );

  return parts.join("\n");
}

function formatMemoryContractForSubagent(
  contract: MemoryContract | null,
  stepDecision?: StepMemoryDecision | null,
): string {
  if (!contract) {
    return [
      "<memory_decision>",
      "status: unavailable",
      "instruction: Do not assume personal memory was checked. Request explicit context if needed.",
      "</memory_decision>",
    ].join("\n");
  }

  return [
    "<memory_decision>",
    `subject: ${contract.subjectBoundary}`,
    `need_memory: ${contract.needMemory}`,
    `target: ${contract.memoryTarget}`,
    `scopes: ${contract.targetScopes.join(",") || "none"}`,
    `allow_personal_facts: ${contract.constraints.allowPersonalFacts}`,
    `allow_entries: ${contract.constraints.allowEntries}`,
    `allow_session_history: ${contract.constraints.allowSessionHistory}`,
    `query: ${contract.query.rewritten || contract.query.raw}`,
    `reasons: ${contract.reasons.join(",") || "none"}`,
    stepDecision
      ? [
          "step:",
          `  id: ${stepDecision.stepId}`,
          `  type: ${stepDecision.stepType}`,
          `  target: ${stepDecision.target || "none"}`,
          `  need_memory: ${stepDecision.needMemory}`,
          `  scopes: ${stepDecision.targetScopes.join(",") || "none"}`,
          `  query: ${stepDecision.query}`,
          `  reasons: ${stepDecision.reasons.join(",") || "none"}`,
        ].join("\n")
      : "step: unavailable",
    contract.subjectBoundary === "external"
      ? "instruction: Treat this as an external request. Do not use or infer personal memory."
      : "instruction: Use only the memory snippets explicitly provided below. Do not infer additional personal history.",
    "</memory_decision>",
  ].join("\n");
}

type TaskCommandHandlerHandle = {
  handleTool: (
    action: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
};

/**
 * Routes tool call requests to either Jarvis-native handlers or the active
 * scheduler adapter, then assembles the response parts for the next LLM turn.
 */
export class ToolRouter implements ToolExecutorAdapter {
  // Fallbacks from the current turn's routing classification.
  // Used when LLM calls recall_memory without time parameters.
  private currentTimeWindowDays: number | null = null;
  private currentDateRange: { from: number; to: number } | null = null;
  private currentUserPrompt: string = "";
  private currentMemoryContract: MemoryContract | null = null;
  private currentStepMemoryDecisions: StepMemoryDecision[] = [];
  private askUserHandler:
    | ((questions: AskUserQuestion[]) => Promise<Record<string, string>>)
    | null = null;

  /** Inject a WebSocket-backed ask_user handler. When set, ask_user waits for
   *  real user input instead of auto-selecting. Pass null to remove. */
  public setAskUserHandler(
    fn:
      | ((questions: AskUserQuestion[]) => Promise<Record<string, string>>)
      | null,
  ): void {
    this.askUserHandler = fn;
  }

  constructor(
    private memoryService: MemoryServiceHandle,
    private dynamicRegistry: DynamicRegistryHandle,
    private scheduler: SchedulerHandle,
    private client: ClientHandle,
    private taskCommandHandler?: TaskCommandHandlerHandle,
    private channelRegistry?: ChannelRegistryHandle,
    private toolInteractionRecorder?: ToolInteractionRecorder,
    private safetyPolicy: SafetyPolicyEngine = new JarvisSafetyPolicyEngine(),
    private workspaceTools?: WorkspaceTools,
    private skillRuntime?: SkillRuntime,
  ) {}

  public setTaskCommandHandler(handler?: TaskCommandHandlerHandle): void {
    this.taskCommandHandler = handler;
  }

  public setChannelRegistry(registry?: ChannelRegistryHandle): void {
    this.channelRegistry = registry;
  }

  /** Called by agent.ts each turn with the routing result's relative time window. */
  public setCurrentTimeWindow(days: number | null): void {
    this.currentTimeWindowDays = days;
  }

  /** Called by agent.ts each turn so recall_memory can fall back to it when LLM omits query. */
  public setCurrentUserPrompt(prompt: string): void {
    this.currentUserPrompt = prompt;
  }

  /** Called by agent.ts each turn after intent-aware memory planning. */
  public setCurrentMemoryContract(contract: MemoryContract | null): void {
    this.currentMemoryContract = contract;
  }

  public setCurrentStepMemoryDecisions(
    decisions: StepMemoryDecision[] | null,
  ): void {
    this.currentStepMemoryDecisions = decisions ?? [];
  }

  public buildPushToChannelRequestFromContent(
    content: string,
    callId = `jarvis-auto-push-${Date.now()}`,
  ): ToolCallRequest | null {
    const channel = derivePushChannelFromPrompt(this.currentUserPrompt);
    const trimmedContent = content.trim();
    if (!channel || !trimmedContent) return null;
    return {
      name: "push_to_channel",
      callId,
      args: {
        channel,
        content: trimmedContent,
        chat_id: "",
      },
    };
  }

  /**
   * Called by agent.ts each turn with the routing result's exact date range.
   * `resolved` is the pre-computed {from,to} ms object from extractDateRange()
   * (preferred). `dateFrom`/`dateTo` ISO strings are a fallback for cases where
   * only the LLM-returned strings are available.
   */
  public setCurrentDateRange(
    resolved: { from: number; to: number } | null,
    dateFrom?: string | null,
    dateTo?: string | null,
  ): void {
    if (resolved !== null) {
      this.currentDateRange = resolved;
    } else if (dateFrom && dateTo) {
      const [fy, fm, fd] = dateFrom.split("-").map(Number);
      const [ty, tm, td] = dateTo.split("-").map(Number);
      const from = new Date(fy, fm - 1, fd, 0, 0, 0, 0).getTime();
      const to = new Date(ty, tm - 1, td + 1, 0, 0, 0, 0).getTime();
      this.currentDateRange = { from, to };
    } else {
      this.currentDateRange = null;
    }
  }

  async route(
    requests: ToolCallRequest[],
    signal: AbortSignal,
    onToolResponse: (response: ToolCallResponse) => void,
  ): Promise<FunctionResponseLike[]> {
    const rewrittenPushRequest = buildPushRequestFromShellWorkarounds(
      requests,
      this.currentUserPrompt,
    );
    const rewrittenTaskAddRequest =
      buildTaskAddRequestFromShellScheduleWorkarounds(
        rewrittenPushRequest
          ? requests.filter((r) => !isShellPushWorkaround(r))
          : requests,
        this.currentUserPrompt,
      );
    const effectiveRequests = rewrittenTaskAddRequest
      ? [
          ...requests.filter(
            (r) => !isShellPushWorkaround(r) && !isShellScheduleWorkaround(r),
          ),
          rewrittenTaskAddRequest,
        ]
      : rewrittenPushRequest
        ? [
            ...requests.filter((r) => !isShellPushWorkaround(r)),
            rewrittenPushRequest,
          ]
        : requests;

    if (rewrittenPushRequest) {
      console.error(
        "📤 [Jarvis] Rewriting shell clipboard workaround to push_to_channel.",
      );
    }
    if (rewrittenTaskAddRequest) {
      console.error(
        "📅 [Jarvis] Rewriting shell/system schedule workaround to Jarvis task_add.",
      );
    }

    const nativeRequests = effectiveRequests.filter((r) =>
      isNativeTool(r.name),
    );
    const deniedNativeParts: FunctionResponseLike[] = [];
    const allowedNativeRequests: ToolCallRequest[] = [];
    for (const request of nativeRequests) {
      const decision = await this.safetyPolicy.checkToolCall(request, {
        memoryContract: this.currentMemoryContract,
        userPrompt: this.currentUserPrompt,
      });
      if (decision.allowed) {
        allowedNativeRequests.push(request);
        continue;
      }
      const output =
        decision.message ??
        `Tool call denied by safety policy: ${decision.reasonCode}`;
      onToolResponse({
        name: request.name,
        status: "denied",
        output,
        callId: request.callId,
      });
      deniedNativeParts.push({
        functionResponse: {
          id: request.callId,
          name: request.name,
          response: { error: output, reasonCode: decision.reasonCode },
        },
      });
    }
    // Standard tools and subagents consume the same MemoryContract as the main
    // response path. This prevents subagent-specific personal memory leakage.
    const standardRequests = await Promise.all(
      effectiveRequests
        .filter((r) => !isNativeTool(r.name))
        .map(async (r) => {
          if (
            (r.name === "generalist" || r.name === "codebase_investigator") &&
            typeof r.args.request === "string"
          ) {
            return this.withSubagentMemoryContract(r);
          }
          return r;
        }),
    );

    const [directParts, completedCalls] = await Promise.all([
      Promise.all(
        allowedNativeRequests.map((req) =>
          this.handleNative(req, onToolResponse),
        ),
      ),
      standardRequests.length > 0
        ? this.scheduler.schedule(standardRequests, signal)
        : Promise.resolve([]),
    ]);

    const standardParts: FunctionResponseLike[] = [];
    if (completedCalls.length > 0) {
      for (const completed of completedCalls) {
        if (completed.response.responseParts) {
          standardParts.push(...completed.response.responseParts);
        }
        onToolResponse({
          name: completed.request.name,
          status: completed.status,
          output: completed.response.resultDisplay,
          callId: completed.request.callId,
        });
      }
      try {
        const model =
          this.client.getCurrentSequenceModel() ??
          this.client.getChat().getModel();
        this.client.getChat().recordCompletedToolCalls(model, completedCalls);
        await this.toolInteractionRecorder?.record(
          this.client.config,
          completedCalls,
        );
      } catch (_e) {}
    }

    return [...deniedNativeParts, ...directParts, ...standardParts];
  }

  async executeTools(
    requests: RuntimeToolRequest[],
    signal: AbortSignal,
  ): Promise<RuntimeToolResult[]> {
    const results: RuntimeToolResult[] = [];
    await this.route(
      requests.map((request) => ({
        name: request.name,
        callId: request.callId,
        args: request.args,
        ...(request.metadata ? { metadata: request.metadata } : {}),
      })),
      signal,
      (response) => {
        results.push({
          name: response.name,
          callId: response.callId,
          status: response.status === "success" ? "success" : "failed",
          output: response.output,
        });
      },
    );
    return results;
  }

  private async withSubagentMemoryContract(
    request: ToolCallRequest,
  ): Promise<ToolCallRequest> {
    const query = request.args.request as string;
    const contract = this.currentMemoryContract;
    const stepDecision = this.pickStepMemoryDecision(request);
    const memoryDecision = formatMemoryContractForSubagent(
      contract,
      stepDecision,
    );
    const contextParts = [memoryDecision];

    if (
      contract &&
      contract.subjectBoundary !== "external" &&
      contract.needMemory
    ) {
      const lookupQuery =
        stepDecision?.query || contract.query.rewritten || query;
      const [facts, memories] = await Promise.all([
        (stepDecision?.constraints.allowPersonalFacts ??
        contract.constraints.allowPersonalFacts)
          ? this.memoryService.searchFacts(lookupQuery)
          : Promise.resolve([]),
        (stepDecision?.constraints.allowEntries ??
        contract.constraints.allowEntries)
          ? this.memoryService.search(
              lookupQuery,
              3,
              this.currentTimeWindowDays,
              this.currentDateRange,
            )
          : Promise.resolve([]),
      ]);

      if (facts.length > 0) {
        contextParts.push(
          "<jarvis_memory>\n" +
            facts.map((f) => `[${f.category}] ${f.content}`).join("\n") +
            "\n</jarvis_memory>",
        );
      }
      if (memories.length > 0) {
        contextParts.push(
          "<relevant_past_conversations>\n" +
            memories.map((m, i) => `[Memory ${i + 1}]: ${m}`).join("\n") +
            "\n</relevant_past_conversations>",
        );
      }
    } else {
      console.error(
        `🛡️ [ToolRouter] Subagent personal memory skipped by MemoryContract: subject=${contract?.subjectBoundary ?? "none"}, target=${contract?.memoryTarget ?? "none"}, reasons=${contract?.reasons.join(",") || "none"}`,
      );
    }

    return {
      ...request,
      args: {
        ...request.args,
        request: contextParts.join("\n") + "\n\nTask: " + query,
      },
    };
  }

  private pickStepMemoryDecision(
    request: ToolCallRequest,
  ): StepMemoryDecision | null {
    if (this.currentStepMemoryDecisions.length === 0) return null;
    const requestText = String(request.args.request ?? "").toLowerCase();
    return (
      this.currentStepMemoryDecisions
        .map((decision) => ({
          decision,
          score: [
            decision.target,
            decision.query,
            decision.stepType,
            decision.stepId,
          ].reduce((score, value) => {
            const text = String(value ?? "").toLowerCase();
            return text && requestText.includes(text)
              ? score + Math.min(text.length, 40)
              : score;
          }, 0),
        }))
        .sort((a, b) => b.score - a.score)[0]?.decision ?? null
    );
  }

  private async handleNative(
    req: ToolCallRequest,
    onToolResponse: (r: ToolCallResponse) => void,
  ): Promise<FunctionResponseLike> {
    try {
      let output = "";

      if (req.name.startsWith("run_evolved_skill_")) {
        output = await this.dynamicRegistry.runSkill(req.name, req.args);
      } else if (req.name === "save_memory") {
        // gemini-cli's MemoryManagerAgent uses "request"; older Jarvis tool used "fact"
        const fact = (req.args.fact || req.args.request) as string;
        const category = (req.args.category as string) || "interaction_style";
        // Two-factor formula: category stability + remember intent strength.
        // Does NOT use llm_score because save_memory lacks the content-analysis
        // signal that BackgroundDistiller has.
        //
        // For remember_intent detection, prefer the raw "request" field when
        // available — it contains the original user phrasing (e.g. "Remember
        // that I prefer tabs") which is more likely to contain explicit intent
        // keywords than the distilled "fact" content.
        const rawRequest = (req.args.request || req.args.fact) as
          | string
          | undefined;
        const importance = computeManualMemoryImportance({
          category,
          requestText: rawRequest,
        });
        await this.memoryService.saveFactToRuntime(
          category,
          fact,
          importance,
          "save_memory_tool",
        );
        output = `Integrated into structured core: ${fact}`;
        console.error(`🛡️ [Jarvis] Memory Redirected: ${fact}`);
      } else if (req.name === "recall_memory") {
        const memoryDenied =
          this.currentMemoryContract !== null &&
          (this.currentMemoryContract.subjectBoundary === "external" ||
            this.currentMemoryContract.needMemory === false ||
            !this.currentMemoryContract.targetScopes.includes("entry"));
        if (memoryDenied) {
          output =
            `PERSONAL MEMORY ACCESS DENIED by current MemoryContract. ` +
            `subject=${this.currentMemoryContract?.subjectBoundary ?? "unknown"}, ` +
            `target=${this.currentMemoryContract?.memoryTarget ?? "unknown"}, ` +
            `reasons=${this.currentMemoryContract?.reasons.join(",") || "none"}. ` +
            `Proceed without personal long-term memory.`;
          console.error(
            `🛡️ [Jarvis] recall_memory denied by MemoryContract: subject=${this.currentMemoryContract?.subjectBoundary}, target=${this.currentMemoryContract?.memoryTarget}, reasons=${this.currentMemoryContract?.reasons.join(",") || "none"}`,
          );
          onToolResponse({
            name: req.name,
            status: "success",
            output,
            callId: req.callId,
          });
          const responsePayload: unknown =
            this.client.config.api?.apiVersion === "v1"
              ? output
              : { result: output };
          return {
            functionResponse: {
              id: req.callId,
              name: req.name,
              response: responsePayload,
            },
          };
        }
        const query = (req.args.query as string)?.trim() || "";
        const limit = (req.args.limit as number) || 5;
        // Use LLM-provided time window, falling back to the routing-inferred
        // window so temporal queries get the correct scope even when LLM omits
        // the parameter (e.g. "昨天我们讨论了什么" → time_window=1 from router).
        const timeWindowDays =
          (req.args.time_window_days as number) ?? this.currentTimeWindowDays;

        // Parse absolute date range (overrides timeWindowDays when both present).
        // LLM passes ISO 8601 strings like "2026-04-27" or "2026-04-27T00:00:00".
        const dateFromArg = req.args.date_from as string | number | undefined;
        const dateToArg = req.args.date_to as string | number | undefined;
        let dateRange: { from: number; to: number } | null = null;
        if (dateFromArg != null && dateToArg != null) {
          const fromMs =
            typeof dateFromArg === "number"
              ? dateFromArg
              : new Date(dateFromArg).getTime();
          // For date-only strings (YYYY-MM-DD), use start-of-next-day as the
          // exclusive upper bound — matching dateRange.ts half-open interval
          // semantics so SQL can use `timestamp < to` without missing same-day records.
          const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
          let toMs: number;
          if (typeof dateToArg === "number") {
            toMs = dateToArg;
          } else if (DATE_ONLY_RE.test(dateToArg)) {
            const d = new Date(dateToArg);
            d.setDate(d.getDate() + 1); // advance to start of next day
            toMs = d.getTime();
          } else {
            toMs = new Date(dateToArg).getTime();
          }
          if (!isNaN(fromMs) && !isNaN(toMs)) {
            dateRange = { from: fromMs, to: toMs };
          }
        }

        // Fall back to router-inferred date range when LLM didn't provide one.
        if (dateRange === null && this.currentDateRange !== null) {
          dateRange = this.currentDateRange;
        }

        const effectiveQuery =
          query ||
          this.currentMemoryContract?.query.rewritten ||
          deriveRecallQuery(this.currentUserPrompt);
        if (!effectiveQuery) {
          // Neither LLM nor router provided a query — give actionable guidance.
          output =
            `recall_memory requires a non-empty query. ` +
            `Extract the TOPIC keywords from the user's question and retry. ` +
            `Example: if user asked "did we discuss Anthropic yesterday?", use query="Anthropic". ` +
            `If user asked "what did we talk about recently?", use query="recent discussion".`;
          console.error(
            `⚠️ [Jarvis] recall_memory called with empty query and no user prompt fallback.`,
          );
        } else {
          const twSource =
            dateRange !== null
              ? req.args.date_from != null
                ? "date-range/llm"
                : "date-range/router-fallback"
              : req.args.time_window_days != null
                ? "llm"
                : this.currentTimeWindowDays != null
                  ? "router-fallback"
                  : "all-time";
          const windowLabel =
            dateRange !== null
              ? `${new Date(dateRange.from).toISOString().slice(0, 10)}~${new Date(dateRange.to).toISOString().slice(0, 10)}`
              : (timeWindowDays ?? "all-time");
          if (!query) {
            console.error(
              `⚠️ [Jarvis] recall_memory: empty query — derived query "${effectiveQuery.slice(0, 80)}" from user prompt.`,
            );
          }
          console.error(
            `🧠 [Jarvis] Active Recall initiated for: "${effectiveQuery}" (TimeWindow: ${windowLabel}, source=${twSource})`,
          );
          const memories = await this.memoryService.search(
            effectiveQuery,
            limit,
            timeWindowDays,
            dateRange,
          );
          output =
            memories.length > 0
              ? `LONG-TERM MEMORIES FOUND:\n${memories.map((m) => `- ${m}`).join("\n")}\n\nINSTRUCTION: Now synthesize this history into your final answer.`
              : `NO SPECIFIC MEMORIES FOUND for "${effectiveQuery}". Proceed with current knowledge.`;
        }
      } else if (req.name === "activate_skill") {
        if (!this.skillRuntime) {
          throw new Error("Jarvis-native skill runtime is not configured.");
        } else {
          const name = String(req.args.name ?? "").trim();
          const skill = await this.skillRuntime.activateSkill(name);
          output = formatActivatedSkill(skill);
          console.error(`📚 [Jarvis] Skill activated: ${skill.name}`);
        }
      } else if (req.name.startsWith("task_")) {
        const action = req.name.slice("task_".length);
        if (this.taskCommandHandler) {
          console.error(`📅 [Jarvis] Task tool invoked: ${req.name}`);
          output = await this.taskCommandHandler.handleTool(action, req.args);
        } else {
          output =
            "❌ Task management not available (TaskCommandHandler not initialized).";
        }
      } else if (req.name === "ask_user") {
        const questions = (req.args.questions ?? []) as AskUserQuestion[];
        if (this.askUserHandler) {
          console.error(
            `❓ [Jarvis] ask_user — awaiting user input via handler.`,
          );
          try {
            const answers = await this.askUserHandler(questions);
            output = buildAnswersText(questions, answers);
          } catch (e: any) {
            output = JSON.stringify({
              cancelled: true,
              reason: e?.message ?? "user did not respond",
            });
          }
        } else {
          console.error(
            `❓ [Jarvis] ask_user intercepted — auto-selecting recommended options.`,
          );
          output = buildAskUserResponse(questions);
        }
      } else if (req.name === "push_to_channel") {
        const requestedChannel = normalizePushChannel(req.args.channel);
        const fallbackChannel = derivePushChannelFromPrompt(
          this.currentUserPrompt,
        );
        const channel = requestedChannel || fallbackChannel;
        const content = req.args.content as string;
        const chatId = (req.args.chat_id as string) || "";
        if (!channel) {
          output =
            '❌ push_to_channel requires a target channel. Supported values: "wechat" or "feishu".';
        } else if (this.channelRegistry) {
          if (!requestedChannel && fallbackChannel) {
            console.error(
              `📤 [Jarvis] push_to_channel missing channel arg — derived "${fallbackChannel}" from user prompt.`,
            );
          }
          console.error(`📤 [Jarvis] Pushing to ${channel}...`);
          const pushed = await this.channelRegistry.pushSafe(
            channel,
            chatId,
            content,
          );
          output = pushed
            ? `✅ Message pushed to ${channel} successfully.`
            : `❌ Failed to push to ${channel}. Check that the channel is enabled and you are logged in.`;
        } else {
          output = "❌ Push not available (ChannelRegistry not initialized).";
        }
      } else if (this.workspaceTools?.canHandle(req.name)) {
        const result = await this.workspaceTools.execute(req);
        output = JSON.stringify(result);
      }

      onToolResponse({
        name: req.name,
        status: "success",
        output,
        callId: req.callId,
      });

      const responsePayload: unknown =
        this.client.config.api?.apiVersion === "v1"
          ? output
          : { result: output };

      return {
        functionResponse: {
          id: req.callId,
          name: req.name,
          response: responsePayload,
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        functionResponse: {
          id: req.callId,
          name: req.name,
          response: { error: msg },
        },
      };
    }
  }
}
