/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaGenerate } from "./ollamaClient.js";
import { extractDateRange, type DateRange } from "./dateRange.js";

export type QuerySubject = "personal" | "external" | "mixed";

export type IntentTaskType =
  | "chat"
  | "recall"
  | "analyze"
  | "execute"
  | "delegate"
  | "schedule";

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export type MemoryRecallTarget =
  | "conversation_history"
  | "user_memory"
  | "external_past_event"
  | "current_context_reference"
  | "none";

export type ActionRequestType =
  | "read"
  | "write"
  | "run"
  | "schedule"
  | "delegate"
  | "none";

export type IntentEvidence = {
  personalContext: {
    present: boolean;
    reason: string;
    span?: string;
  };
  memoryRecall: {
    present: boolean;
    target: MemoryRecallTarget;
    reason: string;
    span?: string;
  };
  actionRequest: {
    present: boolean;
    action: ActionRequestType;
    object?: string;
  };
  entityHints: {
    tickers: string[];
    technicalTerms: string[];
    peopleOrCompanies: string[];
  };
};

export type IntentFrame = {
  subject: QuerySubject;
  taskType: IntentTaskType;
  needsMemory: boolean;
  needsExternalKnowledge: boolean;
  needsTool: boolean;
  needsScheduling: boolean;
  candidateAgents: string[];
  timeWindowDays: number | null;
  dateFrom: string | null;
  dateTo: string | null;
  resolvedDateRange: { from: number; to: number } | null;
  topicShifted: boolean;
  referencesRecentHistory: boolean;
  complexityScore: number;
  knowledgeScore: number | null;
  operationScore: number | null;
  reason: string;
  confidence: number;
  evidence: string[];
  semanticEvidence: IntentEvidence;
  source: "local-intent/ollama";
};

export type IntentResolverOptions = {
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  historyTurns?: number;
};

type RawIntentModelResult = {
  complexity_score?: number;
  knowledge_score?: number;
  operation_score?: number;
  complexity_reasoning?: string;
  query_subject?: string;
  task_type?: string;
  needs_external_knowledge?: boolean;
  needs_tool?: boolean;
  needs_scheduling?: boolean;
  candidate_agents?: unknown;
  confidence?: number;
  evidence?: unknown;
  semantic_evidence?: unknown;
  time_window_days?: number | null;
  date_from?: string | null;
  date_to?: string | null;
  history_topic?: string;
  new_topic?: string;
  references_recent_history?: boolean;
  topic_shifted?: boolean;
};

// Fallback when classification fails or the model emits an invalid subject:
// conservative defaults avoid both over-injection and under-injection.
export const FALLBACK_QUERY_SUBJECT: QuerySubject = "mixed";

const VALID_SUBJECTS = new Set<QuerySubject>(["personal", "external", "mixed"]);

const VALID_TASK_TYPES = new Set<IntentTaskType>([
  "chat",
  "recall",
  "analyze",
  "execute",
  "delegate",
  "schedule",
]);

const PERSONAL_CONTEXT_CUE_RE =
  /我的|我之前|我们之前|适合我|按我|按我的|结合我|我该|我应该|for me\b|based on my\b|my preference\b|my preferences\b|my context\b|my goals\b|my history\b/i;

const MEMORY_RECALL_CUE_RE =
  /我们聊过|我们讨论过|咱们聊过|咱们讨论过|你之前说|你以前说|你上次说|我之前说|我以前说|我上次说|我们之前|我们以前|我们上次|咱们之前|咱们以前|咱们上次|之前.*(对话|聊天|讨论|聊过|说过|提到|记忆|memory)|以前.*(对话|聊天|讨论|聊过|说过|提到|记忆|memory)|上次.*(对话|聊天|讨论|聊过|说过|提到|记忆|memory)|what did we discuss|our previous|our last conversation|you previously said|you said last time|last time we|remember when we/i;

const SCHEDULE_CUE_RE =
  /提醒我|定时|每天|每周|每月|明天.*提醒|remind me|schedule|every day|every week|weekly|daily/i;

const ACTION_CUE_RE =
  /帮我(改|写|创建|运行|提交|部署|修|实现|生成)|创建|运行|提交|部署|修复|实现|生成文件|edit|modify|create|run|commit|deploy|fix|implement|generate.*file/i;

const EXPLICIT_DELEGATE_CUE_RE =
  /^agent:|启动.*agent|调用.*agent|用.*agent|route to agent|delegate to/i;

const INVESTMENT_ANALYSIS_CUE_RE =
  /投资价值|基本面|财报|估值|股票|股价|买入|卖出|持有|分析.*(nvda|googl|aapl|msft|tsla)|investment|fundamental|valuation|earnings|stock/i;

const TICKER_RE = /\b[A-Z]{1,5}\b/;
const NON_TICKER_ACRONYMS = new Set([
  "ADK",
  "API",
  "CLI",
  "CPU",
  "CSS",
  "GPU",
  "HTML",
  "HTTP",
  "JSON",
  "LLM",
  "MCP",
  "ONNX",
  "REST",
  "SDK",
  "SSE",
  "SQL",
  "URL",
  "XML",
]);

const ANAPHORA_RE =
  /它|这个|那个|这些|那些|上述|刚才|this\b|that\b|these\b|those\b|follow[- ]?up/i;

const LOW_CONFIDENCE_THRESHOLD = 0.55;

export function hasPersonalContextCue(prompt: string): boolean {
  return PERSONAL_CONTEXT_CUE_RE.test(prompt);
}

function hasMemoryRecallCue(prompt: string): boolean {
  return MEMORY_RECALL_CUE_RE.test(prompt);
}

function hasScheduleCue(prompt: string): boolean {
  return SCHEDULE_CUE_RE.test(prompt);
}

function hasActionCue(prompt: string): boolean {
  return ACTION_CUE_RE.test(prompt);
}

function hasExplicitDelegateCue(prompt: string): boolean {
  return EXPLICIT_DELEGATE_CUE_RE.test(prompt);
}

function hasInvestmentAnalysisCue(
  prompt: string,
  semanticEvidence: IntentEvidence,
): boolean {
  if (!INVESTMENT_ANALYSIS_CUE_RE.test(prompt)) return false;

  const semanticTickers = semanticEvidence.entityHints.tickers.filter(
    (symbol) => !NON_TICKER_ACRONYMS.has(symbol),
  );
  if (semanticTickers.length > 0) return true;

  const hasSemanticEntityHints =
    semanticEvidence.entityHints.tickers.length > 0 ||
    semanticEvidence.entityHints.technicalTerms.length > 0 ||
    semanticEvidence.entityHints.peopleOrCompanies.length > 0;
  if (hasSemanticEntityHints) return false;

  const symbols = prompt.match(new RegExp(TICKER_RE, "g")) ?? [];
  return symbols.some((symbol) => !NON_TICKER_ACRONYMS.has(symbol));
}

function hasAnaphoricReference(
  prompt: string,
  history: ConversationTurn[],
): boolean {
  return history.length > 0 && ANAPHORA_RE.test(prompt);
}

/**
 * Build the classifier prompt. Date/time resolution is handled by
 * extractDateRange() in code; the local model only needs to score and classify.
 */
function buildIntentPrompt(
  preResolvedRange: DateRange | null,
  now: Date,
): string {
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const todayName = DAY_NAMES[now.getDay()];

  const timeNote = preResolvedRange
    ? `NOTE: The system has already resolved the temporal reference to the date range ` +
      `[${new Date(preResolvedRange.from).toISOString().slice(0, 10)} ~ ` +
      `${new Date(preResolvedRange.to - 1).toISOString().slice(0, 10)}]. ` +
      `Output date_from=null, date_to=null, time_window_days=null — the system handles this.`
    : `If the request has NO clear temporal reference, output time_window_days=null, date_from=null, date_to=null.`;

  return `
Today is ${todayStr} (${todayName}).
You are Jarvis's intent resolver. Produce an IntentFrame seed for the user's request.

DIMENSION 1 — Knowledge Depth (1-100)
1-25: Basic fact retrieval, simple summaries.
26-50: Integrating concepts, standard workflows.
51-75: Deep expertise, cross-disciplinary analysis.
76-100: Cross-domain fusion, abstract thinking, system design.

DIMENSION 2 — Operational Difficulty (1-100)
1-25: Reading, simple input — no multi-step execution.
26-50: Multi-step operations, standard tools.
51-75: Skilled tool usage, process design.
76-100: Algorithm design, debugging, architectural decisions.

DIMENSION 3 — Query Subject (CRITICAL for memory retrieval)
- "personal": About the USER's own history, habits, preferences, past decisions, or past conversations. ANY question about what was discussed, even if the topic is external.
- "external": PURELY about the outside world with NO user history reference.
- "mixed": Needs BOTH personal context AND external knowledge.

KEY RULE: "what did we discuss on Monday" → personal, even if the topic is external.
MIXED RULE: External topic + any request to tailor, compare, recommend, decide, prioritize, or explain using the user's goals/preferences/history/context → mixed.
PERSONAL-CONTEXT CUES: "for me", "based on my", "my preference", "my context", "按我的", "结合我", "适合我", "我该", "我的", "我们之前" → mixed or personal, never external.
IF UNSURE between external and mixed, choose mixed.

DIMENSION 4 — Task Type
- "chat": answer conversationally without a specific action.
- "recall": retrieve or summarize past conversations, memories, or user history.
- "analyze": evaluate, compare, recommend, diagnose, or synthesize.
- "execute": modify files, run commands, operate tools, or complete a workflow.
- "delegate": launch or route to a specialized agent.
- "schedule": reminders, recurring tasks, timers, or future follow-up.

DIMENSION 5 — Capability Needs
- needs_external_knowledge=true when current outside-world knowledge or general domain facts are needed.
- needs_tool=true when the user asks Jarvis to act via tools, files, commands, web, or external agents.
- needs_scheduling=true only for reminders, timers, recurring work, or future follow-up.
- candidate_agents should contain likely specialized agent ids if obvious, otherwise [].

DIMENSION 5B — Structured Semantic Evidence
Return semantic_evidence to explain the labels:
- personalContext.present=true only when the request explicitly depends on the user's goals, preferences, identity, project, or prior personal context.
- memoryRecall.target:
  - "conversation_history": asks about what the user and Jarvis discussed before.
  - "user_memory": asks about stored user facts/preferences/history.
  - "external_past_event": asks about a past outside-world event, e.g. "上次苹果发布会发布了什么".
  - "current_context_reference": refers to the current recent conversation, e.g. "这个/that/继续".
  - "none": no memory recall.
- actionRequest.present=true only when the user asks Jarvis to do something operational. action is "read"|"write"|"run"|"schedule"|"delegate"|"none".
- entityHints.tickers should include likely financial ticker symbols only. Put technical acronyms such as ONNX, API, JSON, HTTP, LLM, SDK in technicalTerms, not tickers.

DIMENSION 6 — Time Window
${timeNote}

DIMENSION 7 — Topic Shift (only meaningful when conversation history is present)

Step 1 — Summarize: What is the main topic/domain of the recent history? (1 phrase)
Step 2 — Identify: What is the domain/intent of the new request? (1 phrase)
Step 3 — Check: Does the new request directly reference something in the CURRENT recent history?
  YES (references_recent_history=true): Uses pronouns/references pointing to what was JUST discussed.
    e.g. 它/这个/那个/这些/那些/上述/this/that/these/those/follow-up on what you just said
  NO (references_recent_history=false): Mentions past time ("之前"/"以前"/"上次") to REQUEST retrieval of older history, OR introduces a new subject with no tie to the current exchange.
  KEY DISTINCTION: "你之前说的那个方案" → references recent history (true). "帮我获取之前讨论的xxx" → requests retrieval of older history, not referencing this conversation (false).
Step 4 — Decide:
  - true (SHIFT): references_recent_history=false AND the new domain/intent differs from recent history.
  - false (NO SHIFT): references_recent_history=true, OR the new request continues/follows up the same domain.

Examples:
  History: "严格避免幻觉" | New: "帮我获取下之前讨论onnx的总结" → task_type="recall", query_subject="personal", references_recent_history=false, topic_shifted=true
  History: "分析英伟达财报" | New: "超微电脑股价呢" → task_type="analyze", query_subject="external", references_recent_history=true ("呢" refers to prior context), topic_shifted=false
  History: "实现reranker功能" | New: "继续" → task_type="execute", references_recent_history=true, topic_shifted=false
  History: "今天天气怎么样" | New: "帮我写一份投资分析报告" → task_type="execute", query_subject="external", references_recent_history=false, topic_shifted=true
  History: "讨论onnx部署" | New: "你之前说的那个超时参数怎么设" → task_type="chat", query_subject="personal", references_recent_history=true, topic_shifted=false

SCORING FORMULA
complexity_score = knowledge_score * 0.6 + operation_score * 0.4 (round to integer)

OUTPUT RULES
- Respond ONLY with a raw JSON object. No markdown, no explanation.
- All fields required. time_window_days / date_from / date_to may be null.
- confidence is 0-1.
- evidence is an array of short strings naming cues you used.
- semantic_evidence is required and must follow the schema below.

Required schema:
{"knowledge_score": <1-100>, "operation_score": <1-100>, "complexity_score": <1-100>, "complexity_reasoning": "<one sentence>", "query_subject": "personal"|"external"|"mixed", "task_type": "chat"|"recall"|"analyze"|"execute"|"delegate"|"schedule", "needs_external_knowledge": true|false, "needs_tool": true|false, "needs_scheduling": true|false, "candidate_agents": ["<agent-id>"], "confidence": <0-1>, "evidence": ["<short cue>"], "semantic_evidence": {"personalContext": {"present": true|false, "reason": "<short reason>", "span": "<text span>"}, "memoryRecall": {"present": true|false, "target": "conversation_history"|"user_memory"|"external_past_event"|"current_context_reference"|"none", "reason": "<short reason>", "span": "<text span>"}, "actionRequest": {"present": true|false, "action": "read"|"write"|"run"|"schedule"|"delegate"|"none", "object": "<object or empty>"}, "entityHints": {"tickers": ["<ticker>"], "technicalTerms": ["<term>"], "peopleOrCompanies": ["<name>"]}}, "time_window_days": <integer>|null, "date_from": "<YYYY-MM-DD>"|null, "date_to": "<YYYY-MM-DD>"|null, "history_topic": "<1 phrase>", "new_topic": "<1 phrase>", "references_recent_history": true|false, "topic_shifted": true|false}
`.trim();
}

function parseJsonObject(raw: string): RawIntentModelResult {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("No JSON in intent response");
  }
  return JSON.parse(stripped.slice(start, end + 1)) as RawIntentModelResult;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeEvidenceStrings(value: unknown): string[] {
  return normalizeStringArray(value);
}

function normalizeConfidence(value: unknown): number {
  const confidence = Number(value);
  if (Number.isNaN(confidence)) return 0.5;
  return Math.max(0, Math.min(1, confidence));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMemoryRecallTarget(value: unknown): MemoryRecallTarget {
  if (
    value === "conversation_history" ||
    value === "user_memory" ||
    value === "external_past_event" ||
    value === "current_context_reference" ||
    value === "none"
  ) {
    return value;
  }
  return "none";
}

function normalizeActionRequestType(value: unknown): ActionRequestType {
  if (
    value === "read" ||
    value === "write" ||
    value === "run" ||
    value === "schedule" ||
    value === "delegate" ||
    value === "none"
  ) {
    return value;
  }
  return "none";
}

function normalizeIntentEvidence(value: unknown): IntentEvidence {
  const root = asRecord(value);
  const personalContext = asRecord(root.personalContext);
  const memoryRecall = asRecord(root.memoryRecall);
  const actionRequest = asRecord(root.actionRequest);
  const entityHints = asRecord(root.entityHints);

  return {
    personalContext: {
      present: personalContext.present === true,
      reason: normalizeOptionalString(personalContext.reason) ?? "",
      span: normalizeOptionalString(personalContext.span),
    },
    memoryRecall: {
      present: memoryRecall.present === true,
      target: normalizeMemoryRecallTarget(memoryRecall.target),
      reason: normalizeOptionalString(memoryRecall.reason) ?? "",
      span: normalizeOptionalString(memoryRecall.span),
    },
    actionRequest: {
      present: actionRequest.present === true,
      action: normalizeActionRequestType(actionRequest.action),
      object: normalizeOptionalString(actionRequest.object),
    },
    entityHints: {
      tickers: normalizeStringArray(entityHints.tickers),
      technicalTerms: normalizeStringArray(entityHints.technicalTerms),
      peopleOrCompanies: normalizeStringArray(entityHints.peopleOrCompanies),
    },
  };
}

function inferTaskType(prompt: string, parsedTaskType: string | undefined) {
  const rawTaskType = parsedTaskType?.toLowerCase().trim();
  if (VALID_TASK_TYPES.has(rawTaskType as IntentTaskType)) {
    return rawTaskType as IntentTaskType;
  }
  if (hasScheduleCue(prompt)) return "schedule";
  if (hasMemoryRecallCue(prompt)) return "recall";
  return "chat";
}

export class IntentResolver {
  constructor(private readonly options: IntentResolverOptions) {}

  async resolve(args: {
    userPrompt: string;
    history?: ConversationTurn[];
    now?: Date;
  }): Promise<IntentFrame> {
    const history = args.history ?? [];
    const now = args.now ?? new Date();
    const prompt = args.userPrompt;
    const preResolved = extractDateRange(prompt, now);
    const anaphoric = hasAnaphoricReference(prompt, history);

    if (anaphoric) {
      console.error(
        `🔗 [IntentResolver] Anaphoric reference detected — topic_shifted forced false`,
      );
    }

    const recentTurns = history.slice(-(this.options.historyTurns ?? 5) * 2);
    const historySection =
      recentTurns.length > 0
        ? `\n# Recent Conversation Context\n${recentTurns
            .map(
              (t) =>
                `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 200)}`,
            )
            .join("\n")}\n`
        : "";

    const fullPrompt = `${buildIntentPrompt(preResolved, now)}${historySection}\nUser request: ${prompt}`;
    const raw = await ollamaGenerate(this.options.model, fullPrompt, {
      baseUrl: this.options.baseUrl ?? "http://localhost:11434",
      timeoutMs: this.options.timeoutMs ?? 30_000,
    });
    const parsed = parseJsonObject(raw);
    const confidence = normalizeConfidence(parsed.confidence);
    const semanticEvidence = normalizeIntentEvidence(parsed.semantic_evidence);
    const memoryRecallTarget = semanticEvidence.memoryRecall.target;
    const semanticRecallCue =
      semanticEvidence.memoryRecall.present &&
      (memoryRecallTarget === "conversation_history" ||
        memoryRecallTarget === "user_memory");
    const externalPastEventCue = memoryRecallTarget === "external_past_event";
    const currentContextReferenceCue =
      memoryRecallTarget === "current_context_reference";
    const semanticActionPresent = semanticEvidence.actionRequest.present;
    const personalCue =
      semanticEvidence.personalContext.present || hasPersonalContextCue(prompt);
    const recallCue =
      !externalPastEventCue &&
      (semanticRecallCue || hasMemoryRecallCue(prompt));
    const scheduleCue =
      (semanticActionPresent &&
        semanticEvidence.actionRequest.action === "schedule") ||
      hasScheduleCue(prompt);
    const actionCue =
      (semanticActionPresent &&
        semanticEvidence.actionRequest.action !== "read" &&
        semanticEvidence.actionRequest.action !== "delegate" &&
        semanticEvidence.actionRequest.action !== "none") ||
      hasActionCue(prompt);
    const explicitDelegateCue =
      (semanticActionPresent &&
        semanticEvidence.actionRequest.action === "delegate") ||
      hasExplicitDelegateCue(prompt);
    const investmentAnalysisCue = hasInvestmentAnalysisCue(
      prompt,
      semanticEvidence,
    );

    const score = Number(parsed.complexity_score);
    if (Number.isNaN(score) || score < 1 || score > 100) {
      throw new Error(`Invalid complexity_score: ${parsed.complexity_score}`);
    }

    const rawSubject = parsed.query_subject?.toLowerCase().trim();
    let subject: QuerySubject = VALID_SUBJECTS.has(rawSubject as QuerySubject)
      ? (rawSubject as QuerySubject)
      : FALLBACK_QUERY_SUBJECT;

    const evidence = normalizeEvidenceStrings(parsed.evidence);
    if (!VALID_SUBJECTS.has(rawSubject as QuerySubject)) {
      evidence.push(`invalid_subject:${rawSubject ?? "missing"}`);
      console.error(
        `⚠️ [IntentResolver] Invalid query_subject "${rawSubject}", using fallback "${FALLBACK_QUERY_SUBJECT}"`,
      );
    }

    // Recall of Jarvis/user memory is more specific than a generic personal
    // context cue, so it intentionally wins when both cues are present.
    if (recallCue && subject !== "personal") {
      const previousSubject = subject;
      subject = "personal";
      evidence.push("memory_recall_cue");
      console.error(
        `🧠 [IntentResolver] Memory recall cue detected — subject upgraded ${previousSubject} → personal`,
      );
    } else if (subject === "external" && personalCue) {
      subject = "mixed";
      evidence.push("personal_context_cue");
      console.error(
        `🧠 [IntentResolver] Personal-context cue detected — subject upgraded external → mixed`,
      );
    } else if (
      subject === "external" &&
      confidence < LOW_CONFIDENCE_THRESHOLD &&
      !externalPastEventCue
    ) {
      subject = "mixed";
      evidence.push("low_confidence_external_subject");
      console.error(
        `🧠 [IntentResolver] Low-confidence external subject (${confidence.toFixed(2)}) — upgraded external → mixed`,
      );
    }

    let timeWindowDays: number | null = null;
    if (
      parsed.time_window_days !== null &&
      parsed.time_window_days !== undefined
    ) {
      const rawDays = Number(parsed.time_window_days);
      if (!Number.isNaN(rawDays) && rawDays >= 0 && Number.isInteger(rawDays)) {
        timeWindowDays = rawDays;
      } else {
        evidence.push(`invalid_time_window:${parsed.time_window_days}`);
        console.error(
          `⚠️ [IntentResolver] Invalid time_window_days "${parsed.time_window_days}", using null`,
        );
      }
    }

    let dateFrom: string | null = null;
    let dateTo: string | null = null;

    if (preResolved !== null) {
      const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      dateFrom = toIso(preResolved.from);
      dateTo = toIso(preResolved.to - 1);
      timeWindowDays = null;
      evidence.push("code_resolved_date_range");
    } else {
      const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      if (parsed.date_from && ISO_DATE_RE.test(String(parsed.date_from))) {
        dateFrom = String(parsed.date_from);
      }
      if (parsed.date_to && ISO_DATE_RE.test(String(parsed.date_to))) {
        dateTo = String(parsed.date_to);
      }
      if (dateFrom !== null && dateTo !== null) {
        timeWindowDays = null;
      }
    }

    let taskType = inferTaskType(prompt, parsed.task_type);
    if (scheduleCue && taskType !== "schedule") {
      taskType = "schedule";
      evidence.push("schedule_cue");
    } else if (recallCue && taskType !== "recall") {
      taskType = "recall";
      evidence.push("memory_recall_cue");
    } else if (externalPastEventCue && taskType === "recall") {
      taskType = "analyze";
      evidence.push("external_past_event_not_recall");
    } else if (explicitDelegateCue && taskType !== "delegate") {
      taskType = "delegate";
      evidence.push("delegate_action_cue");
    } else if (actionCue && taskType === "chat") {
      taskType = "execute";
      evidence.push("action_cue");
    }

    const candidateAgents = normalizeStringArray(parsed.candidate_agents);
    if (
      investmentAnalysisCue &&
      !candidateAgents.includes("investment-analysis")
    ) {
      candidateAgents.push("investment-analysis");
      evidence.push("investment_analysis_candidate");
    }

    let delegateDowngraded = false;
    if (taskType === "delegate" && !explicitDelegateCue) {
      taskType = investmentAnalysisCue ? "analyze" : "chat";
      delegateDowngraded = true;
      evidence.push("delegate_downgraded_to_candidate");
    }

    const referencesRecentHistory =
      anaphoric ||
      currentContextReferenceCue ||
      parsed.references_recent_history === true;
    if (currentContextReferenceCue) {
      console.error(
        `🔗 [IntentResolver] Semantic current-context reference detected — topic_shifted forced false`,
      );
    }
    // No history → topic shift is meaningless; force false to avoid spurious clears.
    const topicShifted =
      recentTurns.length === 0
        ? false
        : referencesRecentHistory
          ? false
          : parsed.topic_shifted === true;

    if (parsed.history_topic || parsed.new_topic) {
      console.error(
        `🔍 [IntentResolver] topic analysis: history="${parsed.history_topic ?? "?"}" new="${parsed.new_topic ?? "?"}" references_recent=${parsed.references_recent_history ?? "?"} → topic_shifted=${topicShifted}`,
      );
    }

    const needsScheduling =
      scheduleCue || normalizeBoolean(parsed.needs_scheduling);
    const needsTool =
      needsScheduling ||
      taskType === "execute" ||
      taskType === "delegate" ||
      (!delegateDowngraded && normalizeBoolean(parsed.needs_tool));

    return {
      subject,
      taskType,
      needsMemory: subject !== "external" || taskType === "recall",
      needsExternalKnowledge:
        subject === "external" ||
        subject === "mixed" ||
        normalizeBoolean(parsed.needs_external_knowledge),
      needsTool,
      needsScheduling,
      candidateAgents,
      timeWindowDays,
      dateFrom,
      dateTo,
      resolvedDateRange: preResolved,
      topicShifted,
      referencesRecentHistory,
      complexityScore: score,
      knowledgeScore:
        parsed.knowledge_score === undefined
          ? null
          : Number(parsed.knowledge_score),
      operationScore:
        parsed.operation_score === undefined
          ? null
          : Number(parsed.operation_score),
      reason: parsed.complexity_reasoning ?? "(no reason)",
      confidence,
      evidence,
      source: "local-intent/ollama",
      semanticEvidence,
    };
  }
}
