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

export type MemoryScope = "session" | "fact" | "entry";

export type MemoryTarget =
  | "none"
  | "current_context"
  | "conversation_history"
  | "user_profile"
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
