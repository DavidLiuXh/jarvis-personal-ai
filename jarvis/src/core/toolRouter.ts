/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  recordToolCallInteractions,
  type Part,
} from "../../../gemini-cli/packages/core/src/index.js";
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
  search: (query: string, limit: number) => Promise<string[]>;
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

/** Returns 9 if the text contains an explicit "remember" intent, 6 otherwise. */
function computeRememberIntentScore(text?: string): number {
  if (!text) return 6;
  const normalized = text.trim();
  if (REMEMBER_PREFIX_PATTERNS.some((p) => p.test(normalized))) return 9;
  if (REMEMBER_INTENT_PATTERNS.some((p) => p.test(normalized))) return 9;
  return 6;
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
  const categoryScore = getCategoryBaseScore(params.category ?? "preference");
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

type AskUserQuestion = {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
};

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
  constructor(
    private memoryService: MemoryServiceHandle,
    private dynamicRegistry: DynamicRegistryHandle,
    private scheduler: SchedulerHandle,
    private client: ClientHandle,
    private taskCommandHandler?: TaskCommandHandlerHandle,
    private channelRegistry?: ChannelRegistryHandle,
  ) {}

  async route(
    requests: ToolCallRequest[],
    signal: AbortSignal,
    onToolResponse: (response: ToolCallResponse) => void,
  ): Promise<Part[]> {
    const nativeRequests = requests.filter((r) => isNativeTool(r.name));
    // Inject Jarvis long-term memory into generalist/codebase_investigator requests
    // so subagents have access to user preferences, past decisions, and context.
    const standardRequests = await Promise.all(
      requests
        .filter((r) => !isNativeTool(r.name))
        .map(async (r) => {
          if (
            (r.name === "generalist" || r.name === "codebase_investigator") &&
            typeof r.args.request === "string"
          ) {
            const query = r.args.request;
            const [facts, memories] = await Promise.all([
              this.memoryService.searchFacts(query),
              this.memoryService.search(query, 3),
            ]);
            const contextParts: string[] = [];
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
            if (contextParts.length > 0) {
              return {
                ...r,
                args: {
                  ...r.args,
                  request: contextParts.join("\n") + "\n\nTask: " + query,
                },
              };
            }
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
        const category = (req.args.category as string) || "preference";
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
        const query = (req.args.query as string)?.trim() || "";
        const limit = (req.args.limit as number) || 5;
        if (!query) {
          output = `recall_memory requires a non-empty query. Please provide keywords to search.`;
        } else {
          console.error(`🧠 [Jarvis] Active Recall initiated for: "${query}"`);
          const memories = await this.memoryService.search(query, limit);
          output =
            memories.length > 0
              ? `LONG-TERM MEMORIES FOUND:\n${memories.map((m) => `- ${m}`).join("\n")}\n\nINSTRUCTION: Now synthesize this history into your final answer.`
              : `NO SPECIFIC MEMORIES FOUND for "${query}". Proceed with current knowledge.`;
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
        console.error(
          `❓ [Jarvis] ask_user intercepted — auto-selecting recommended options.`,
        );
        output = buildAskUserResponse(questions);
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
