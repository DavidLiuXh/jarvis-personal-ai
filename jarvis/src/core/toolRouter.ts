/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  recordToolCallInteractions,
  type Part,
} from "../../../gemini-cli/packages/core/src/index.js";
import type {
  ClarificationQuestion,
  MemoryContract,
} from "../memory-runtime/index.js";
import { getCategoryBaseScore, clampScore } from "./backgroundDistiller.js";

export type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  callId: string;
};

export type ToolCallResponse = {
  name: string;
  status: string;
  output: unknown;
  callId: string;
};

export type MemoryServiceHandle = {
  saveFact: (
    category: string,
    content: string,
    importance: number,
  ) => Promise<void>;
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
  response: { responseParts?: Part[]; resultDisplay?: unknown };
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

const JARVIS_NATIVE_TOOLS = new Set([
  "save_memory",
  "recall_memory",
  "ask_user",
  "push_to_channel",
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
 * Routes tool call requests to either Jarvis-native handlers or the Gemini
 * Scheduler, then assembles the response parts for the next LLM turn.
 */
export class ToolRouter {
  // Fallbacks from the current turn's routing classification.
  // Used when LLM calls recall_memory without time parameters.
  private currentTimeWindowDays: number | null = null;
  private currentDateRange: { from: number; to: number } | null = null;
  private currentUserPrompt: string = "";
  private currentMemoryContract: MemoryContract | null = null;
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
  ) {}

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
  ): Promise<Part[]> {
    const nativeRequests = requests.filter((r) => isNativeTool(r.name));
    // Standard tools and subagents consume the same MemoryContract as the main
    // response path. This prevents subagent-specific personal memory leakage.
    const standardRequests = await Promise.all(
      requests
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
        nativeRequests.map((req) => this.handleNative(req, onToolResponse)),
      ),
      standardRequests.length > 0
        ? this.scheduler.schedule(standardRequests, signal)
        : Promise.resolve([]),
    ]);

    const standardParts: Part[] = [];
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
        await recordToolCallInteractions(
          this.client.config as Parameters<
            typeof recordToolCallInteractions
          >[0],
          completedCalls as Parameters<typeof recordToolCallInteractions>[1],
        );
      } catch (_e) {}
    }

    return [...directParts, ...standardParts];
  }

  private async withSubagentMemoryContract(
    request: ToolCallRequest,
  ): Promise<ToolCallRequest> {
    const query = request.args.request as string;
    const contract = this.currentMemoryContract;
    const memoryDecision = formatMemoryContractForSubagent(contract);
    const contextParts = [memoryDecision];

    if (
      contract &&
      contract.subjectBoundary !== "external" &&
      contract.needMemory
    ) {
      const lookupQuery = contract.query.rewritten || query;
      const [facts, memories] = await Promise.all([
        contract.constraints.allowPersonalFacts
          ? this.memoryService.searchFacts(lookupQuery)
          : Promise.resolve([]),
        contract.constraints.allowEntries
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

  private async handleNative(
    req: ToolCallRequest,
    onToolResponse: (r: ToolCallResponse) => void,
  ): Promise<Part> {
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
        await this.memoryService.saveFact(category, fact, importance);
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
            functionResponse: { name: req.name, response: responsePayload },
          } as Part;
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
        const channel = req.args.channel as string;
        const content = req.args.content as string;
        const chatId = (req.args.chat_id as string) || "";
        if (this.channelRegistry) {
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
        functionResponse: { name: req.name, response: responsePayload },
      } as Part;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        functionResponse: { name: req.name, response: { error: msg } },
      } as Part;
    }
  }
}
