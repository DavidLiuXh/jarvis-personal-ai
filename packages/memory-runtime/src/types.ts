/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type ConversationRole = "user" | "assistant" | "system" | "tool";

export type ConversationTurn = {
  role: ConversationRole;
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
};

export type DateRange = {
  from: number;
  to: number;
};

export type TopicState = {
  label: string;
  summary?: string;
  entities?: string[];
  updatedAt?: string;
};

export type SubjectBoundary = "personal" | "external" | "mixed";
export type QuerySubject = SubjectBoundary;

export type IntentTaskType =
  | "chat"
  | "recall"
  | "analyze"
  | "execute"
  | "delegate"
  | "schedule";

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

export type RichIntentDomain =
  | "task_management"
  | "memory_management"
  | "code_modification"
  | "system_control"
  | "general_chat"
  | "external_knowledge"
  | "investment_analysis"
  | "unknown";

export type RichIntentAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "list"
  | "append"
  | "rename"
  | "pause"
  | "resume"
  | "cancel"
  | "send"
  | "resend"
  | "forward"
  | "retry"
  | "forget"
  | "consolidate"
  | "execute"
  | "schedule"
  | "answer"
  | "analyze"
  | "delegate"
  | "recall";

export type RichIntentTargetType =
  | "memory"
  | "file"
  | "code"
  | "external_entity"
  | "agent"
  | "task"
  | "channel"
  | "calendar"
  | "current_context";

export type RichIntentRiskLevel = "low" | "medium" | "high";

export type RichIntentPrimaryAction =
  | "answer"
  | "recall"
  | "analyze"
  | "modify"
  | "run"
  | "schedule"
  | "delegate";

export type RichIntent = {
  userGoal: string;
  domain: RichIntentDomain;
  action: RichIntentAction;
  primaryAction: RichIntentPrimaryAction;
  targets: Array<{
    type: RichIntentTargetType;
    value: string;
  }>;
  contextDependency: {
    recentConversation: boolean;
    longTermMemory: boolean;
    localWorkspace: boolean;
    externalWorld: boolean;
  };
  ambiguity: Array<{
    field: string;
    reason: string;
    severity: "low" | "medium" | "high";
  }>;
  riskLevel: RichIntentRiskLevel;
};

export type IntentStep = {
  id: string;
  type: IntentTaskType;
  action: string;
  target: string;
  operation: {
    domain: RichIntentDomain;
    action: RichIntentAction;
    targetType: RichIntentTargetType;
    target: string;
    targetId?: string;
    selector?: string;
    scope?:
      | "current_session"
      | "long_term"
      | "workspace"
      | "external"
      | "scheduled_tasks"
      | "channel";
    riskLevel: RichIntentRiskLevel;
  };
  dependsOn: string[];
  requiresConfirmation: boolean;
  riskLevel: RichIntentRiskLevel;
};

export type IntentConfidenceByDimension = {
  subject: number;
  taskType: number;
  memoryTarget: number;
  action: number;
  entityHints: number;
  topicShift: number;
  richIntent: number;
};

export type TopicRelation =
  | "same_topic"
  | "subtopic"
  | "adjacent_topic"
  | "new_topic"
  | "current_context_reference"
  | "unknown";

export type GroundedTopic = {
  label: string;
  evidence: string[];
  sourceTurns: number[];
  confidence: number;
};

export type TopicAnalysis = {
  history: GroundedTopic;
  current: GroundedTopic;
  relation: TopicRelation;
  relationReason: string;
  confidence: number;
  lowGrounding: boolean;
};

export type IntentClassifierDecision<T extends string> = {
  value: T;
  confidence: number;
  reason: string;
  evidence: string[];
};

export type IntentTopicClassifier = {
  historyDomain: string;
  currentDomain: string;
  semanticDomainContinuity: boolean;
  workflowContinuity: boolean;
  entityContinuity: boolean;
  sharedEntities: string[];
  sharedWorkflow: string[];
  requiresPreviousContext: boolean;
  relation: TopicRelation;
  topicShifted: boolean;
  confidence: number;
  reason: string;
  evidence: string[];
};

export type IntentStepClassifier = {
  primaryTask: IntentTaskType;
  isMultiIntent: boolean;
  confidence: number;
  reason: string;
  evidence: string[];
};

export type IntentClassifiers = {
  subject: IntentClassifierDecision<QuerySubject>;
  task: IntentClassifierDecision<IntentTaskType>;
  memory: IntentClassifierDecision<MemoryRecallTarget>;
  action: IntentClassifierDecision<RichIntentAction>;
  topic: IntentTopicClassifier;
  steps: IntentStepClassifier;
};

export type IntentPolicyStage =
  | "normalize"
  | "guardrail"
  | "override"
  | "finalize";

export type IntentPolicyReasonCategory =
  | "semantic_evidence"
  | "subject_boundary"
  | "task_boundary"
  | "topic_boundary"
  | "agent_routing";

export type IntentPolicyReasonSeverity = "info" | "warning" | "critical";

export type IntentPolicyReason = {
  code: string;
  category: IntentPolicyReasonCategory;
  severity: IntentPolicyReasonSeverity;
};

export type IntentPolicyTraceEntry = {
  ruleId: string;
  stage: IntentPolicyStage;
  priority: number;
  reasonCode: string;
  reason: IntentPolicyReason;
  applied: boolean;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  skippedReason?: string;
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
  resolvedDateRange: DateRange | null;
  topicShifted: boolean;
  referencesRecentHistory: boolean;
  complexityScore: number;
  knowledgeScore: number | null;
  operationScore: number | null;
  reason: string;
  confidence: number;
  confidenceByDimension: IntentConfidenceByDimension;
  evidence: string[];
  semanticEvidence: IntentEvidence;
  classifiers?: IntentClassifiers;
  richIntent: RichIntent;
  intentSteps: IntentStep[];
  topicAnalysis: TopicAnalysis;
  policyTrace: IntentPolicyTraceEntry[];
  source: string;
};

export type MemoryScope = "session" | "fact" | "entry";

export type MemoryTarget =
  | "none"
  | "current_context"
  | "current_context_reference"
  | "conversation_history"
  | "user_memory"
  | "user_profile"
  | "external_past_event"
  | "episodic_event"
  | "project_context";

export type TokenBudget = {
  maxChars: number;
  maxFacts?: number;
  maxSessionItems?: number;
  maxEntries?: number;
};

export type SessionMemory = {
  scope: "session";
  sessionId: string;
  turns: ConversationTurn[];
  summary?: string;
  topicState?: TopicState;
};

export type FactMemory = {
  id: string;
  scope: "fact";
  subject: "user" | "preference" | "profile" | "project" | "relationship";
  content: string;
  confidence: number;
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type EntryMemory = {
  id: string;
  scope: "entry";
  kind: "conversation" | "task" | "decision" | "event" | "reflection";
  content: string;
  entities: string[];
  timestamp: string;
  sourceRefs: string[];
  metadata?: Record<string, unknown>;
};

export type MemoryItem = SessionMemory | FactMemory | EntryMemory;

export type MemoryPolicyTraceEntry = {
  ruleId: string;
  reasonCode: string;
  applied: boolean;
  severity?: "info" | "warning" | "critical";
  details?: Record<string, unknown>;
};

export type MemoryContract = {
  needMemory: boolean;
  subjectBoundary: SubjectBoundary;
  targetScopes: MemoryScope[];
  memoryTarget: MemoryTarget;
  query: {
    raw: string;
    rewritten?: string;
    entities: string[];
    timeRange?: DateRange;
  };
  confidence: {
    subject: number;
    target: number;
    query: number;
  };
  constraints: {
    allowPersonalFacts: boolean;
    allowSessionHistory: boolean;
    allowEntries: boolean;
    maxChars: number;
  };
  reasons: string[];
  policyTrace: MemoryPolicyTraceEntry[];
};

export type StepMemoryDecision = {
  stepId: string;
  stepType: IntentTaskType;
  target: string;
  needMemory: boolean;
  targetScopes: MemoryScope[];
  memoryTarget: MemoryTarget;
  query: string;
  constraints: {
    allowPersonalFacts: boolean;
    allowSessionHistory: boolean;
    allowEntries: boolean;
  };
  reasons: string[];
};

export type MemoryRetrievalResult = {
  contract: MemoryContract;
  session: Array<{ item: SessionMemory; score: number; reason?: string }>;
  facts: Array<{ item: FactMemory; score: number; reason?: string }>;
  entries: Array<{ item: EntryMemory; score: number; reason?: string }>;
};

export type MemoryInjectionRejectedItem = {
  scope: MemoryScope;
  reason: string;
  text: string;
};

export type MemoryInjectionResult = {
  text: string;
  usedChars: number;
  injected: {
    session: number;
    facts: number;
    entries: number;
  };
  rejected: MemoryInjectionRejectedItem[];
  trace: MemoryPolicyTraceEntry[];
};

export type ClarificationQuestion = {
  question: string;
  header?: string;
  /**
   * "choice" — radio/checkbox with options.
   * "text"   — free-form input.
   * "yesno"  — Yes / No buttons with optional Other feedback.
   */
  type?: "choice" | "text" | "yesno";
  placeholder?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

export type UserTurnInput = {
  sessionId: string;
  prompt: string;
  history: ConversationTurn[];
  timestamp?: string;
  metadata?: Record<string, unknown>;
};

export type MemoryRuntimeEvent =
  | {
      type: "intent_resolved";
      sessionId: string;
      prompt: string;
      observed: unknown;
    }
  | {
      type: "memory_retrieved";
      sessionId: string;
      contract: MemoryContract;
      result: MemoryRetrievalResult;
    }
  | {
      type: "memory_injected";
      sessionId: string;
      contract: MemoryContract;
      result: MemoryInjectionResult;
    }
  | {
      type: "runtime_feedback";
      sessionId: string;
      signal: string;
      observed: unknown;
    };
