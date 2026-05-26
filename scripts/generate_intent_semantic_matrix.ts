#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type MatrixCase = {
  id: string;
  dimension: string;
  invariant: string;
  principles: string[];
  axes: Record<string, string>;
  prompt: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  now?: string;
  model: Record<string, unknown>;
  expect: Record<string, unknown>;
  tags: string[];
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputPath = path.join(
  repoRoot,
  "evals/intent/semantic-space-cases.jsonl",
);

const PRINCIPLES = {
  subjectMemorySeparation: "SUBJECT_MEMORY_SEPARATION",
  memoryTargetSpecificity: "MEMORY_TARGET_SPECIFICITY",
  actionDominance: "ACTION_DOMINANCE",
  topicBoundaryGrounding: "TOPIC_BOUNDARY_GROUNDING",
  currentContextLocality: "CURRENT_CONTEXT_LOCALITY",
  timeScopedRecallIsolation: "TIME_SCOPED_RECALL_ISOLATION",
  clarificationBeforeRiskyAction: "CLARIFICATION_BEFORE_RISKY_ACTION",
  multiStepPreservation: "MULTI_STEP_PRESERVATION",
};

function semanticEvidence(args: {
  personal?: boolean;
  memoryTarget?: string;
  memoryPresent?: boolean;
  action?: string;
  object?: string;
  tickers?: string[];
  technicalTerms?: string[];
  peopleOrCompanies?: string[];
}) {
  return {
    personalContext: {
      present: args.personal === true,
      reason: args.personal ? "personal context present" : "",
      span: args.personal ? "我" : "",
    },
    memoryRecall: {
      present: args.memoryPresent ?? args.memoryTarget !== "none",
      target: args.memoryTarget ?? "none",
      reason: args.memoryTarget ? `target=${args.memoryTarget}` : "",
      span: "",
    },
    actionRequest: {
      present: args.action !== undefined && args.action !== "none",
      action: args.action ?? "none",
      object: args.object ?? "",
    },
    entityHints: {
      tickers: args.tickers ?? [],
      technicalTerms: args.technicalTerms ?? [],
      peopleOrCompanies: args.peopleOrCompanies ?? [],
    },
  };
}

function topic(args: {
  relation?: string;
  historyLabel?: string;
  historyEvidence?: string[];
  currentLabel: string;
  currentEvidence: string[];
  confidence?: number;
}) {
  return {
    relation: args.relation ?? "unknown",
    history: {
      label: args.historyLabel ?? "",
      evidence: args.historyEvidence ?? [],
      source_turns: args.historyEvidence?.length ? [0, 1] : [],
      confidence: args.historyEvidence?.length ? 0.9 : 0,
    },
    current: {
      label: args.currentLabel,
      evidence: args.currentEvidence,
      source_turns: [0],
      confidence: args.confidence ?? 0.95,
    },
    relation_reason: "generated semantic-space matrix case",
    confidence: args.confidence ?? 0.95,
    low_grounding: false,
  };
}

function richIntent(args: {
  goal: string;
  domain?: string;
  action?: string;
  targets?: Array<{ type: string; value: string }>;
  recentConversation?: boolean;
  longTermMemory?: boolean;
  externalWorld?: boolean;
  localWorkspace?: boolean;
  risk?: string;
  ambiguity?: Array<{ field: string; reason: string; severity: string }>;
}) {
  return {
    userGoal: args.goal,
    domain: args.domain ?? "unknown",
    action: args.action ?? "answer",
    targets: args.targets ?? [],
    contextDependency: {
      recentConversation: args.recentConversation === true,
      longTermMemory: args.longTermMemory === true,
      externalWorld: args.externalWorld === true,
      localWorkspace: args.localWorkspace === true,
    },
    ambiguity: args.ambiguity ?? [],
    riskLevel: args.risk ?? "low",
  };
}

function step(args: {
  id: string;
  type: string;
  action: string;
  target: string;
  domain: string;
  opAction: string;
  targetType: string;
  scope: string;
  confirmation?: boolean;
  risk?: string;
}) {
  return {
    id: args.id,
    type: args.type,
    action: args.action,
    target: args.target,
    requires_confirmation: args.confirmation === true,
    risk_level: args.risk ?? "low",
    operation: {
      domain: args.domain,
      action: args.opAction,
      target_type: args.targetType,
      target: args.target,
      scope: args.scope,
    },
  };
}

function raw(args: {
  prompt: string;
  subject: string;
  task: string;
  needsExternal?: boolean;
  needsTool?: boolean;
  needsScheduling?: boolean;
  candidateAgents?: string[];
  semantic: Record<string, unknown>;
  rich?: Record<string, unknown>;
  steps?: unknown[];
  topicAnalysis: Record<string, unknown>;
  referencesRecentHistory?: boolean;
  confidence?: number;
}) {
  return {
    complexity_score: 50,
    knowledge_score: args.needsExternal ? 80 : 40,
    operation_score: args.needsTool ? 80 : 30,
    complexity_reasoning: "generated semantic-space matrix case",
    query_subject: args.subject,
    task_type: args.task,
    needs_external_knowledge: args.needsExternal === true,
    needs_tool: args.needsTool === true,
    needs_scheduling: args.needsScheduling === true,
    candidate_agents: args.candidateAgents ?? [],
    confidence: args.confidence ?? 0.95,
    confidence_by_dimension: {
      subject: args.confidence ?? 0.95,
      taskType: args.confidence ?? 0.95,
      memoryTarget: args.confidence ?? 0.95,
      action: args.confidence ?? 0.95,
      entityHints: args.confidence ?? 0.95,
      topicShift: args.confidence ?? 0.95,
      richIntent: args.confidence ?? 0.95,
    },
    evidence: ["semantic_space_matrix"],
    semantic_evidence: args.semantic,
    references_recent_history: args.referencesRecentHistory === true,
    topic_shifted: false,
    rich_intent:
      args.rich ??
      richIntent({
        goal: args.prompt,
      }),
    intent_steps: args.steps ?? [],
    topic_analysis: args.topicAnalysis,
  };
}

function caseOf(args: Omit<MatrixCase, "tags"> & { tags?: string[] }) {
  return {
    ...args,
    tags: ["semantic-space", ...(args.tags ?? [])],
  };
}

const cases: MatrixCase[] = [
  caseOf({
    id: "semantic.subject.external.none.analyze",
    dimension: "memoryPolicy",
    invariant: "EXTERNAL_SUBJECT_HAS_EMPTY_PERSONAL_MEMORY_CONTRACT",
    principles: [PRINCIPLES.subjectMemorySeparation],
    axes: {
      subject: "external",
      memoryTarget: "none",
      action: "analyze",
      topic: "standalone",
      risk: "low",
    },
    prompt: "解释一下欧盟 AI Act 的主要监管思路",
    model: raw({
      prompt: "解释一下欧盟 AI Act 的主要监管思路",
      subject: "external",
      task: "analyze",
      needsExternal: true,
      semantic: semanticEvidence({
        memoryTarget: "none",
        memoryPresent: false,
      }),
      rich: richIntent({
        goal: "解释欧盟 AI Act",
        domain: "external_knowledge",
        action: "analyze",
        externalWorld: true,
      }),
      topicAnalysis: topic({
        currentLabel: "EU AI Act analysis",
        currentEvidence: ["欧盟 AI Act"],
      }),
    }),
    expect: {
      subject: "external",
      taskType: "analyze",
      needsMemory: false,
      needsExternalKnowledge: true,
      memoryTarget: "none",
      memoryPolicy: {
        allowFacts: false,
        allowSummary: false,
        allowPrewarm: false,
        targetScopes: [],
      },
    },
  }),
  caseOf({
    id: "semantic.subject.personal.user_memory.recall",
    dimension: "memoryTarget",
    invariant: "USER_MEMORY_RECALL_USES_USER_MEMORY_TARGET",
    principles: [
      PRINCIPLES.subjectMemorySeparation,
      PRINCIPLES.memoryTargetSpecificity,
    ],
    axes: {
      subject: "personal",
      memoryTarget: "user_memory",
      action: "recall",
      topic: "standalone",
      risk: "low",
    },
    prompt: "你还记得我有哪些爱好吗？",
    model: raw({
      prompt: "你还记得我有哪些爱好吗？",
      subject: "personal",
      task: "recall",
      semantic: semanticEvidence({
        personal: true,
        memoryTarget: "user_memory",
      }),
      rich: richIntent({
        goal: "回忆用户爱好",
        domain: "memory_management",
        action: "recall",
        targets: [{ type: "memory", value: "user_memory" }],
        longTermMemory: true,
      }),
      topicAnalysis: topic({
        currentLabel: "User hobbies recall",
        currentEvidence: ["爱好"],
      }),
    }),
    expect: {
      subject: "personal",
      taskType: "recall",
      needsMemory: true,
      memoryTarget: "user_memory",
      memoryPolicy: {
        allowFacts: true,
        allowSummary: true,
        allowPrewarm: true,
        targetScopes: ["session", "fact", "entry"],
      },
    },
  }),
  caseOf({
    id: "semantic.subject.personal.conversation_history.recall",
    dimension: "memoryTarget",
    invariant: "CONVERSATION_HISTORY_RECALL_USES_HISTORY_TARGET",
    principles: [
      PRINCIPLES.subjectMemorySeparation,
      PRINCIPLES.memoryTargetSpecificity,
    ],
    axes: {
      subject: "personal",
      memoryTarget: "conversation_history",
      action: "recall",
      topic: "older_history",
      risk: "low",
    },
    prompt: "我们之前讨论过哪些 Jarvis 的意图理解问题？",
    model: raw({
      prompt: "我们之前讨论过哪些 Jarvis 的意图理解问题？",
      subject: "personal",
      task: "recall",
      semantic: semanticEvidence({
        personal: true,
        memoryTarget: "conversation_history",
      }),
      rich: richIntent({
        goal: "回顾之前讨论",
        domain: "memory_management",
        action: "recall",
        targets: [{ type: "memory", value: "conversation_history" }],
        longTermMemory: true,
      }),
      topicAnalysis: topic({
        currentLabel: "Conversation history recall",
        currentEvidence: ["之前讨论", "意图理解"],
      }),
    }),
    expect: {
      subject: "personal",
      taskType: "recall",
      needsMemory: true,
      referencesRecentHistory: false,
      memoryTarget: "conversation_history",
    },
  }),
  caseOf({
    id: "semantic.subject.mixed.personal_external.analyze",
    dimension: "memoryPolicy",
    invariant:
      "MIXED_PERSONAL_EXTERNAL_ANALYSIS_KEEPS_MEMORY_AND_EXTERNAL_CONTEXT",
    principles: [PRINCIPLES.subjectMemorySeparation],
    axes: {
      subject: "mixed",
      memoryTarget: "user_memory",
      action: "analyze",
      topic: "standalone",
      risk: "medium",
    },
    prompt: "结合我的技术偏好，比较 React 和 Vue 哪个更适合我",
    model: raw({
      prompt: "结合我的技术偏好，比较 React 和 Vue 哪个更适合我",
      subject: "mixed",
      task: "analyze",
      needsExternal: true,
      semantic: semanticEvidence({
        personal: true,
        memoryTarget: "user_memory",
        technicalTerms: ["React", "Vue"],
      }),
      rich: richIntent({
        goal: "结合偏好比较 React 和 Vue",
        domain: "external_knowledge",
        action: "analyze",
        targets: [
          { type: "memory", value: "user_memory" },
          { type: "code", value: "React" },
          { type: "code", value: "Vue" },
        ],
        longTermMemory: true,
        externalWorld: true,
        risk: "medium",
      }),
      topicAnalysis: topic({
        currentLabel: "React vs Vue preference fit",
        currentEvidence: ["技术偏好", "React", "Vue"],
      }),
    }),
    expect: {
      subject: "mixed",
      taskType: "analyze",
      needsMemory: true,
      needsExternalKnowledge: true,
      memoryTarget: "user_memory",
      memoryPolicy: {
        allowFacts: true,
        allowSummary: true,
        allowPrewarm: true,
      },
    },
  }),
  caseOf({
    id: "semantic.context.current_reference.followup",
    dimension: "topicBoundary",
    invariant: "ANAPHORIC_FOLLOWUP_USES_CURRENT_CONTEXT_REFERENCE",
    principles: [
      PRINCIPLES.topicBoundaryGrounding,
      PRINCIPLES.currentContextLocality,
    ],
    axes: {
      subject: "mixed",
      memoryTarget: "current_context_reference",
      action: "analyze",
      topic: "current_context_reference",
      risk: "low",
    },
    prompt: "继续把这个方案拆成任务",
    history: [
      { role: "user", content: "我们要把 Jarvis 的意图理解升级成强系统。" },
      {
        role: "assistant",
        content: "可以分成 eval、schema、repair、multi-intent 几步。",
      },
    ],
    model: raw({
      prompt: "继续把这个方案拆成任务",
      subject: "mixed",
      task: "analyze",
      semantic: semanticEvidence({
        memoryTarget: "current_context_reference",
      }),
      referencesRecentHistory: true,
      rich: richIntent({
        goal: "拆分当前方案",
        domain: "general_chat",
        action: "analyze",
        targets: [{ type: "current_context", value: "recent_conversation" }],
        recentConversation: true,
      }),
      topicAnalysis: topic({
        relation: "current_context_reference",
        historyLabel: "Jarvis intent upgrade plan",
        historyEvidence: ["意图理解", "强系统"],
        currentLabel: "Break current plan into tasks",
        currentEvidence: ["继续", "这个方案"],
      }),
    }),
    expect: {
      topicShifted: false,
      referencesRecentHistory: true,
      memoryTarget: "current_context_reference",
      topicRelation: "current_context_reference",
      memoryPolicy: {
        allowFacts: false,
        allowSummary: false,
        allowPrewarm: false,
        targetScopes: [],
      },
    },
  }),
  caseOf({
    id: "semantic.time.yesterday.conversation_history.entry_only",
    dimension: "memoryPolicy",
    invariant: "TIME_SCOPED_HISTORY_RECALL_USES_ENTRY_SCOPE",
    principles: [
      PRINCIPLES.memoryTargetSpecificity,
      PRINCIPLES.timeScopedRecallIsolation,
    ],
    axes: {
      subject: "personal",
      memoryTarget: "conversation_history",
      action: "recall",
      topic: "time_scoped_history",
      risk: "low",
    },
    prompt: "昨天我们聊了什么？",
    now: "2026-05-26T04:00:00.000Z",
    model: raw({
      prompt: "昨天我们聊了什么？",
      subject: "personal",
      task: "recall",
      semantic: semanticEvidence({
        personal: true,
        memoryTarget: "conversation_history",
      }),
      rich: richIntent({
        goal: "回忆昨天对话",
        domain: "memory_management",
        action: "recall",
        targets: [{ type: "memory", value: "conversation_history" }],
        longTermMemory: true,
      }),
      topicAnalysis: topic({
        currentLabel: "Yesterday conversation recall",
        currentEvidence: ["昨天", "聊了什么"],
      }),
    }),
    expect: {
      subject: "personal",
      taskType: "recall",
      memoryTarget: "conversation_history",
      memoryPolicy: {
        allowFacts: false,
        allowSummary: false,
        allowPrewarm: true,
        targetScopes: ["entry"],
      },
    },
  }),
  caseOf({
    id: "semantic.action.execute.local_workspace",
    dimension: "actionBoundary",
    invariant: "LOCAL_WORKSPACE_ACTIONS_ARE_EXECUTE_AND_TOOL_BACKED",
    principles: [PRINCIPLES.actionDominance],
    axes: {
      subject: "personal",
      memoryTarget: "none",
      action: "execute",
      topic: "standalone",
      risk: "medium",
    },
    prompt: "帮我更新 intent 文档",
    model: raw({
      prompt: "帮我更新 intent 文档",
      subject: "personal",
      task: "execute",
      needsTool: true,
      semantic: semanticEvidence({
        personal: true,
        memoryTarget: "none",
        memoryPresent: false,
        action: "write",
        object: "intent 文档",
      }),
      rich: richIntent({
        goal: "更新 intent 文档",
        domain: "code_modification",
        action: "update",
        targets: [{ type: "file", value: "intent 文档" }],
        localWorkspace: true,
        risk: "medium",
      }),
      steps: [
        step({
          id: "step-1",
          type: "execute",
          action: "update document",
          target: "intent 文档",
          domain: "code_modification",
          opAction: "update",
          targetType: "file",
          scope: "workspace",
        }),
      ],
      topicAnalysis: topic({
        currentLabel: "Update intent document",
        currentEvidence: ["更新", "intent 文档"],
      }),
    }),
    expect: {
      subject: "personal",
      taskType: "execute",
      needsTool: true,
      memoryTarget: "none",
      intentStepOrder: ["execute"],
    },
  }),
  caseOf({
    id: "semantic.action.delegate.explicit_agent",
    dimension: "actionBoundary",
    invariant: "EXPLICIT_AGENT_REQUESTS_ARE_DELEGATE",
    principles: [PRINCIPLES.actionDominance],
    axes: {
      subject: "external",
      memoryTarget: "none",
      action: "delegate",
      topic: "standalone",
      risk: "medium",
    },
    prompt: "agent: investment-analysis 分析 TSLA",
    model: raw({
      prompt: "agent: investment-analysis 分析 TSLA",
      subject: "external",
      task: "delegate",
      needsExternal: true,
      needsTool: true,
      candidateAgents: ["investment-analysis"],
      semantic: semanticEvidence({
        memoryTarget: "none",
        memoryPresent: false,
        action: "delegate",
        object: "investment-analysis",
        tickers: ["TSLA"],
      }),
      rich: richIntent({
        goal: "让投资分析 agent 分析 TSLA",
        domain: "investment_analysis",
        action: "delegate",
        targets: [
          { type: "agent", value: "investment-analysis" },
          { type: "external_entity", value: "TSLA" },
        ],
        externalWorld: true,
        risk: "medium",
      }),
      steps: [
        step({
          id: "step-1",
          type: "delegate",
          action: "delegate investment analysis",
          target: "investment-analysis",
          domain: "external_knowledge",
          opAction: "delegate",
          targetType: "agent",
          scope: "external",
        }),
      ],
      topicAnalysis: topic({
        currentLabel: "Delegate TSLA analysis",
        currentEvidence: ["investment-analysis", "TSLA"],
      }),
    }),
    expect: {
      subject: "external",
      taskType: "delegate",
      needsTool: true,
      candidateAgentsContain: ["investment-analysis"],
      intentStepOrder: ["delegate"],
    },
  }),
  caseOf({
    id: "semantic.clarification.destructive.memory_delete_requires_target",
    dimension: "clarification",
    invariant: "DESTRUCTIVE_MEMORY_OPERATIONS_REQUIRE_CONCRETE_TARGET",
    principles: [PRINCIPLES.clarificationBeforeRiskyAction],
    axes: {
      subject: "personal",
      memoryTarget: "none",
      action: "execute_delete",
      topic: "standalone",
      risk: "high",
    },
    prompt: "把这条记忆删掉",
    model: raw({
      prompt: "把这条记忆删掉",
      subject: "personal",
      task: "execute",
      needsTool: true,
      semantic: semanticEvidence({
        personal: true,
        memoryTarget: "none",
        memoryPresent: false,
        action: "delete",
        object: "这条记忆",
      }),
      rich: richIntent({
        goal: "删除记忆",
        domain: "memory_management",
        action: "delete",
        targets: [{ type: "memory", value: "这条记忆" }],
        longTermMemory: true,
        risk: "high",
      }),
      steps: [
        step({
          id: "step-1",
          type: "execute",
          action: "delete memory",
          target: "这条记忆",
          domain: "memory_management",
          opAction: "delete",
          targetType: "memory",
          scope: "long_term",
          risk: "high",
        }),
      ],
      topicAnalysis: topic({
        currentLabel: "Delete ambiguous memory",
        currentEvidence: ["这条记忆", "删掉"],
      }),
    }),
    expect: {
      taskType: "execute",
      needsTool: true,
      clarification: {
        state: "awaiting_user",
        shouldAsk: true,
        reasonsContain: ["crud_target_required_for_destructive_action"],
      },
    },
  }),
  caseOf({
    id: "semantic.multi.delegate_then_schedule",
    dimension: "multiIntent",
    invariant: "MULTI_INTENT_ORDER_PRESERVES_DELEGATE_THEN_SCHEDULE",
    principles: [PRINCIPLES.multiStepPreservation],
    axes: {
      subject: "external",
      memoryTarget: "none",
      action: "delegate_schedule",
      topic: "standalone",
      risk: "medium",
    },
    prompt: "让 investment-analysis agent 分析 NVDA，明天提醒我看结果",
    model: raw({
      prompt: "让 investment-analysis agent 分析 NVDA，明天提醒我看结果",
      subject: "external",
      task: "schedule",
      needsExternal: true,
      needsTool: true,
      needsScheduling: true,
      candidateAgents: ["investment-analysis"],
      semantic: semanticEvidence({
        memoryTarget: "none",
        memoryPresent: false,
        action: "schedule",
        object: "明天提醒我看结果",
        tickers: ["NVDA"],
      }),
      rich: richIntent({
        goal: "分析 NVDA 并安排提醒",
        domain: "task_management",
        action: "schedule",
        targets: [
          { type: "agent", value: "investment-analysis" },
          { type: "external_entity", value: "NVDA" },
          { type: "task", value: "明天提醒看结果" },
        ],
        externalWorld: true,
        risk: "medium",
      }),
      steps: [
        step({
          id: "step-1",
          type: "delegate",
          action: "delegate analysis",
          target: "investment-analysis",
          domain: "external_knowledge",
          opAction: "delegate",
          targetType: "agent",
          scope: "external",
        }),
        step({
          id: "step-2",
          type: "schedule",
          action: "create reminder",
          target: "明天看结果",
          domain: "task_management",
          opAction: "create",
          targetType: "task",
          scope: "scheduled_tasks",
          confirmation: true,
        }),
      ],
      topicAnalysis: topic({
        currentLabel: "Delegate NVDA analysis and schedule",
        currentEvidence: ["investment-analysis", "NVDA", "明天"],
      }),
    }),
    expect: {
      taskType: "schedule",
      needsTool: true,
      needsScheduling: true,
      candidateAgentsContain: ["investment-analysis"],
      intentStepOrder: ["delegate", "schedule"],
      clarification: {
        state: "ready",
        shouldAsk: false,
      },
    },
  }),
];

fs.writeFileSync(
  outputPath,
  cases.map((evalCase) => JSON.stringify(evalCase)).join("\n") + "\n",
);
console.log(`Generated ${cases.length} semantic-space cases: ${outputPath}`);
