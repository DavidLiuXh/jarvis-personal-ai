/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentFrame, QuerySubject } from "./intentResolver.js";

export type IntentAwareMemoryPolicy = {
  querySubject: QuerySubject;
  allowFacts: boolean;
  allowSummary: boolean;
  allowPrewarm: boolean;
  factQuery: string;
  prewarmQuery: string;
  shouldRewritePrewarmQuery: boolean;
  prewarmLimit: number;
  prewarmMaxDistance: number;
  reasons: string[];
};

export type IntentAwareMemoryPolicyConfig = {
  prewarmLimit: number;
  prewarmLimitMixed: number;
  memoryMaxDistance: number;
  prewarmMaxDistanceMixed: number;
};

const LOW_CONFIDENCE_THRESHOLD = 0.55;

function buildTargetQuery(userPrompt: string, intent: IntentFrame): string {
  const targetText = intent.richIntent.targets
    .map((target) => target.value)
    .filter(Boolean)
    .join(" ");
  const entityText = [
    ...intent.semanticEvidence.entityHints.tickers,
    ...intent.semanticEvidence.entityHints.technicalTerms,
    ...intent.semanticEvidence.entityHints.peopleOrCompanies,
  ].join(" ");
  const parts = [userPrompt, targetText, entityText].filter(Boolean);
  return Array.from(new Set(parts.join(" ").split(/\s+/))).join(" ");
}

export function buildIntentAwareMemoryPolicy(args: {
  userPrompt: string;
  querySubject: QuerySubject;
  intent?: IntentFrame | null;
  config: IntentAwareMemoryPolicyConfig;
}): IntentAwareMemoryPolicy {
  const reasons: string[] = [];
  const intent = args.intent ?? null;
  const querySubject = intent?.subject ?? args.querySubject;
  const memoryTarget = intent?.semanticEvidence.memoryRecall.target ?? "none";
  const confidence = intent?.confidenceByDimension;
  const lowSubjectConfidence =
    confidence !== undefined && confidence.subject < LOW_CONFIDENCE_THRESHOLD;
  const lowMemoryConfidence =
    confidence !== undefined &&
    confidence.memoryTarget < LOW_CONFIDENCE_THRESHOLD;

  let allowFacts = querySubject !== "external";
  let allowSummary = querySubject !== "external";
  let allowPrewarm = querySubject !== "external";

  if (querySubject === "external") {
    reasons.push("external_subject");
  }

  if (intent) {
    const hasRecallStep = intent.intentSteps.some(
      (step) => step.type === "recall",
    );
    const stepNeedsLongTermMemory =
      hasRecallStep &&
      memoryTarget !== "current_context_reference" &&
      memoryTarget !== "external_past_event";

    allowFacts = intent.needsMemory || stepNeedsLongTermMemory;
    allowSummary = intent.needsMemory || stepNeedsLongTermMemory;
    allowPrewarm = intent.needsMemory || stepNeedsLongTermMemory;

    if (!intent.needsMemory && !stepNeedsLongTermMemory) {
      reasons.push("intent_needs_memory_false");
    }
    if (
      intent.richIntent.contextDependency.longTermMemory === false &&
      !stepNeedsLongTermMemory
    ) {
      allowFacts = false;
      allowPrewarm = false;
      reasons.push("rich_intent_no_long_term_memory");
    }
    if (memoryTarget === "external_past_event") {
      allowFacts = false;
      allowSummary = false;
      allowPrewarm = false;
      reasons.push("external_past_event");
    }
    if (memoryTarget === "current_context_reference") {
      allowFacts = false;
      allowSummary = false;
      allowPrewarm = false;
      reasons.push("current_context_reference");
    }
    if (
      (intent.taskType === "execute" ||
        intent.taskType === "delegate" ||
        intent.taskType === "schedule") &&
      intent.richIntent.contextDependency.longTermMemory === false &&
      !stepNeedsLongTermMemory
    ) {
      allowFacts = false;
      allowSummary = false;
      allowPrewarm = false;
      reasons.push("tool_task_without_memory_dependency");
    }
    if (lowSubjectConfidence || lowMemoryConfidence) {
      allowPrewarm = false;
      allowSummary = false;
      reasons.push("low_intent_confidence");
    }
  }

  const targetQuery = intent
    ? buildTargetQuery(args.userPrompt, intent)
    : args.userPrompt;
  const factQuery =
    allowFacts && (querySubject === "personal" || querySubject === "mixed")
      ? "PRIVATE_USER_DATA: User Query - " + targetQuery
      : targetQuery;
  const prewarmQuery = targetQuery;
  const mixedLike = querySubject === "mixed" || lowSubjectConfidence;
  const prewarmLimit = mixedLike
    ? args.config.prewarmLimitMixed
    : args.config.prewarmLimit;
  const prewarmMaxDistance = mixedLike
    ? args.config.prewarmMaxDistanceMixed
    : args.config.memoryMaxDistance;

  return {
    querySubject,
    allowFacts,
    allowSummary,
    allowPrewarm,
    factQuery,
    prewarmQuery,
    shouldRewritePrewarmQuery:
      allowPrewarm &&
      querySubject === "personal" &&
      memoryTarget !== "current_context_reference",
    prewarmLimit,
    prewarmMaxDistance,
    reasons,
  };
}
