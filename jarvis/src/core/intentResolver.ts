/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractDateRange, type DateRange } from "./dateRange.js";
import type { IntentModelClient } from "../memory-runtime/adapters.js";
import { defaultOperationForStep } from "../memory-runtime/crudPolicy.js";
import { JarvisOllamaIntentModelClient } from "./jarvisOllamaIntentModelClient.js";
import {
  createIntentPolicyRegistry,
  logAppliedPolicyTrace,
  normalizeIntentPolicyReason,
  runIntentPolicyRules,
  type IntentCueState,
  type IntentPolicyTraceEntry,
} from "./intentPolicy.js";
import type {
  ActionRequestType,
  ConversationTurn,
  GroundedTopic,
  IntentConfidenceByDimension,
  IntentEvidence,
  IntentFrame,
  IntentStep,
  IntentTaskType,
  MemoryRecallTarget,
  QuerySubject,
  RichIntent,
  RichIntentAction,
  RichIntentDomain,
  RichIntentPrimaryAction,
  RichIntentRiskLevel,
  RichIntentTargetType,
  TopicAnalysis,
  TopicRelation,
} from "../memory-runtime/types.js";

export type {
  ActionRequestType,
  ConversationTurn,
  GroundedTopic,
  IntentConfidenceByDimension,
  IntentEvidence,
  IntentFrame,
  IntentStep,
  IntentTaskType,
  MemoryRecallTarget,
  QuerySubject,
  RichIntent,
  RichIntentAction,
  RichIntentDomain,
  RichIntentPrimaryAction,
  RichIntentRiskLevel,
  RichIntentTargetType,
  TopicAnalysis,
  TopicRelation,
} from "../memory-runtime/types.js";

export type IntentResolverOptions = {
  baseUrl?: string;
  model?: string;
  modelClient?: IntentModelClient;
  modelSource?: string;
  timeoutMs?: number;
  historyTurns?: number;
  intentPolicyObservability?: boolean;
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
  confidence_by_dimension?: unknown;
  evidence?: unknown;
  semantic_evidence?: unknown;
  time_window_days?: number | null;
  date_from?: string | null;
  date_to?: string | null;
  history_topic?: string;
  new_topic?: string;
  references_recent_history?: boolean;
  topic_shifted?: boolean;
  rich_intent?: {
    userGoal?: string;
    domain?: string;
    action?: string;
    targets?: unknown;
    contextDependency?: unknown;
    ambiguity?: unknown;
    riskLevel?: string;
  };
  intent_steps?: unknown;
  topic_analysis?: unknown;
};

type RawIntentStepOperation = {
  domain?: unknown;
  action?: unknown;
  target_type?: unknown;
  target?: unknown;
  target_id?: unknown;
  selector?: unknown;
  scope?: unknown;
  risk_level?: unknown;
};

type RawMemoryTargetResult = {
  present?: boolean;
  target?: unknown;
  reason?: unknown;
  span?: unknown;
};

type RawEntityHintsResult = {
  tickers?: unknown;
  technicalTerms?: unknown;
  peopleOrCompanies?: unknown;
};

function isLikelyIntentModelResult(
  value: unknown,
): value is RawIntentModelResult {
  const record = asRecord(value);
  return (
    "complexity_score" in record &&
    "query_subject" in record &&
    "task_type" in record &&
    "semantic_evidence" in record
  );
}

function isLikelyMemoryTargetResult(
  value: unknown,
): value is RawMemoryTargetResult {
  const record = asRecord(value);
  return "target" in record || "present" in record;
}

function isLikelyEntityHintsResult(
  value: unknown,
): value is RawEntityHintsResult {
  const record = asRecord(value);
  return (
    "tickers" in record ||
    "technicalTerms" in record ||
    "peopleOrCompanies" in record
  );
}

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
  /我们聊过|我们讨论过|咱们聊过|咱们讨论过|你之前说|你以前说|你上次说|我之前说|我以前说|我上次说|我们之前|我们以前|我们上次|咱们之前|咱们以前|咱们上次|之前.*(对话|聊天|讨论|探讨|聊过|说过|提到|内容|记忆|memory)|以前.*(对话|聊天|讨论|探讨|聊过|说过|提到|内容|记忆|memory)|上次.*(对话|聊天|讨论|探讨|聊过|说过|提到|内容|记忆|memory)|what did we discuss|our previous|our last conversation|you previously said|you said last time|last time we|remember when we/i;

const CONVERSATION_HISTORY_RECALL_CUE_RE =
  /我们聊过|我们讨论过|咱们聊过|咱们讨论过|你之前说|你以前说|你上次说|我之前说|我以前说|我上次说|之前.*(对话|聊天|讨论|探讨|聊过|说过|提到|内容)|以前.*(对话|聊天|讨论|探讨|聊过|说过|提到|内容)|上次.*(对话|聊天|讨论|探讨|聊过|说过|提到|内容)|what did we discuss|our previous conversation|our last conversation|you previously said|you said last time|last time we discussed/i;

const DATE_HISTORY_RECALL_CUE_RE =
  /(昨天|前天|今天|上周|上个月|两天前|三天前|last\s+(?:time|week|month)|yesterday|today).*(聊|讨论|探讨|说|内容|conversation|discuss|talk)|(?:聊|讨论|探讨).*(哪些|什么|内容|what)/i;

const USER_MEMORY_RECALL_CUE_RE =
  /(还记得|记得|remember).*(我|我的|偏好|习惯|风格|喜好|爱好|名字|身份|目标|风险偏好)|我有哪些(爱好|偏好|习惯)|我的(爱好|偏好|习惯|风格|目标|风险偏好)|my .*(hobbies|preferences|habits|style|goals|risk profile)/i;

const REMEMBER_TO_ACTION_CUE_RE =
  /记得(保存|提交|运行|创建|打开|关闭|下载|上传|备份|删除|发送|检查|更新|修改|写|做)|remember to (save|commit|run|create|open|close|download|upload|delete|send|check|update|modify|write|do)/i;

const SCHEDULE_CUE_RE =
  /提醒我|定时|每天|每周|每月|明天.*提醒|remind me|schedule|every day|every week|weekly|daily/i;

const ACTION_CUE_RE =
  /帮我(改|写|创建|运行|提交|部署|修|实现|生成|增加|更新|整理|发送|推送)|增加.*(测试|用例|单元测试)|创建|运行|提交|部署|修复|实现|生成文件|更新到|整理到|发到|发给|推送到|发送到|edit|modify|update|create|run|commit|deploy|fix|implement|generate.*file|send to|push to|forward to/i;

const OUTPUT_ARTIFACT_CUE_RE =
  /整理成|写成|输出为|保存为|生成.*(报告|文档|markdown|md)|markdown|\.md\b|report|document/i;

const EXPLICIT_DELEGATE_CUE_RE =
  /^agent:|启动.*agent|调用.*agent|用.*agent|route to agent|delegate to/i;

const INVESTMENT_ANALYSIS_CUE_RE =
  /投资价值|基本面|财报|估值|股票|股价|买入|卖出|持有|分析.*(nvda|googl|aapl|msft|tsla)|investment|fundamental|valuation|earnings|stock/i;

const ASSISTANT_ADDRESS_RE = /^(?:jarvis|javis|贾维斯)[，,：:\s]+/i;

const ENTITY_REFINEMENT_CUE_RE =
  /\b[A-Z]{2,5}\b|React|Vue|TypeScript|JavaScript|Node\.?js|英伟达|苹果|微软|特斯拉|谷歌|亚马逊|Nvidia|Apple|Microsoft|Tesla|Google|Amazon/;

const TICKER_RE = /\b[A-Z]{2,5}\b/;
const KNOWN_TECHNICAL_TERMS = [
  "React",
  "Vue",
  "TypeScript",
  "JavaScript",
  "Node.js",
  "ONNX",
  "RAG",
  "HTTP",
  "JSON",
  "API",
  "LLM",
];
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
  "RAG",
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

function hasUserPreferenceCue(prompt: string): boolean {
  return /我.*(偏好|习惯|风格|喜好)|我的.*(偏好|习惯|风格|喜好)|my .*(preference|style|habit)/i.test(
    prompt,
  );
}

function stripAssistantAddress(prompt: string): string {
  return prompt.trim().replace(ASSISTANT_ADDRESS_RE, "").trim();
}

function hasPersonalIdentityAssertionCue(prompt: string): boolean {
  const text = stripAssistantAddress(prompt);
  if (!text || /[?？]$/.test(text)) return false;
  const zhIdentity =
    /^(?:我是|我叫|我的名字是|我的姓名是|本人是)(?!希望|想|准备|打算|要|来|为了|不是|否|觉得|认为)[\s\S]{1,80}[。.!！]?$/.test(
      text,
    );
  const enIdentity =
    /^(?:i am|i'm|my name is|this is)(?!\s+(?:hoping|looking|trying|going|planning|asking)\b)\s+[a-z][a-z0-9 .'-]{1,80}[.!]?$/i.test(
      text,
    );
  return zhIdentity || enIdentity;
}

function hasPersonalPreferenceAssertionCue(prompt: string): boolean {
  const text = stripAssistantAddress(prompt);
  if (!text || /[?？]$/.test(text)) return false;
  return /^(?:我喜欢|我偏好|我更喜欢|我习惯|我的(?:偏好|习惯|风格|名字|姓名|英文名|中文名)是|i prefer|i like|my (?:preference|style|habit|name) is)\s*[\s\S]{1,100}[。.!！]?$/i.test(
    text,
  );
}

export function hasPersonalFactAssertionCue(prompt: string): boolean {
  return (
    hasPersonalIdentityAssertionCue(prompt) ||
    hasPersonalPreferenceAssertionCue(prompt)
  );
}

function personalFactTopicLabel(prompt: string): string {
  return hasPersonalIdentityAssertionCue(prompt)
    ? "Personal identity assertion"
    : "Personal fact assertion";
}

function hasMemoryRecallCue(prompt: string): boolean {
  return (
    !hasRememberToActionCue(prompt) &&
    (MEMORY_RECALL_CUE_RE.test(prompt) ||
      /还记得.*(我|我的|偏好|习惯|风格|喜好)|记得.*(我|我的|偏好|习惯|风格|喜好)/i.test(
        prompt,
      ))
  );
}

function hasConversationHistoryRecallCue(prompt: string): boolean {
  return (
    CONVERSATION_HISTORY_RECALL_CUE_RE.test(prompt) ||
    DATE_HISTORY_RECALL_CUE_RE.test(prompt)
  );
}

function inferRecallTargetFromTurnText(
  text: string,
): MemoryRecallTarget | null {
  if (hasConversationHistoryRecallCue(text)) return "conversation_history";
  if (USER_MEMORY_RECALL_CUE_RE.test(text)) return "user_memory";
  return null;
}

function inferRecentRecallTarget(
  turns: ConversationTurn[],
): MemoryRecallTarget | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn.role !== "user") continue;
    const target = inferRecallTargetFromTurnText(turn.content);
    if (target) return target;
  }
  return null;
}

function isRecallBoundaryTarget(target: MemoryRecallTarget): boolean {
  return target === "conversation_history" || target === "user_memory";
}

function hasRememberToActionCue(prompt: string): boolean {
  return REMEMBER_TO_ACTION_CUE_RE.test(prompt);
}

function hasScheduleCue(prompt: string): boolean {
  return SCHEDULE_CUE_RE.test(prompt);
}

function hasActionCue(prompt: string): boolean {
  return ACTION_CUE_RE.test(prompt);
}

function hasOutputArtifactCue(prompt: string): boolean {
  return OUTPUT_ARTIFACT_CUE_RE.test(prompt);
}

function hasExplicitDelegateCue(prompt: string): boolean {
  return EXPLICIT_DELEGATE_CUE_RE.test(prompt);
}

function inferActionRequestFromCue(prompt: string): ActionRequestType | null {
  if (hasExplicitDelegateCue(prompt)) return "delegate";
  if (hasScheduleCue(prompt)) return "schedule";
  if (/运行|run|执行.*测试|run.*test/i.test(prompt)) return "run";
  if (hasActionCue(prompt) || hasOutputArtifactCue(prompt)) return "write";
  return null;
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

function extractTickerCandidates(prompt: string): string[] {
  const symbols = prompt.match(new RegExp(TICKER_RE, "g")) ?? [];
  return Array.from(
    new Set(
      symbols
        .map((symbol) => symbol.toUpperCase())
        .filter((symbol) => !NON_TICKER_ACRONYMS.has(symbol)),
    ),
  );
}

function normalizeInvestmentEntityHints(
  prompt: string,
  semanticEvidence: IntentEvidence,
  emitLog = true,
): IntentEvidence {
  if (!INVESTMENT_ANALYSIS_CUE_RE.test(prompt)) return semanticEvidence;

  const promptTickers = extractTickerCandidates(prompt);
  if (promptTickers.length === 0) return semanticEvidence;

  const existingTickers = semanticEvidence.entityHints.tickers.map((ticker) =>
    ticker.toUpperCase(),
  );
  const tickers = Array.from(new Set([...existingTickers, ...promptTickers]));
  const originalTickers = semanticEvidence.entityHints.tickers;
  const unchanged =
    tickers.length === originalTickers.length &&
    tickers.every((ticker, index) => ticker === originalTickers[index]);
  if (unchanged) {
    return semanticEvidence;
  }

  const promoted = new Set(promptTickers);
  if (emitLog) {
    console.error(
      `🏷️ [IntentResolver] Deterministic ticker normalization tickers=${promptTickers.join(",")}`,
    );
  }
  return {
    ...semanticEvidence,
    entityHints: {
      tickers,
      technicalTerms: semanticEvidence.entityHints.technicalTerms.filter(
        (term) => !promoted.has(term.toUpperCase()),
      ),
      peopleOrCompanies: semanticEvidence.entityHints.peopleOrCompanies.filter(
        (name) => !promoted.has(name.toUpperCase()),
      ),
    },
  };
}

function normalizeTechnicalEntityHints(
  prompt: string,
  semanticEvidence: IntentEvidence,
  emitLog = true,
): IntentEvidence {
  const existing = new Set(
    semanticEvidence.entityHints.technicalTerms.map((term) =>
      term.toLowerCase(),
    ),
  );
  const detected = KNOWN_TECHNICAL_TERMS.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(prompt);
  }).filter((term) => !existing.has(term.toLowerCase()));

  if (detected.length === 0) return semanticEvidence;

  if (emitLog) {
    console.error(
      `🏷️ [IntentResolver] Deterministic technical-term normalization terms=${detected.join(",")}`,
    );
  }
  return {
    ...semanticEvidence,
    entityHints: {
      ...semanticEvidence.entityHints,
      technicalTerms: [
        ...semanticEvidence.entityHints.technicalTerms,
        ...detected,
      ],
    },
  };
}

function hasAnaphoricReference(
  prompt: string,
  history: ConversationTurn[],
): boolean {
  return history.length > 0 && ANAPHORA_RE.test(prompt);
}

function hasCurrentContextReferenceCue(prompt: string): boolean {
  return (
    ANAPHORA_RE.test(prompt) ||
    /继续|展开.*(这个|该|上述|上面)|这个.*场景|这个.*方案|呢\s*[？?]?$|same\b|continue\b|above\b/i.test(
      prompt,
    )
  );
}

const GENERIC_CONTEXT_ENTITY_TERMS = new Set([
  "ai",
  "api",
  "html",
  "http",
  "https",
  "json",
  "llm",
  "rag",
  "ui",
  "web",
]);

function normalizeEntityTerm(term: string): string {
  return term.trim().replace(/\s+/g, " ");
}

function collectSpecificEntityTerms(
  prompt: string,
  semanticEvidence: IntentEvidence,
): string[] {
  const terms = new Set<string>();
  const addTerm = (term: string) => {
    const normalized = normalizeEntityTerm(term);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (GENERIC_CONTEXT_ENTITY_TERMS.has(key)) return;
    if (normalized.length < 3) return;
    terms.add(normalized);
  };

  semanticEvidence.entityHints.tickers.forEach(addTerm);
  semanticEvidence.entityHints.technicalTerms.forEach(addTerm);
  semanticEvidence.entityHints.peopleOrCompanies.forEach(addTerm);

  const englishEntityPhrases =
    prompt.match(
      /\b[A-Z][A-Za-z0-9+.-]{2,}(?:\s+[A-Z][A-Za-z0-9+.-]{1,}){0,3}\b/g,
    ) ?? [];
  englishEntityPhrases.forEach(addTerm);

  return [...terms];
}

function hasSelfContainedEntityQuery(
  prompt: string,
  semanticEvidence: IntentEvidence,
): boolean {
  const entityTerms = collectSpecificEntityTerms(prompt, semanticEvidence);
  if (entityTerms.length === 0) return false;
  if (hasCurrentContextReferenceCue(prompt)) return false;
  return /[？?]|是否|是不是|有没有|已经|当前|现在|发布|可用|状态|价格|基本面|怎么样|如何|when\b|available\b|released\b|status\b/i.test(
    prompt,
  );
}

function recentHistoryContainsEntityTerms(
  recentTurns: ConversationTurn[],
  entityTerms: string[],
): boolean {
  if (recentTurns.length === 0 || entityTerms.length === 0) return false;
  const historyText = recentTurns
    .map((turn) => turn.content)
    .join("\n")
    .toLowerCase();
  return entityTerms.some((term) => historyText.includes(term.toLowerCase()));
}

function hasBroadTopicalHistory(
  recentTurns: ConversationTurn[],
  parsedTopicAnalysis: Record<string, unknown>,
): boolean {
  const topicHistory = asRecord(parsedTopicAnalysis.history);
  const evidence = normalizeStringArray(topicHistory.evidence).join("\n");
  const text = [
    normalizeOptionalString(topicHistory.label) ?? "",
    evidence,
    ...recentTurns.map((turn) => turn.content),
  ].join("\n");
  return /汇总|前沿|动态|周报|日报|资讯|报告|过去一周|一周内|roundup|report|news|updates|weekly|frontier/i.test(
    text,
  );
}

function hasEntityStatusDrilldown(
  prompt: string,
  semanticEvidence: IntentEvidence,
): boolean {
  return (
    hasSelfContainedEntityQuery(prompt, semanticEvidence) &&
    /是否|是不是|有没有|已经|当前|现在|发布|可用|状态|进展|available|released|status/i.test(
      prompt,
    )
  );
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
- entityHints may be empty when uncertain. A focused entity extractor can refine tickers and technical terms later.
- rich_intent expresses the user's concrete goal/action/targets/context.
  - domain:
    - "task_management": reminders, timers, calendar, recurring tasks, todo lists.
    - "memory_management": saving/deleting facts, searching past conversations, updating preferences.
    - "code_modification": editing files, refactoring, fixing bugs, writing tests.
    - "system_control": running shell commands, managing system processes, hardware control.
    - "general_chat": greetings, casual talk, philosophical questions.
    - "external_knowledge": general facts, news, search engine queries.
    - "investment_analysis": stock analysis, financial reports, market trends.
    - "unknown": ambiguous or unclassifiable.
  - action: "create"|"read"|"update"|"delete"|"list"|"append"|"rename"|"pause"|"resume"|"cancel"|"send"|"resend"|"forward"|"retry"|"forget"|"consolidate"|"execute"|"schedule"|"answer"|"analyze"|"delegate"|"recall".
  - Keep subject/task_type for compatibility, but fill rich_intent domain/action whenever possible.

DIMENSION 5C — Multi-Intent Steps
Return intent_steps as a compact ordered plan of the meaningful sub-intents in the user request.
- Keep task_type as the dominant primary intent for backward compatibility.
- For a single-intent request, one step is enough.
- For multi-intent requests, include all materially distinct steps, such as recall user context, analyze an external entity, write/output an artifact, delegate to an agent, or schedule a reminder.
- Use ids "step-1", "step-2", etc. depends_on references earlier ids when one step requires another.
- type must be one of "chat"|"recall"|"analyze"|"execute"|"delegate"|"schedule".
- requires_confirmation=true only for high-risk operations or ambiguous schedule/delegate/write actions.
- operation is the structured per-step CRUD/lifecycle contract. Fill it per step:
  - domain: "task_management"|"memory_management"|"code_modification"|"system_control"|"general_chat"|"external_knowledge"|"investment_analysis"|"unknown".
  - action: "create"|"read"|"update"|"delete"|"list"|"append"|"rename"|"pause"|"resume"|"cancel"|"send"|"resend"|"forward"|"retry"|"forget"|"consolidate"|"execute"|"schedule"|"answer"|"analyze"|"delegate"|"recall".
  - target_type: "memory"|"file"|"code"|"external_entity"|"agent"|"task"|"channel"|"calendar"|"current_context".
  - target is the concrete object or selector; selector can repeat target when no id exists.
  - scope: "current_session"|"long_term"|"workspace"|"external"|"scheduled_tasks"|"channel" when obvious.

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

DIMENSION 7B — Grounded Topic Analysis
Return topic_analysis in addition to legacy history_topic/new_topic.
Grounding rules:
- topic_analysis.history.label must be a faithful compact label of the relevant recent history.
- topic_analysis.current.label must be a faithful compact label of the current user request.
- Each label must be supported by evidence spans copied or closely paraphrased from the provided text.
- Do not introduce unstated lifecycle/stage words such as architecture/design/implementation unless supported by evidence.
- source_turns uses negative indexes over the Recent Conversation Context: -1 is the most recent turn, -2 the turn before it.
- relation:
  - "current_context_reference": current request directly refers to the recent conversation with pronouns/follow-up wording.
  - "same_topic": same domain and same intent.
  - "subtopic": current request narrows or deepens the recent topic.
  - "adjacent_topic": shares a broad domain but changes intent, layer, or focus.
  - "new_topic": unrelated domain.
  - "unknown": insufficient grounding.
Use topic_analysis.confidence to express confidence in the topic grounding and relation.

SCORING FORMULA
complexity_score = knowledge_score * 0.6 + operation_score * 0.4 (round to integer)

OUTPUT RULES
- Respond ONLY with a raw JSON object. No markdown, no explanation.
- All fields required. time_window_days / date_from / date_to may be null.
- confidence is 0-1.
- confidence_by_dimension gives independent 0-1 confidence for subject, taskType, memoryTarget, action, entityHints, topicShift, and richIntent.
- evidence is an array of short strings naming cues you used.
- semantic_evidence is required and must follow the schema below.

Required compact schema:
{
  "knowledge_score": 1-100,
  "operation_score": 1-100,
  "complexity_score": 1-100,
  "complexity_reasoning": "one sentence",
  "query_subject": "personal|external|mixed",
  "task_type": "chat|recall|analyze|execute|delegate|schedule",
  "needs_external_knowledge": true|false,
  "needs_tool": true|false,
  "needs_scheduling": true|false,
  "candidate_agents": [],
  "confidence": 0-1,
  "confidence_by_dimension": {"subject": 0-1, "taskType": 0-1, "memoryTarget": 0-1, "action": 0-1, "entityHints": 0-1, "topicShift": 0-1, "richIntent": 0-1},
  "evidence": [],
  "semantic_evidence": {
    "personalContext": {"present": true|false, "reason": "", "span": ""},
    "memoryRecall": {"present": true|false, "target": "conversation_history|user_memory|external_past_event|current_context_reference|none", "reason": "", "span": ""},
    "actionRequest": {"present": true|false, "action": "read|write|run|schedule|delegate|none", "object": ""},
    "entityHints": {"tickers": [], "technicalTerms": [], "peopleOrCompanies": []}
  },
  "rich_intent": {
    "userGoal": "",
    "domain": "task_management|memory_management|code_modification|system_control|general_chat|external_knowledge|investment_analysis|unknown",
    "action": "create|read|update|delete|list|append|rename|pause|resume|cancel|send|resend|forward|retry|forget|consolidate|execute|schedule|answer|analyze|delegate|recall",
    "targets": [{"type": "memory|file|code|external_entity|agent|task|channel|calendar|current_context", "value": ""}],
    "contextDependency": {"recentConversation": true|false, "longTermMemory": true|false, "localWorkspace": true|false, "externalWorld": true|false},
    "ambiguity": [{"field": "", "reason": "", "severity": "low|medium|high"}],
    "riskLevel": "low|medium|high"
  },
  "intent_steps": [
    {"id": "step-1", "type": "chat|recall|analyze|execute|delegate|schedule", "action": "", "target": "", "operation": {"domain": "task_management|memory_management|code_modification|system_control|general_chat|external_knowledge|investment_analysis|unknown", "action": "create|read|update|delete|list|append|rename|pause|resume|cancel|send|resend|forward|retry|forget|consolidate|execute|schedule|answer|analyze|delegate|recall", "target_type": "memory|file|code|external_entity|agent|task|channel|calendar|current_context", "target": "", "target_id": "", "selector": "", "scope": "current_session|long_term|workspace|external|scheduled_tasks|channel", "risk_level": "low|medium|high"}, "depends_on": [], "requires_confirmation": false, "risk_level": "low|medium|high"}
  ],
  "time_window_days": null,
  "date_from": null,
  "date_to": null,
  "history_topic": "",
  "new_topic": "",
  "topic_analysis": {
    "history": {"label": "", "evidence": [], "source_turns": [], "confidence": 0-1},
    "current": {"label": "", "evidence": [], "source_turns": [0], "confidence": 0-1},
    "relation": "same_topic|subtopic|adjacent_topic|new_topic|current_context_reference|unknown",
    "relation_reason": "",
    "confidence": 0-1
  },
  "references_recent_history": true|false,
  "topic_shifted": true|false
}
`.trim();
}

function parseJsonObjectMatching<T>(
  raw: string,
  predicate: (value: unknown) => value is T,
): T {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (predicate(parsed)) {
      return parsed;
    }
    if (typeof parsed === "string" && parsed !== stripped) {
      return parseJsonObjectMatching(parsed, predicate);
    }
  } catch {
    // Fall back to scanning for the first valid object embedded in text.
  }

  for (
    let start = stripped.indexOf("{");
    start !== -1;
    start = stripped.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < stripped.length; index += 1) {
      const char = stripped[index];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;

      if (depth === 0) {
        const candidate = stripped.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (predicate(parsed)) {
            return parsed;
          }
        } catch {
          break;
        }
      }
    }
  }

  throw new Error("No valid JSON object in intent response");
}

function parseJsonObject(raw: string): RawIntentModelResult {
  return parseJsonObjectMatching(raw, isLikelyIntentModelResult);
}

function parseMemoryTargetObject(raw: string): RawMemoryTargetResult {
  return parseJsonObjectMatching(raw, isLikelyMemoryTargetResult);
}

function parseEntityHintsObject(raw: string): RawEntityHintsResult {
  return parseJsonObjectMatching(raw, isLikelyEntityHintsResult);
}

function buildIntentRepairPrompt(raw: string): string {
  return `
The text below was intended to be the raw JSON object for Jarvis intent routing,
but it is not valid JSON.

Repair it into one valid raw JSON object. Preserve the original meaning as much
as possible. Do not add markdown, comments, or explanations.

Required top-level fields:
knowledge_score, operation_score, complexity_score, complexity_reasoning,
query_subject, task_type, needs_external_knowledge, needs_tool,
needs_scheduling, candidate_agents, confidence, evidence, semantic_evidence,
confidence_by_dimension, rich_intent, intent_steps, topic_analysis, time_window_days,
date_from, date_to, history_topic, new_topic, references_recent_history,
topic_shifted.

Required semantic_evidence shape:
{
  "personalContext": {"present": true|false, "reason": "", "span": ""},
  "memoryRecall": {"present": true|false, "target": "conversation_history"|"user_memory"|"external_past_event"|"current_context_reference"|"none", "reason": "", "span": ""},
  "actionRequest": {"present": true|false, "action": "read"|"write"|"run"|"schedule"|"delegate"|"none", "object": ""},
  "entityHints": {"tickers": [], "technicalTerms": [], "peopleOrCompanies": []}
}

Required confidence_by_dimension shape:
{"subject": 0-1, "taskType": 0-1, "memoryTarget": 0-1, "action": 0-1, "entityHints": 0-1, "topicShift": 0-1, "richIntent": 0-1}

Required rich_intent shape:
{
  "userGoal": "",
  "domain": "task_management"|"memory_management"|"code_modification"|"system_control"|"general_chat"|"external_knowledge"|"investment_analysis"|"unknown",
  "action": "create"|"read"|"update"|"delete"|"list"|"append"|"rename"|"pause"|"resume"|"cancel"|"send"|"resend"|"forward"|"retry"|"forget"|"consolidate"|"execute"|"schedule"|"answer"|"analyze"|"delegate"|"recall",
  "targets": [{"type": "memory"|"file"|"code"|"external_entity"|"agent"|"task"|"channel"|"calendar"|"current_context", "value": ""}],
  "contextDependency": {"recentConversation": true|false, "longTermMemory": true|false, "localWorkspace": true|false, "externalWorld": true|false},
  "ambiguity": [{"field": "", "reason": "", "severity": "low"|"medium"|"high"}],
  "riskLevel": "low"|"medium"|"high"
}

Required intent_steps shape:
[
  {"id": "step-1", "type": "chat"|"recall"|"analyze"|"execute"|"delegate"|"schedule", "action": "", "target": "", "operation": {"domain": "task_management"|"memory_management"|"code_modification"|"system_control"|"general_chat"|"external_knowledge"|"investment_analysis"|"unknown", "action": "create"|"read"|"update"|"delete"|"list"|"append"|"rename"|"pause"|"resume"|"cancel"|"send"|"resend"|"forward"|"retry"|"forget"|"consolidate"|"execute"|"schedule"|"answer"|"analyze"|"delegate"|"recall", "target_type": "memory"|"file"|"code"|"external_entity"|"agent"|"task"|"channel"|"calendar"|"current_context", "target": "", "target_id": "", "selector": "", "scope": "current_session"|"long_term"|"workspace"|"external"|"scheduled_tasks"|"channel", "risk_level": "low"|"medium"|"high"}, "depends_on": [], "requires_confirmation": false, "risk_level": "low"|"medium"|"high"}
]

Required topic_analysis shape:
{
  "history": {"label": "", "evidence": [], "source_turns": [], "confidence": 0-1},
  "current": {"label": "", "evidence": [], "source_turns": [0], "confidence": 0-1},
  "relation": "same_topic"|"subtopic"|"adjacent_topic"|"new_topic"|"current_context_reference"|"unknown",
  "relation_reason": "",
  "confidence": 0-1
}

Invalid JSON text:
${raw}
`.trim();
}

function buildMemoryTargetPrompt(
  prompt: string,
  history: ConversationTurn[],
): string {
  const historySection =
    history.length > 0
      ? `\nRecent conversation:\n${history
          .slice(-6)
          .map((turn) => `${turn.role}: ${turn.content.slice(0, 200)}`)
          .join("\n")}\n`
      : "";

  return `
Classify only the memory reference target for the user request.

Targets:
- "conversation_history": asks what the user and Jarvis discussed before.
- "user_memory": asks about stored user facts, preferences, goals, or personal history.
- "external_past_event": asks about a past outside-world event, such as a product launch, earnings report, news event, sports result, or public historical event.
- "current_context_reference": refers to the current/recent conversation, such as "this", "that", "continue", "刚才", "这个".
- "none": no memory recall target.

Return ONLY JSON:
{"present": true|false, "target": "conversation_history"|"user_memory"|"external_past_event"|"current_context_reference"|"none", "reason": "<short reason>", "span": "<text span or empty>"}
${historySection}
User request: ${prompt}
`.trim();
}

function buildEntityHintsPrompt(prompt: string): string {
  return `
Classify only entity hints for the user request.

Rules:
- tickers: likely stock ticker symbols only, such as NVDA, GOOGL, AAPL, MSFT, TSLA.
- technicalTerms: technical acronyms, tools, protocols, libraries, or model names, such as ONNX, RAG, API, JSON, HTTP, LLM, SDK.
- peopleOrCompanies: company, product, project, or person names written as natural names, such as Apple, Nvidia, OpenAI.
- Do not put technical acronyms in tickers.

Return ONLY JSON:
{"tickers": [], "technicalTerms": [], "peopleOrCompanies": []}

User request: ${prompt}
`.trim();
}

function shouldRefineMemoryTarget(
  prompt: string,
  parsedTaskType: unknown,
  memoryRecall: IntentEvidence["memoryRecall"],
): boolean {
  if (memoryRecall.target !== "none") return false;
  const rawTaskType =
    typeof parsedTaskType === "string" ? parsedTaskType.toLowerCase() : "";
  return (
    rawTaskType === "recall" ||
    memoryRecall.present ||
    /上次|去年|前年|刚才|last time|previous event|previous earnings|earlier today/i.test(
      prompt,
    )
  );
}

function shouldRefineEntityHints(
  prompt: string,
  entityHints: IntentEvidence["entityHints"],
): boolean {
  const hasHints =
    entityHints.tickers.length > 0 ||
    entityHints.technicalTerms.length > 0 ||
    entityHints.peopleOrCompanies.length > 0;
  if (hasHints) return false;
  return (
    ENTITY_REFINEMENT_CUE_RE.test(prompt) &&
    (INVESTMENT_ANALYSIS_CUE_RE.test(prompt) ||
      new RegExp(TICKER_RE, "g").test(prompt))
  );
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

function normalizeNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function normalizeConfidence(value: unknown): number {
  const confidence = Number(value);
  if (Number.isNaN(confidence)) return 0.5;
  return Math.max(0, Math.min(1, confidence));
}

function maxConfidence(...values: number[]): number {
  return Math.max(...values.map((value) => normalizeConfidence(value)));
}

function minConfidence(...values: number[]): number {
  return Math.min(...values.map((value) => normalizeConfidence(value)));
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

function normalizeTopicRelation(value: unknown): TopicRelation {
  if (
    value === "same_topic" ||
    value === "subtopic" ||
    value === "adjacent_topic" ||
    value === "new_topic" ||
    value === "current_context_reference" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function normalizeGroundedTopic(
  value: unknown,
  fallbackLabel: string,
  fallbackSourceTurns: number[],
): GroundedTopic {
  const record = asRecord(value);
  return {
    label: normalizeOptionalString(record.label) ?? fallbackLabel,
    evidence: normalizeStringArray(record.evidence),
    sourceTurns:
      normalizeNumberArray(record.source_turns).length > 0
        ? normalizeNumberArray(record.source_turns)
        : fallbackSourceTurns,
    confidence: normalizeConfidence(record.confidence ?? 0.5),
  };
}

function hasWeakGrounding(topic: GroundedTopic): boolean {
  return topic.label.trim().length > 0 && topic.evidence.length === 0;
}

function appendUniqueEvidence(target: string[], candidates: string[]): void {
  const seen = new Set(target.map((item) => item.toLowerCase()));
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    target.push(trimmed);
    seen.add(key);
  }
}

function normalizeTopicAnalysis(args: {
  value: unknown;
  legacyHistoryTopic?: string;
  legacyNewTopic?: string;
  prompt: string;
  recentTurns: ConversationTurn[];
  referencesRecentHistory: boolean;
  topicShifted: boolean;
  recentHistoryLength: number;
}): TopicAnalysis {
  const root = asRecord(args.value);
  const rawRelation = normalizeTopicRelation(root.relation);
  const relation = args.referencesRecentHistory
    ? "current_context_reference"
    : rawRelation === "current_context_reference"
      ? args.recentHistoryLength > 0
        ? "adjacent_topic"
        : "unknown"
      : rawRelation;
  const history = normalizeGroundedTopic(
    root.history,
    normalizeOptionalString(args.legacyHistoryTopic) ?? "",
    args.recentHistoryLength > 0 ? [-1] : [],
  );
  const current = normalizeGroundedTopic(
    root.current,
    normalizeOptionalString(args.legacyNewTopic) ?? "",
    [0],
  );
  if (args.recentTurns.length > 0) {
    const sourceIndexes =
      history.sourceTurns.length > 0 ? history.sourceTurns : [-1];
    appendUniqueEvidence(
      history.evidence,
      sourceIndexes.flatMap((sourceTurn) => {
        const index =
          sourceTurn < 0 ? args.recentTurns.length + sourceTurn : sourceTurn;
        const turn = args.recentTurns[index];
        return turn?.content ? [turn.content.slice(0, 160)] : [];
      }),
    );
    appendUniqueEvidence(
      history.evidence,
      args.recentTurns.map((turn) => turn.content.slice(0, 160)),
    );
  }
  appendUniqueEvidence(current.evidence, [args.prompt.slice(0, 160)]);
  const lowGrounding = hasWeakGrounding(history) || hasWeakGrounding(current);

  return {
    history,
    current,
    relation:
      relation === "unknown" && args.topicShifted
        ? "new_topic"
        : relation === "unknown" && args.referencesRecentHistory
          ? "current_context_reference"
          : relation === "unknown" && args.recentHistoryLength > 0
            ? "adjacent_topic"
            : relation,
    relationReason: normalizeOptionalString(root.relation_reason) ?? "",
    confidence: normalizeConfidence(root.confidence ?? 0.5),
    lowGrounding,
  };
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
  const action = normalizeActionRequestType(actionRequest.action);
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
      present: actionRequest.present === true || action !== "none",
      action,
      object: normalizeOptionalString(actionRequest.object),
    },
    entityHints: {
      tickers: normalizeStringArray(entityHints.tickers),
      technicalTerms: normalizeStringArray(entityHints.technicalTerms),
      peopleOrCompanies: normalizeStringArray(entityHints.peopleOrCompanies),
    },
  };
}

function normalizeConfidenceByDimension(
  value: unknown,
  fallback: number,
): IntentConfidenceByDimension {
  const root = asRecord(value);
  return {
    subject: normalizeConfidence(root.subject ?? fallback),
    taskType: normalizeConfidence(root.taskType ?? fallback),
    memoryTarget: normalizeConfidence(root.memoryTarget ?? fallback),
    action: normalizeConfidence(root.action ?? fallback),
    entityHints: normalizeConfidence(root.entityHints ?? fallback),
    topicShift: normalizeConfidence(root.topicShift ?? fallback),
    richIntent: normalizeConfidence(root.richIntent ?? fallback),
  };
}

function normalizeRichIntentTargetType(
  value: unknown,
): RichIntentTargetType | null {
  if (
    value === "memory" ||
    value === "file" ||
    value === "code" ||
    value === "external_entity" ||
    value === "agent" ||
    value === "task" ||
    value === "channel" ||
    value === "calendar" ||
    value === "current_context"
  ) {
    return value;
  }
  return null;
}

function normalizeRichIntentRiskLevel(value: unknown): RichIntentRiskLevel {
  return value === "medium" || value === "high" ? value : "low";
}

function normalizeIntentStepType(value: unknown): IntentTaskType | null {
  const taskType = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_TASK_TYPES.has(taskType as IntentTaskType)
    ? (taskType as IntentTaskType)
    : null;
}

function fallbackOperationForStep(args: {
  type: IntentTaskType;
  actionText: string;
  targetText: string;
  riskLevel: RichIntentRiskLevel;
}): IntentStep["operation"] {
  const domain: RichIntentDomain =
    args.type === "schedule"
      ? "task_management"
      : args.type === "recall"
        ? "memory_management"
        : args.type === "execute"
          ? "code_modification"
          : args.type === "delegate"
            ? "general_chat"
            : args.type === "analyze"
              ? "external_knowledge"
              : "general_chat";
  const action: RichIntentAction =
    args.type === "schedule"
      ? /delete|remove|cancel|取消|删除|撤销/i.test(
          `${args.actionText} ${args.targetText}`,
        )
        ? "delete"
        : "create"
      : args.type === "recall"
        ? "recall"
        : args.type === "analyze"
          ? "analyze"
          : args.type === "delegate"
            ? "delegate"
            : args.type === "execute"
              ? /create|新增|创建|生成/.test(args.actionText)
                ? "create"
                : /delete|remove|删除/.test(args.actionText)
                  ? "delete"
                  : "update"
              : "answer";
  const targetType: RichIntentTargetType =
    args.type === "schedule"
      ? "task"
      : args.type === "recall"
        ? "memory"
        : args.type === "delegate"
          ? "agent"
          : args.type === "execute"
            ? "file"
            : args.type === "analyze"
              ? "external_entity"
              : "current_context";
  return defaultOperationForStep({
    type: args.type,
    targetText: args.targetText,
    domain,
    action,
    targetType,
    riskLevel: args.riskLevel,
  });
}

function normalizeIntentStepOperation(
  value: unknown,
  fallback: {
    type: IntentTaskType;
    actionText: string;
    targetText: string;
    riskLevel: RichIntentRiskLevel;
  },
): IntentStep["operation"] {
  const record = asRecord(value) as RawIntentStepOperation;
  const fallbackOperation = fallbackOperationForStep(fallback);
  const domain = normalizeRichIntentDomain(record.domain);
  const action = normalizeRichIntentAction(record.action);
  const targetType = normalizeRichIntentTargetType(record.target_type);
  return {
    domain: domain === "unknown" ? fallbackOperation.domain : domain,
    action: action === "answer" ? fallbackOperation.action : action,
    targetType: targetType ?? fallbackOperation.targetType,
    target:
      normalizeOptionalString(record.target) ??
      fallback.targetText ??
      fallbackOperation.target,
    targetId: normalizeOptionalString(record.target_id),
    selector: normalizeOptionalString(record.selector) ?? fallback.targetText,
    scope:
      normalizeIntentOperationScope(record.scope) ?? fallbackOperation.scope,
    riskLevel: normalizeRichIntentRiskLevel(record.risk_level),
  };
}

function normalizeIntentSteps(value: unknown): IntentStep[] {
  if (!Array.isArray(value)) return [];

  const steps: IntentStep[] = [];
  const items = value as any[];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const record = asRecord(item);
    const type = normalizeIntentStepType(record.type);
    if (!type) continue;

    const action = normalizeOptionalString(record.action) ?? type;
    const target = normalizeOptionalString(record.target) ?? "";
    const riskLevel = normalizeRichIntentRiskLevel(record.risk_level);
    steps.push({
      id: normalizeOptionalString(record.id) ?? `step-${index + 1}`,
      type,
      action,
      target,
      operation: normalizeIntentStepOperation(record.operation, {
        type,
        actionText: action,
        targetText: target,
        riskLevel,
      }),
      dependsOn: normalizeStringArray(record.depends_on),
      requiresConfirmation: record.requires_confirmation === true,
      riskLevel,
    });
  }

  return steps;
}

function normalizeRichIntentTargets(value: unknown): RichIntent["targets"] {
  if (!Array.isArray(value)) return [];
  const targets: RichIntent["targets"] = [];
  for (const item of value) {
    const record = asRecord(item);
    const type = normalizeRichIntentTargetType(record.type);
    const targetValue = normalizeOptionalString(record.value);
    if (type && targetValue) {
      targets.push({ type, value: targetValue });
    }
  }
  return targets;
}

function normalizeRichIntentAmbiguity(value: unknown): RichIntent["ambiguity"] {
  if (!Array.isArray(value)) return [];
  const ambiguity: RichIntent["ambiguity"] = [];
  for (const item of value) {
    const record = asRecord(item);
    const field = normalizeOptionalString(record.field);
    const reason = normalizeOptionalString(record.reason);
    const severity = normalizeRichIntentRiskLevel(record.severity);
    if (field && reason) {
      ambiguity.push({ field, reason, severity });
    }
  }
  return ambiguity;
}

function dedupeRichIntentTargets(
  targets: RichIntent["targets"],
): RichIntent["targets"] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.type}:${target.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeRichIntentDomain(value: unknown): RichIntentDomain {
  if (
    value === "task_management" ||
    value === "memory_management" ||
    value === "code_modification" ||
    value === "system_control" ||
    value === "general_chat" ||
    value === "external_knowledge" ||
    value === "investment_analysis" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function normalizeRichIntentAction(value: unknown): RichIntentAction {
  if (
    value === "create" ||
    value === "read" ||
    value === "update" ||
    value === "delete" ||
    value === "list" ||
    value === "append" ||
    value === "rename" ||
    value === "pause" ||
    value === "resume" ||
    value === "cancel" ||
    value === "send" ||
    value === "resend" ||
    value === "forward" ||
    value === "retry" ||
    value === "forget" ||
    value === "consolidate" ||
    value === "execute" ||
    value === "schedule" ||
    value === "answer" ||
    value === "analyze" ||
    value === "delegate" ||
    value === "recall"
  ) {
    return value;
  }
  return "answer";
}

function normalizeIntentOperationScope(
  value: unknown,
): IntentStep["operation"]["scope"] {
  if (
    value === "current_session" ||
    value === "long_term" ||
    value === "workspace" ||
    value === "external" ||
    value === "scheduled_tasks" ||
    value === "channel"
  ) {
    return value;
  }
  return undefined;
}

function deriveRichIntentTargets(args: {
  prompt: string;
  semanticEvidence: IntentEvidence;
  candidateAgents: string[];
  taskType: IntentTaskType;
  referencesRecentHistory: boolean;
}): RichIntent["targets"] {
  const targets: RichIntent["targets"] = [];
  const {
    prompt,
    semanticEvidence,
    candidateAgents,
    taskType,
    referencesRecentHistory,
  } = args;

  if (
    semanticEvidence.memoryRecall.target === "conversation_history" ||
    semanticEvidence.memoryRecall.target === "user_memory"
  ) {
    targets.push({
      type: "memory",
      value: semanticEvidence.memoryRecall.target,
    });
  }
  if (
    referencesRecentHistory ||
    semanticEvidence.memoryRecall.target === "current_context_reference"
  ) {
    targets.push({ type: "current_context", value: "recent_conversation" });
  }
  for (const ticker of semanticEvidence.entityHints.tickers) {
    targets.push({ type: "external_entity", value: ticker });
  }
  for (const name of semanticEvidence.entityHints.peopleOrCompanies) {
    targets.push({ type: "external_entity", value: name });
  }
  for (const term of semanticEvidence.entityHints.technicalTerms) {
    targets.push({ type: "code", value: term });
  }
  if (semanticEvidence.actionRequest.object) {
    const type = /微信|飞书|wechat|weixin|feishu|lark|channel/i.test(
      semanticEvidence.actionRequest.object,
    )
      ? "channel"
      : /提醒|任务|reminder|task|schedule|定时/i.test(
            semanticEvidence.actionRequest.object,
          )
        ? "task"
        : /test|测试|用例|code|router|resolver|\.ts|\.js|file|文件/i.test(
              semanticEvidence.actionRequest.object,
            )
          ? "code"
          : "file";
    targets.push({ type, value: semanticEvidence.actionRequest.object });
  }
  if (taskType === "schedule") {
    targets.push({ type: "task", value: "reminder" });
  }
  if (/微信|wechat|weixin/i.test(prompt)) {
    targets.push({ type: "channel", value: "wechat" });
  }
  if (/飞书|feishu|lark/i.test(prompt)) {
    targets.push({ type: "channel", value: "feishu" });
  }
  for (const agent of candidateAgents) {
    targets.push({ type: "agent", value: agent });
  }

  return dedupeRichIntentTargets(targets);
}

function buildRichIntent(args: {
  prompt: string;
  parsedRichIntent: RawIntentModelResult["rich_intent"];
  taskType: IntentTaskType;
  subject: QuerySubject;
  needsMemory: boolean;
  needsExternalKnowledge: boolean;
  needsTool: boolean;
  candidateAgents: string[];
  referencesRecentHistory: boolean;
  confidence: number;
  semanticEvidence: IntentEvidence;
}): RichIntent {
  const parsed = asRecord(args.parsedRichIntent);
  const parsedContext = asRecord(parsed.contextDependency);

  const fallbackDomain: RichIntentDomain =
    args.taskType === "schedule"
      ? "task_management"
      : args.taskType === "recall"
        ? "memory_management"
        : args.taskType === "execute"
          ? /forget|记忆|memory|保存的信息|偏好/i.test(args.prompt)
            ? "memory_management"
            : /发到|推送到|发给|send to|push to|forward to|微信|飞书|wechat|feishu/i.test(
                  args.prompt,
                )
              ? "task_management"
              : args.semanticEvidence.actionRequest.action === "run"
                ? "system_control"
                : "code_modification"
          : INVESTMENT_ANALYSIS_CUE_RE.test(args.prompt)
            ? "investment_analysis"
            : "general_chat";

  const fallbackAction: RichIntentAction =
    args.taskType === "recall"
      ? "recall"
      : args.taskType === "analyze"
        ? "analyze"
        : args.taskType === "schedule"
          ? /delete|remove|删除|撤销|取消/i.test(args.prompt)
            ? "delete"
            : "create"
          : args.taskType === "delegate"
            ? "delegate"
            : args.taskType === "execute"
              ? /forget|删除.*记忆|删掉.*记忆|忘记/i.test(args.prompt)
                ? "forget"
                : /发到|推送到|发给|send to|push to|forward to/i.test(
                      args.prompt,
                    )
                  ? "send"
                  : args.semanticEvidence.actionRequest.action === "run"
                    ? "execute"
                    : /create|新增|创建|生成/i.test(args.prompt)
                      ? "create"
                      : /delete|remove|删除/i.test(args.prompt)
                        ? "delete"
                        : "update"
              : "answer";

  const domain = normalizeRichIntentDomain(parsed.domain ?? fallbackDomain);
  const action = normalizeRichIntentAction(parsed.action ?? fallbackAction);

  // Backward compatibility: map RichIntentAction back to RichIntentPrimaryAction
  let primaryAction: RichIntentPrimaryAction = "answer";
  if (action === "recall") primaryAction = "recall";
  else if (action === "analyze") primaryAction = "analyze";
  else if (action === "schedule") primaryAction = "schedule";
  else if (action === "delegate") primaryAction = "delegate";
  else if (
    action === "execute" ||
    action === "update" ||
    action === "create" ||
    action === "delete"
  ) {
    primaryAction =
      args.semanticEvidence.actionRequest.action === "run" ||
      action === "execute"
        ? "run"
        : "modify";
  }

  const derivedTargets = deriveRichIntentTargets({
    prompt: args.prompt,
    semanticEvidence: args.semanticEvidence,
    candidateAgents: args.candidateAgents,
    taskType: args.taskType,
    referencesRecentHistory: args.referencesRecentHistory,
  });
  const targets = dedupeRichIntentTargets([
    ...normalizeRichIntentTargets(parsed.targets),
    ...derivedTargets,
  ]);
  const ambiguity = normalizeRichIntentAmbiguity(parsed.ambiguity);
  if (args.confidence < LOW_CONFIDENCE_THRESHOLD) {
    ambiguity.push({
      field: "subject",
      reason: "low confidence local intent classification",
      severity: "medium",
    });
  }

  return {
    userGoal: normalizeOptionalString(parsed.userGoal) ?? args.prompt,
    domain,
    action,
    primaryAction,
    targets,
    contextDependency: {
      recentConversation:
        parsedContext.recentConversation === true ||
        args.referencesRecentHistory,
      longTermMemory:
        parsedContext.longTermMemory === true ||
        args.needsMemory ||
        args.semanticEvidence.memoryRecall.target === "conversation_history" ||
        args.semanticEvidence.memoryRecall.target === "user_memory",
      localWorkspace:
        parsedContext.localWorkspace === true ||
        args.needsTool ||
        args.semanticEvidence.actionRequest.action === "write" ||
        args.semanticEvidence.actionRequest.action === "run",
      externalWorld:
        parsedContext.externalWorld === true ||
        args.needsExternalKnowledge ||
        args.subject === "external" ||
        args.subject === "mixed",
    },
    ambiguity,
    riskLevel:
      normalizeRichIntentRiskLevel(parsed.riskLevel) !== "low"
        ? normalizeRichIntentRiskLevel(parsed.riskLevel)
        : args.needsTool || args.taskType === "delegate"
          ? "medium"
          : "low",
  };
}

function buildStepTarget(
  richIntent: RichIntent,
  fallback: string,
  type?: RichIntentTargetType,
): string {
  const matchingTarget = type
    ? richIntent.targets.find((target) => target.type === type)
    : richIntent.targets[0];
  return matchingTarget?.value || richIntent.userGoal || fallback;
}

const INTENT_STEP_TYPE_ORDER: IntentTaskType[] = [
  "recall",
  "analyze",
  "delegate",
  "execute",
  "schedule",
  "chat",
];

function dedupeIntentSteps(steps: IntentStep[]): IntentStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = `${step.type}:${step.operation.domain}:${step.operation.action}:${step.operation.targetType}:${step.target.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeIntentStepOrder(steps: IntentStep[]): IntentStep[] {
  const idMap = new Map(
    steps.map((step, index) => [step.id, `step-${index + 1}`]),
  );

  return steps.map((step, index) => {
    const id = `step-${index + 1}`;
    const previousId = index > 0 ? `step-${index}` : null;
    const normalizedDependsOn = step.dependsOn
      .map((dependency) => idMap.get(dependency) ?? dependency)
      .filter((dependency) => dependency !== id);
    const dependsOn =
      normalizedDependsOn.length > 0
        ? normalizedDependsOn
        : previousId
          ? [previousId]
          : [];
    return {
      ...step,
      id,
      dependsOn,
    };
  });
}

function topologicalIntentStepOrder(steps: IntentStep[]): IntentStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: IntentStep[] = [];

  const visit = (step: IntentStep) => {
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) return;
    visiting.add(step.id);
    for (const dependency of step.dependsOn) {
      const dependencyStep = byId.get(dependency);
      if (dependencyStep) visit(dependencyStep);
    }
    visiting.delete(step.id);
    visited.add(step.id);
    ordered.push(step);
  };

  for (const step of steps) {
    visit(step);
  }

  return ordered;
}

function enforceRecallPrerequisite(
  steps: IntentStep[],
  enabled: boolean,
): IntentStep[] {
  if (!enabled) return steps;
  const recallStep = steps.find((step) => step.type === "recall");
  if (!recallStep) return steps;
  return steps.map((step) => {
    if (step.id === recallStep.id || step.type === "recall") return step;
    if (step.dependsOn.includes(recallStep.id)) return step;
    if (step.dependsOn.length > 0) return step;
    return {
      ...step,
      dependsOn: [recallStep.id, ...step.dependsOn],
    };
  });
}

function enforceArtifactBeforeSchedule(steps: IntentStep[]): IntentStep[] {
  const executeIndex = steps.findIndex(
    (step) =>
      step.type === "execute" &&
      (step.operation.domain === "code_modification" ||
        step.operation.targetType === "file" ||
        step.operation.targetType === "code"),
  );
  const scheduleIndex = steps.findIndex((step) => step.type === "schedule");
  if (
    executeIndex === -1 ||
    scheduleIndex === -1 ||
    executeIndex < scheduleIndex
  ) {
    return steps;
  }

  const reordered = [...steps];
  const [executeStep] = reordered.splice(executeIndex, 1);
  const nextScheduleIndex = reordered.findIndex(
    (step) => step.type === "schedule",
  );
  reordered.splice(nextScheduleIndex, 0, executeStep);
  return reordered.map((step, index) => {
    if (index === 0) return { ...step, dependsOn: [] };
    const previous = reordered[index - 1];
    return {
      ...step,
      dependsOn: [previous.id],
    };
  });
}

function hasEquivalentIntentStep(
  steps: IntentStep[],
  type: IntentTaskType,
  action: string,
  target: string,
  operation?: IntentStep["operation"],
): boolean {
  const normalizedAction = action.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  return steps.some(
    (step) =>
      step.type === type &&
      (operation
        ? step.operation.domain === operation.domain &&
          step.operation.action === operation.action &&
          step.operation.targetType === operation.targetType &&
          step.operation.target.toLowerCase() === operation.target.toLowerCase()
        : step.action.toLowerCase() === normalizedAction &&
          step.target.toLowerCase() === normalizedTarget),
  );
}

function buildIntentStep(args: {
  index: number;
  type: IntentTaskType;
  action: string;
  target: string;
  operation?: IntentStep["operation"];
  dependsOn?: string[];
  requiresConfirmation?: boolean;
  riskLevel?: RichIntentRiskLevel;
}): IntentStep {
  const riskLevel = args.riskLevel ?? args.operation?.riskLevel ?? "low";
  return {
    id: `step-${args.index}`,
    type: args.type,
    action: args.action,
    target: args.target,
    operation:
      args.operation ??
      fallbackOperationForStep({
        type: args.type,
        actionText: args.action,
        targetText: args.target,
        riskLevel,
      }),
    dependsOn: args.dependsOn ?? [],
    requiresConfirmation: args.requiresConfirmation ?? false,
    riskLevel,
  };
}

function sortIntentSteps(steps: IntentStep[]): IntentStep[] {
  return [...steps].sort((left, right) => {
    const leftRank = INTENT_STEP_TYPE_ORDER.indexOf(left.type);
    const rightRank = INTENT_STEP_TYPE_ORDER.indexOf(right.type);
    const normalizedLeftRank =
      leftRank === -1 ? INTENT_STEP_TYPE_ORDER.length : leftRank;
    const normalizedRightRank =
      rightRank === -1 ? INTENT_STEP_TYPE_ORDER.length : rightRank;
    return normalizedLeftRank - normalizedRightRank;
  });
}

function inferStepOperation(args: {
  type: IntentTaskType;
  action: string;
  target: string;
  richIntent: RichIntent;
  semanticEvidence: IntentEvidence;
}): IntentStep["operation"] {
  let domain = args.richIntent.domain;
  let action = args.richIntent.action;
  let targetType: RichIntentTargetType =
    args.richIntent.targets[0]?.type ?? "current_context";

  if (args.type === "recall") {
    domain = "memory_management";
    action = "recall";
    targetType = "memory";
  } else if (args.type === "schedule") {
    domain = "task_management";
    action =
      args.richIntent.action === "delete" ||
      args.richIntent.action === "cancel" ||
      args.richIntent.action === "read" ||
      args.richIntent.action === "list" ||
      args.richIntent.action === "update"
        ? args.richIntent.action
        : "create";
    targetType = "task";
  } else if (args.type === "delegate") {
    domain = args.richIntent.domain;
    action = "delegate";
    targetType = "agent";
  } else if (args.type === "execute") {
    action =
      args.richIntent.action === "create" ||
      args.richIntent.action === "delete" ||
      args.richIntent.action === "append" ||
      args.richIntent.action === "rename" ||
      args.richIntent.action === "send" ||
      args.richIntent.action === "forward" ||
      args.richIntent.action === "update"
        ? args.richIntent.action
        : args.semanticEvidence.actionRequest.action === "run"
          ? "execute"
          : "update";
    targetType =
      args.richIntent.targets.some(
        (target) => target.type === "file" || target.type === "code",
      ) &&
      action !== "send" &&
      action !== "resend" &&
      action !== "forward" &&
      (action === "update" ||
        action === "append" ||
        action === "create" ||
        args.action.includes("artifact") ||
        args.action.includes("change"))
        ? (args.richIntent.targets.find(
            (target) => target.type === "file" || target.type === "code",
          )?.type ?? "file")
        : args.richIntent.domain === "memory_management"
          ? "memory"
          : action === "send" ||
              action === "resend" ||
              action === "forward" ||
              args.richIntent.targets.some(
                (target) => target.type === "channel",
              )
            ? "channel"
            : (args.richIntent.targets.find((target) =>
                ["memory", "file", "code", "channel", "task"].includes(
                  target.type,
                ),
              )?.type ?? "file");
    domain =
      targetType === "memory"
        ? "memory_management"
        : targetType === "channel"
          ? "task_management"
          : targetType === "task"
            ? "task_management"
            : action === "execute"
              ? "system_control"
              : "code_modification";
  } else if (args.type === "analyze") {
    action = "analyze";
    targetType =
      args.richIntent.targets.find(
        (target) => target.type === "external_entity",
      )?.type ?? "external_entity";
    domain =
      args.richIntent.domain === "investment_analysis"
        ? "investment_analysis"
        : "external_knowledge";
  } else if (args.type === "chat") {
    action = "answer";
    targetType = "current_context";
    domain = "general_chat";
  }

  return defaultOperationForStep({
    type: args.type,
    targetText: args.target,
    domain,
    action,
    targetType,
    riskLevel: args.richIntent.riskLevel,
  });
}

function deriveIntentSteps(args: {
  prompt: string;
  parsedIntentSteps: unknown;
  taskType: IntentTaskType;
  needsMemory: boolean;
  needsExternalKnowledge: boolean;
  needsScheduling: boolean;
  candidateAgents: string[];
  semanticEvidence: IntentEvidence;
  richIntent: RichIntent;
}): IntentStep[] {
  const parsedSteps = normalizeIntentSteps(args.parsedIntentSteps);
  const steps: IntentStep[] = [];
  const hasUsableParsedPlan = parsedSteps.length > 1;

  const append = (
    type: IntentTaskType,
    action: string,
    target: string,
    options: Partial<
      Omit<IntentStep, "id" | "type" | "action" | "target">
    > = {},
  ) => {
    const operation =
      options.operation ??
      inferStepOperation({
        type,
        action,
        target,
        richIntent: args.richIntent,
        semanticEvidence: args.semanticEvidence,
      });
    if (hasUsableParsedPlan && steps.some((step) => step.type === type)) {
      return;
    }
    if (hasEquivalentIntentStep(steps, type, action, target, operation)) return;
    steps.push(
      buildIntentStep({
        index: steps.length + 1,
        type,
        action,
        target,
        operation,
        dependsOn: options.dependsOn,
        requiresConfirmation: options.requiresConfirmation,
        riskLevel: options.riskLevel ?? operation.riskLevel,
      }),
    );
  };

  if (hasUsableParsedPlan) {
    steps.push(
      ...parsedSteps.map((step) => ({
        ...step,
        operation: inferStepOperation({
          type: step.type,
          action: step.action,
          target: step.target,
          richIntent: args.richIntent,
          semanticEvidence: args.semanticEvidence,
        }),
      })),
    );
  }

  const memoryRecallTarget = args.semanticEvidence.memoryRecall.target;
  const explicitMemoryStep =
    memoryRecallTarget === "conversation_history" ||
    memoryRecallTarget === "user_memory" ||
    memoryRecallTarget === "current_context_reference";
  const personalContextAnalysisStep =
    args.semanticEvidence.personalContext.present &&
    (args.needsExternalKnowledge || args.taskType === "analyze");
  if (explicitMemoryStep || personalContextAnalysisStep) {
    append(
      "recall",
      "retrieve relevant user context",
      buildStepTarget(args.richIntent, "user_context", "memory"),
    );
  }

  const hasExternalEntity =
    args.semanticEvidence.entityHints.tickers.length > 0 ||
    args.semanticEvidence.entityHints.peopleOrCompanies.length > 0 ||
    args.richIntent.targets.some((target) => target.type === "external_entity");
  if (
    args.needsExternalKnowledge ||
    args.taskType === "analyze" ||
    hasExternalEntity
  ) {
    append(
      "analyze",
      "analyze external/domain context",
      buildStepTarget(args.richIntent, args.prompt, "external_entity"),
    );
  }

  if (
    (args.taskType === "execute" ||
      args.semanticEvidence.actionRequest.action === "write" ||
      args.semanticEvidence.actionRequest.action === "run" ||
      hasActionCue(args.prompt) ||
      hasOutputArtifactCue(args.prompt)) &&
    (args.richIntent.domain !== "task_management" ||
      hasOutputArtifactCue(args.prompt) ||
      args.semanticEvidence.actionRequest.action === "write" ||
      args.richIntent.action === "send" ||
      args.richIntent.action === "forward" ||
      args.richIntent.action === "resend")
  ) {
    append(
      "execute",
      args.semanticEvidence.actionRequest.action === "run"
        ? "run requested operation"
        : "produce requested artifact or change",
      args.semanticEvidence.actionRequest.object ||
        buildStepTarget(args.richIntent, args.prompt),
      {
        dependsOn: steps.length > 0 ? [steps[steps.length - 1].id] : [],
        requiresConfirmation: args.richIntent.riskLevel === "high",
        riskLevel: args.richIntent.riskLevel,
      },
    );
  }

  if (
    args.taskType === "delegate" ||
    args.semanticEvidence.actionRequest.action === "delegate"
  ) {
    append(
      "delegate",
      "route to specialized agent when useful",
      args.candidateAgents[0] ?? buildStepTarget(args.richIntent, "agent"),
      {
        dependsOn: steps.length > 0 ? [steps[steps.length - 1].id] : [],
        requiresConfirmation: args.candidateAgents.length > 1,
        riskLevel: args.richIntent.riskLevel,
      },
    );
  }

  if (args.needsScheduling || args.taskType === "schedule") {
    const scheduleAction =
      args.richIntent.action === "delete" || args.richIntent.action === "cancel"
        ? "delete scheduled task"
        : args.richIntent.action === "read" || args.richIntent.action === "list"
          ? "list scheduled tasks"
          : args.richIntent.action === "update"
            ? "update scheduled task"
            : "schedule future follow-up";
    append(
      "schedule",
      scheduleAction,
      args.semanticEvidence.actionRequest.object ||
        buildStepTarget(args.richIntent, args.prompt, "task") ||
        args.prompt,
      {
        dependsOn: steps.length > 0 ? [steps[steps.length - 1].id] : [],
        requiresConfirmation: true,
        riskLevel: "medium",
      },
    );
  }

  if (steps.length === 0) {
    append(
      args.taskType,
      args.richIntent.primaryAction,
      buildStepTarget(args.richIntent, args.prompt),
      { riskLevel: args.richIntent.riskLevel },
    );
  }

  const deduped = enforceRecallPrerequisite(
    dedupeIntentSteps(steps),
    explicitMemoryStep || personalContextAnalysisStep,
  );
  const ordered = hasUsableParsedPlan
    ? enforceArtifactBeforeSchedule(topologicalIntentStepOrder(deduped))
    : sortIntentSteps(deduped);
  return normalizeIntentStepOrder(ordered);
}

function buildConfidenceByDimension(args: {
  parsedConfidenceByDimension: unknown;
  confidence: number;
  evidence: string[];
  subject: QuerySubject;
  taskType: IntentTaskType;
  semanticEvidence: IntentEvidence;
  referencesRecentHistory: boolean;
  recentHistoryLength: number;
  richIntent: RichIntent;
}): IntentConfidenceByDimension {
  const result = normalizeConfidenceByDimension(
    args.parsedConfidenceByDimension,
    args.confidence,
  );
  const evidence = new Set(args.evidence);
  const hasEvidencePrefix = (prefix: string) =>
    args.evidence.some((item) => item.startsWith(prefix));

  if (hasEvidencePrefix("invalid_subject:")) {
    result.subject = minConfidence(result.subject, 0.4);
  }
  if (evidence.has("low_confidence_external_subject")) {
    result.subject = minConfidence(result.subject, 0.6);
  }
  if (
    evidence.has("memory_recall_cue") ||
    evidence.has("personal_context_cue") ||
    evidence.has("personal_context_with_external_entity")
  ) {
    result.subject = maxConfidence(result.subject, 0.85);
  }
  if (evidence.has("external_past_event_not_recall")) {
    result.subject = maxConfidence(result.subject, 0.85);
    result.taskType = maxConfidence(result.taskType, 0.85);
  }

  if (
    evidence.has("schedule_cue") ||
    evidence.has("action_cue") ||
    evidence.has("delegate_action_cue") ||
    evidence.has("remember_to_action_not_recall")
  ) {
    result.taskType = maxConfidence(result.taskType, 0.9);
  }
  if (args.taskType === "execute" || args.taskType === "schedule") {
    result.action = maxConfidence(result.action, 0.85);
  }
  if (args.taskType === "delegate") {
    result.action = maxConfidence(result.action, 0.9);
  }

  if (args.semanticEvidence.memoryRecall.target !== "none") {
    result.memoryTarget = maxConfidence(result.memoryTarget, 0.85);
  }
  if (
    args.semanticEvidence.memoryRecall.target === "current_context_reference" ||
    args.referencesRecentHistory
  ) {
    result.memoryTarget = maxConfidence(result.memoryTarget, 0.9);
    result.topicShift = maxConfidence(result.topicShift, 0.9);
  }
  if (evidence.has("remember_to_action_not_recall")) {
    result.memoryTarget = maxConfidence(result.memoryTarget, 0.9);
    result.action = maxConfidence(result.action, 0.85);
  }

  const hasEntityHints =
    args.semanticEvidence.entityHints.tickers.length > 0 ||
    args.semanticEvidence.entityHints.technicalTerms.length > 0 ||
    args.semanticEvidence.entityHints.peopleOrCompanies.length > 0;
  if (hasEntityHints) {
    result.entityHints = maxConfidence(result.entityHints, 0.85);
  }
  if (evidence.has("investment_analysis_candidate")) {
    result.entityHints = maxConfidence(result.entityHints, 0.85);
  }

  if (args.recentHistoryLength === 0) {
    result.topicShift = maxConfidence(result.topicShift, 0.95);
  }
  if (evidence.has("topic_analysis_low_grounding")) {
    result.topicShift = minConfidence(result.topicShift, 0.55);
  }

  const hasTargets = args.richIntent.targets.length > 0;
  result.richIntent = hasTargets
    ? maxConfidence(result.richIntent, 0.8)
    : minConfidence(maxConfidence(result.richIntent, 0.65), 0.85);

  return result;
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

function buildFallbackRawIntentResult(prompt: string): RawIntentModelResult {
  const personalCue =
    hasPersonalContextCue(prompt) || hasUserPreferenceCue(prompt);
  const recallCue = hasMemoryRecallCue(prompt);
  const scheduleCue = hasScheduleCue(prompt);
  const action = inferActionRequestFromCue(prompt);
  const actionCue = action !== null && action !== "read";
  const taskType: IntentTaskType = scheduleCue
    ? "schedule"
    : recallCue
      ? "recall"
      : actionCue
        ? action === "delegate"
          ? "delegate"
          : "execute"
        : INVESTMENT_ANALYSIS_CUE_RE.test(prompt)
          ? "analyze"
          : "chat";
  const subject: QuerySubject =
    personalCue || recallCue ? "personal" : "external";
  const needsTool =
    taskType === "execute" ||
    taskType === "delegate" ||
    taskType === "schedule";

  return {
    knowledge_score: taskType === "chat" ? 30 : 60,
    operation_score: needsTool ? 55 : 25,
    complexity_score: needsTool ? 58 : 35,
    complexity_reasoning:
      "deterministic fallback after invalid local intent JSON",
    query_subject: subject,
    task_type: taskType,
    needs_external_knowledge: subject === "external" || taskType === "analyze",
    needs_tool: needsTool,
    needs_scheduling: taskType === "schedule",
    candidate_agents: [],
    confidence: 0.35,
    confidence_by_dimension: {
      subject: 0.45,
      taskType: 0.45,
      memoryTarget: recallCue ? 0.55 : 0.4,
      action: actionCue ? 0.55 : 0.4,
      entityHints: 0.3,
      topicShift: 0.3,
      richIntent: 0.35,
    },
    evidence: ["deterministic_parse_fallback"],
    semantic_evidence: {
      personalContext: {
        present: personalCue,
        reason: personalCue ? "deterministic personal/preference cue" : "",
        span: personalCue ? prompt : "",
      },
      memoryRecall: {
        present: recallCue,
        target: recallCue ? "user_memory" : "none",
        reason: recallCue ? "deterministic memory recall cue" : "",
        span: recallCue ? prompt : "",
      },
      actionRequest: {
        present: actionCue,
        action: action ?? "none",
        object: "",
      },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    rich_intent: {
      userGoal: prompt,
      domain:
        taskType === "schedule"
          ? "task_management"
          : taskType === "recall"
            ? "memory_management"
            : taskType === "execute"
              ? action === "run"
                ? "system_control"
                : "code_modification"
              : INVESTMENT_ANALYSIS_CUE_RE.test(prompt)
                ? "investment_analysis"
                : "general_chat",
      action:
        taskType === "recall"
          ? "recall"
          : taskType === "analyze"
            ? "analyze"
            : taskType === "schedule"
              ? /delete|remove|删除|撤销|取消/i.test(prompt)
                ? "delete"
                : "create"
              : taskType === "delegate"
                ? "delegate"
                : taskType === "execute"
                  ? action === "run"
                    ? "execute"
                    : "update"
                  : "answer",
      targets: recallCue ? [{ type: "memory", value: "user_memory" }] : [],
      contextDependency: {
        recentConversation: false,
        longTermMemory: recallCue || personalCue,
        localWorkspace: taskType === "execute",
        externalWorld: subject === "external" || taskType === "analyze",
      },
      ambiguity: [
        {
          field: "intent_json",
          reason: "local model output and repair were invalid",
          severity: "medium",
        },
      ],
      riskLevel: needsTool ? "medium" : "low",
    },
    intent_steps: [],
    time_window_days: null,
    date_from: null,
    date_to: null,
    history_topic: "",
    new_topic: prompt.slice(0, 80),
    topic_analysis: {
      history: {
        label: "",
        evidence: [],
        source_turns: [],
        confidence: 0.3,
      },
      current: {
        label: prompt.slice(0, 80),
        evidence: [prompt.slice(0, 160)],
        source_turns: [0],
        confidence: 0.5,
      },
      relation: "unknown",
      relation_reason: "deterministic fallback",
      confidence: 0.3,
    },
    references_recent_history: false,
    topic_shifted: false,
  };
}

export class IntentResolver {
  private readonly modelClient: IntentModelClient;

  constructor(private readonly options: IntentResolverOptions) {
    if (options.modelClient) {
      this.modelClient = options.modelClient;
      return;
    }
    if (!options.model) {
      throw new Error("IntentResolver requires either model or modelClient");
    }
    this.modelClient = new JarvisOllamaIntentModelClient({
      model: options.model,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
    });
  }

  private generateIntentJson(args: {
    prompt: string;
    timeoutMs?: number;
    contextWindow?: number;
    maxOutputTokens?: number;
  }): Promise<string> {
    return this.modelClient.generateJson({
      prompt: args.prompt,
      timeoutMs: args.timeoutMs ?? this.options.timeoutMs ?? 30_000,
      responseFormat: "json",
      contextWindow: args.contextWindow,
      maxOutputTokens: args.maxOutputTokens,
      temperature: 0,
    });
  }

  private async parseOrRepairJson(raw: string): Promise<RawIntentModelResult> {
    try {
      return parseJsonObject(raw);
    } catch (parseError: any) {
      console.error(
        `⚠️ [IntentResolver] Invalid intent JSON, attempting repair: ${parseError.message}`,
      );
      const repairedRaw = await this.generateIntentJson({
        prompt: buildIntentRepairPrompt(raw),
        contextWindow: 8192,
      });
      try {
        const parsed = parseJsonObject(repairedRaw);
        console.error(`✅ [IntentResolver] Intent JSON repair succeeded`);
        return parsed;
      } catch (repairError: any) {
        throw new Error(
          `Intent JSON parse failed; repair also failed. parse=${parseError.message}; repair=${repairError.message}`,
        );
      }
    }
  }

  private async refineMemoryTarget(
    prompt: string,
    history: ConversationTurn[],
    semanticEvidence: IntentEvidence,
    parsedTaskType: unknown,
  ): Promise<IntentEvidence> {
    if (
      !shouldRefineMemoryTarget(
        prompt,
        parsedTaskType,
        semanticEvidence.memoryRecall,
      )
    ) {
      return semanticEvidence;
    }

    try {
      const raw = await this.generateIntentJson({
        prompt: buildMemoryTargetPrompt(prompt, history),
        contextWindow: 4096,
      });
      const parsed = parseMemoryTargetObject(raw);
      const target = normalizeMemoryRecallTarget(parsed.target);
      if (target === "none" && parsed.present !== true) {
        return semanticEvidence;
      }
      console.error(`🧭 [IntentResolver] Focused memory target=${target}`);
      return {
        ...semanticEvidence,
        memoryRecall: {
          present: parsed.present === true || target !== "none",
          target,
          reason: normalizeOptionalString(parsed.reason) ?? "",
          span: normalizeOptionalString(parsed.span),
        },
      };
    } catch (error: any) {
      console.error(
        `⚠️ [IntentResolver] Focused memory-target extraction failed: ${error.message}`,
      );
      return semanticEvidence;
    }
  }

  private async refineEntityHints(
    prompt: string,
    semanticEvidence: IntentEvidence,
  ): Promise<IntentEvidence> {
    if (!shouldRefineEntityHints(prompt, semanticEvidence.entityHints)) {
      return semanticEvidence;
    }

    try {
      const raw = await this.generateIntentJson({
        prompt: buildEntityHintsPrompt(prompt),
        contextWindow: 4096,
      });
      const parsed = parseEntityHintsObject(raw);
      const entityHints = {
        tickers: normalizeStringArray(parsed.tickers),
        technicalTerms: normalizeStringArray(parsed.technicalTerms),
        peopleOrCompanies: normalizeStringArray(parsed.peopleOrCompanies),
      };
      console.error(
        `🏷️ [IntentResolver] Focused entity hints tickers=${entityHints.tickers.join(",") || "-"} technical=${entityHints.technicalTerms.join(",") || "-"}`,
      );
      return {
        ...semanticEvidence,
        entityHints,
      };
    } catch (error: any) {
      console.error(
        `⚠️ [IntentResolver] Focused entity extraction failed: ${error.message}`,
      );
      return semanticEvidence;
    }
  }

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
    const personalFactAssertionCue = hasPersonalFactAssertionCue(prompt);

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
    const raw = await this.generateIntentJson({
      prompt: fullPrompt,
      contextWindow: 8192,
    });
    let parsed: RawIntentModelResult;
    try {
      parsed = await this.parseOrRepairJson(raw);
    } catch (error: any) {
      console.error(
        `⚠️ [IntentResolver] Intent JSON parse and repair failed, using deterministic fallback: ${error.message}`,
      );
      parsed = buildFallbackRawIntentResult(prompt);
    }
    const confidence = normalizeConfidence(parsed.confidence);
    const policyTrace: IntentPolicyTraceEntry[] = [];
    const policyRegistry = createIntentPolicyRegistry({
      lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
      hasRememberToActionCue,
      hasPersonalFactAssertionCue,
      hasAnaphoricReference,
      hasMemoryRecallCue,
      hasConversationHistoryRecallCue,
      hasCurrentContextReferenceCue,
      inferActionRequestFromCue,
      normalizeInvestmentEntityHints,
      normalizeTechnicalEntityHints,
    });
    const memoryRefinedEvidence = await this.refineMemoryTarget(
      prompt,
      recentTurns,
      normalizeIntentEvidence(parsed.semantic_evidence),
      parsed.task_type,
    );
    let semanticEvidence = await this.refineEntityHints(
      prompt,
      memoryRefinedEvidence,
    );
    semanticEvidence = runIntentPolicyRules(
      { prompt, recentTurns, semanticEvidence },
      policyRegistry.semantic,
      policyTrace,
    ).semanticEvidence;
    let memoryRecallTarget = semanticEvidence.memoryRecall.target;
    const semanticRecallCue =
      semanticEvidence.memoryRecall.present &&
      (memoryRecallTarget === "conversation_history" ||
        memoryRecallTarget === "user_memory");
    const externalPastEventCue = memoryRecallTarget === "external_past_event";
    let currentContextReferenceCue =
      memoryRecallTarget === "current_context_reference";
    const semanticActionPresent = semanticEvidence.actionRequest.present;
    const personalCue =
      personalFactAssertionCue ||
      semanticEvidence.personalContext.present ||
      hasPersonalContextCue(prompt);
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
      hasActionCue(prompt) ||
      hasOutputArtifactCue(prompt);
    const explicitDelegateCue =
      (semanticActionPresent &&
        semanticEvidence.actionRequest.action === "delegate") ||
      hasExplicitDelegateCue(prompt);
    const investmentAnalysisCue = hasInvestmentAnalysisCue(
      prompt,
      semanticEvidence,
    );
    const recallWithExternalWork =
      recallCue &&
      semanticEvidence.memoryRecall.target !== "conversation_history" &&
      (semanticEvidence.entityHints.tickers.length > 0 ||
        semanticEvidence.entityHints.peopleOrCompanies.length > 0);
    const cues: IntentCueState = {
      semanticRecallCue,
      externalPastEventCue,
      currentContextReferenceCue,
      personalFactAssertionCue,
      personalCue,
      recallCue,
      scheduleCue,
      actionCue,
      explicitDelegateCue,
      investmentAnalysisCue,
      recallWithExternalWork,
    };

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

    const subjectState = runIntentPolicyRules(
      {
        subject,
        confidence,
        cues,
        semanticEvidence,
        hasModelExternalKnowledge: normalizeBoolean(
          parsed.needs_external_knowledge,
        ),
        evidence,
      },
      policyRegistry.subject,
      policyTrace,
    );
    subject = subjectState.subject;
    evidence.splice(0, evidence.length, ...subjectState.evidence);

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
    const taskState = runIntentPolicyRules(
      { taskType, cues, prompt, evidence },
      policyRegistry.task,
      policyTrace,
    );
    taskType = taskState.taskType;
    evidence.splice(0, evidence.length, ...taskState.evidence);

    let candidateAgents = normalizeStringArray(parsed.candidate_agents);
    const agentState = runIntentPolicyRules(
      {
        taskType,
        candidateAgents,
        cues,
        evidence,
        delegateDowngraded: false,
      },
      policyRegistry.agent,
      policyTrace,
    );
    taskType = agentState.taskType;
    candidateAgents = agentState.candidateAgents;
    const delegateDowngraded = agentState.delegateDowngraded;
    evidence.splice(0, evidence.length, ...agentState.evidence);

    const parsedTopicAnalysis = asRecord(parsed.topic_analysis);
    const rawTopicRelation = normalizeTopicRelation(
      parsedTopicAnalysis.relation,
    );
    const modelCurrentContextReference =
      parsed.references_recent_history === true ||
      rawTopicRelation === "current_context_reference";
    const lexicalCurrentContextCue = hasCurrentContextReferenceCue(prompt);
    const specificEntityTerms = collectSpecificEntityTerms(
      prompt,
      semanticEvidence,
    );
    const selfContainedEntityQuery = hasSelfContainedEntityQuery(
      prompt,
      semanticEvidence,
    );
    const shouldDowngradeCurrentContext =
      currentContextReferenceCue &&
      !anaphoric &&
      !lexicalCurrentContextCue &&
      selfContainedEntityQuery &&
      !recentHistoryContainsEntityTerms(recentTurns, specificEntityTerms);
    if (shouldDowngradeCurrentContext) {
      const beforeMemoryRecall = { ...semanticEvidence.memoryRecall };
      semanticEvidence = {
        ...semanticEvidence,
        memoryRecall: {
          present: false,
          target: "none",
          reason:
            "self-contained entity query does not require recent conversation context",
          span: prompt.slice(0, 160),
        },
      };
      memoryRecallTarget = "none";
      currentContextReferenceCue = false;
      policyTrace.push({
        ruleId: "topic.self_contained_entity_not_current_context",
        stage: "guardrail",
        priority: 430,
        reasonCode: "SELF_CONTAINED_ENTITY_NOT_CURRENT_CONTEXT",
        reason: normalizeIntentPolicyReason(
          "SELF_CONTAINED_ENTITY_NOT_CURRENT_CONTEXT",
        ),
        applied: true,
        before: {
          memoryRecall: beforeMemoryRecall,
          referencesRecentHistory: parsed.references_recent_history === true,
          relation: rawTopicRelation,
          entityTerms: specificEntityTerms,
        },
        after: {
          memoryRecall: semanticEvidence.memoryRecall,
          referencesRecentHistory: false,
          relation: "subtopic",
          entityTerms: specificEntityTerms,
        },
      });
      console.error(
        `🧭 [IntentResolver] Self-contained entity query; current-context reference downgraded to topic continuity`,
      );
    }
    const referencesRecentHistory =
      !personalFactAssertionCue &&
      recentTurns.length > 0 &&
      (anaphoric ||
        currentContextReferenceCue ||
        (modelCurrentContextReference && lexicalCurrentContextCue));
    if (currentContextReferenceCue) {
      console.error(
        `🔗 [IntentResolver] Semantic current-context reference detected — topic_shifted forced false`,
      );
    }
    const topicRelation = shouldDowngradeCurrentContext
      ? "subtopic"
      : personalFactAssertionCue
        ? "new_topic"
        : rawTopicRelation;
    // No history → topic shift is meaningless; force false to avoid spurious clears.
    let topicShifted =
      recentTurns.length === 0
        ? false
        : personalFactAssertionCue
          ? true
          : referencesRecentHistory
            ? false
            : topicRelation === "same_topic" || topicRelation === "subtopic"
              ? false
              : topicRelation === "adjacent_topic"
                ? false
                : topicRelation === "new_topic"
                  ? true
                  : parsed.topic_shifted === true;
    const broadTopicEntityDrilldown =
      !referencesRecentHistory &&
      topicShifted &&
      topicRelation === "new_topic" &&
      hasEntityStatusDrilldown(prompt, semanticEvidence) &&
      hasBroadTopicalHistory(recentTurns, parsedTopicAnalysis);
    if (broadTopicEntityDrilldown) {
      const beforeTopicShifted = topicShifted;
      topicShifted = false;
      policyTrace.push({
        ruleId: "topic.broad_topic_entity_drilldown",
        stage: "guardrail",
        priority: 410,
        reasonCode: "BROAD_TOPIC_ENTITY_DRILLDOWN",
        reason: normalizeIntentPolicyReason("BROAD_TOPIC_ENTITY_DRILLDOWN"),
        applied: true,
        before: {
          topicShifted: beforeTopicShifted,
          relation: topicRelation,
          entityTerms: specificEntityTerms,
        },
        after: {
          topicShifted,
          relation: "adjacent_topic",
          entityTerms: specificEntityTerms,
        },
      });
      console.error(
        `🧭 [IntentResolver] Broad-topic entity drilldown; topic_shifted forced false`,
      );
    }
    const previousRecallTarget = inferRecentRecallTarget(recentTurns);
    const memoryTargetChanged =
      !referencesRecentHistory &&
      previousRecallTarget !== null &&
      isRecallBoundaryTarget(previousRecallTarget) &&
      isRecallBoundaryTarget(memoryRecallTarget) &&
      previousRecallTarget !== memoryRecallTarget;
    if (memoryTargetChanged) {
      const beforeTopicShifted = topicShifted;
      topicShifted = true;
      policyTrace.push({
        ruleId: "topic.memory_target_changed",
        stage: "guardrail",
        priority: 420,
        reasonCode: "MEMORY_TARGET_TOPIC_SHIFT",
        reason: normalizeIntentPolicyReason("MEMORY_TARGET_TOPIC_SHIFT"),
        applied: true,
        before: {
          topicShifted: beforeTopicShifted,
          relation: topicRelation,
          previousMemoryTarget: previousRecallTarget,
          currentMemoryTarget: memoryRecallTarget,
          referencesRecentHistory,
        },
        after: {
          topicShifted,
          relation: "new_topic",
          previousMemoryTarget: previousRecallTarget,
          currentMemoryTarget: memoryRecallTarget,
          referencesRecentHistory,
        },
      });
      console.error(
        `🧭 [IntentResolver] Memory target changed ${previousRecallTarget} → ${memoryRecallTarget}; topic_shifted forced true`,
      );
    }
    let topicAnalysis = normalizeTopicAnalysis({
      value: parsed.topic_analysis,
      legacyHistoryTopic: parsed.history_topic,
      legacyNewTopic: parsed.new_topic,
      prompt,
      recentTurns,
      referencesRecentHistory,
      topicShifted,
      recentHistoryLength: recentTurns.length,
    });
    if (personalFactAssertionCue) {
      topicAnalysis = {
        ...topicAnalysis,
        current: {
          label: personalFactTopicLabel(prompt),
          evidence: [prompt.slice(0, 160)],
          sourceTurns: [0],
          confidence: Math.max(topicAnalysis.current.confidence, 0.9),
        },
        relation: recentTurns.length > 0 ? "new_topic" : "unknown",
        relationReason:
          "current request is a standalone personal fact assertion, not a follow-up to recent history",
        confidence: Math.max(topicAnalysis.confidence, 0.9),
        lowGrounding: false,
      };
    } else if (shouldDowngradeCurrentContext) {
      topicAnalysis = {
        ...topicAnalysis,
        relation:
          topicAnalysis.relation === "new_topic"
            ? "adjacent_topic"
            : "subtopic",
        relationReason:
          "current request is a self-contained entity query; recent history only provides topic continuity",
        confidence: Math.max(topicAnalysis.confidence, 0.85),
        lowGrounding: false,
      };
    } else if (broadTopicEntityDrilldown) {
      topicAnalysis = {
        ...topicAnalysis,
        relation: "adjacent_topic",
        relationReason:
          "current request drills into a specific entity after a broad topical roundup",
        confidence: Math.max(topicAnalysis.confidence, 0.85),
        lowGrounding: false,
      };
    } else if (memoryTargetChanged) {
      topicAnalysis = {
        ...topicAnalysis,
        relation: "new_topic",
        relationReason: `memory recall target changed from ${previousRecallTarget} to ${memoryRecallTarget}`,
        confidence: Math.max(topicAnalysis.confidence, 0.9),
        lowGrounding: false,
      };
    }

    if (parsed.history_topic || parsed.new_topic || parsed.topic_analysis) {
      console.error(
        `🔍 [IntentResolver] topic analysis: relation=${topicAnalysis.relation} history="${topicAnalysis.history.label || parsed.history_topic || "?"}" evidence=${JSON.stringify(topicAnalysis.history.evidence)} new="${topicAnalysis.current.label || parsed.new_topic || "?"}" evidence=${JSON.stringify(topicAnalysis.current.evidence)} references_recent=${referencesRecentHistory} confidence=${topicAnalysis.confidence.toFixed(2)}${topicAnalysis.lowGrounding ? " low_grounding=true" : ""} → topic_shifted=${topicShifted}`,
      );
    }
    if (topicAnalysis.lowGrounding) {
      evidence.push("topic_analysis_low_grounding");
    }

    const needsScheduling =
      scheduleCue || normalizeBoolean(parsed.needs_scheduling);
    const needsTool =
      needsScheduling ||
      taskType === "execute" ||
      taskType === "delegate" ||
      (semanticEvidence.actionRequest.present &&
        semanticEvidence.actionRequest.action !== "read" &&
        semanticEvidence.actionRequest.action !== "none") ||
      (!delegateDowngraded && normalizeBoolean(parsed.needs_tool));
    const needsMemory = personalFactAssertionCue
      ? false
      : subject !== "external" || taskType === "recall";
    const needsExternalKnowledge =
      subject === "external" ||
      subject === "mixed" ||
      normalizeBoolean(parsed.needs_external_knowledge);
    const richIntent = buildRichIntent({
      prompt,
      parsedRichIntent: parsed.rich_intent,
      taskType,
      subject,
      needsMemory,
      needsExternalKnowledge,
      needsTool,
      candidateAgents,
      referencesRecentHistory,
      confidence,
      semanticEvidence,
    });
    const intentSteps = deriveIntentSteps({
      prompt,
      parsedIntentSteps: parsed.intent_steps,
      taskType,
      needsMemory,
      needsExternalKnowledge,
      needsScheduling,
      candidateAgents,
      semanticEvidence,
      richIntent,
    });
    const confidenceByDimension = buildConfidenceByDimension({
      parsedConfidenceByDimension: parsed.confidence_by_dimension,
      confidence,
      evidence,
      subject,
      taskType,
      semanticEvidence,
      referencesRecentHistory,
      recentHistoryLength: recentTurns.length,
      richIntent,
    });
    if (this.options.intentPolicyObservability === true) {
      logAppliedPolicyTrace(policyTrace);
    }

    return {
      subject,
      taskType,
      needsMemory,
      needsExternalKnowledge,
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
      confidenceByDimension,
      evidence,
      source: this.options.modelSource ?? "local-intent/ollama",
      semanticEvidence,
      richIntent,
      intentSteps,
      topicAnalysis,
      policyTrace,
    };
  }
}
