/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  applyClarificationChannelState,
  buildClarificationDecision,
  type ClarificationDecision,
  type ClarificationPolicyInput,
} from "@jarvis/memory-runtime/clarificationPolicy";
import type {
  ConversationTurn,
  IntentFrame,
  QuerySubject,
} from "@jarvis/memory-runtime";
import {
  buildIntentExecutionPlan,
  type IntentExecutionPlan,
} from "./executionPlan.js";

export type IntentRuntimeExecutionContext = "interactive" | "proactive_task";

export type IntentRuntimeInput = {
  userPrompt: string;
  history?: ConversationTurn[];
  now?: Date;
  executionContext?: IntentRuntimeExecutionContext;
  interactiveChannel?: boolean;
  metadata?: Record<string, unknown>;
};

export type IntentResolverAdapterInput = {
  userPrompt: string;
  history: ConversationTurn[];
  now: Date;
  metadata?: Record<string, unknown>;
};

export type IntentResolverAdapterResult = {
  intent: IntentFrame;
  source: string;
  diagnostics?: Record<string, unknown>;
};

export type IntentModelJsonClientRequest = {
  userPrompt: string;
  history: ConversationTurn[];
  now: Date;
  systemInstruction?: string;
  metadata?: Record<string, unknown>;
};

export type IntentModelJsonClientResult = {
  rawText: string;
  parsedJson?: unknown;
  model?: string;
  latencyMs?: number;
  diagnostics?: Record<string, unknown>;
};

export type IntentModelJsonClient = {
  generateJson(
    request: IntentModelJsonClientRequest,
  ): Promise<IntentModelJsonClientResult>;
};

export type IntentJsonRepairInput = {
  rawText: string;
  parseError?: string;
  metadata?: Record<string, unknown>;
};

export type IntentJsonRepairResult = {
  repairedJson: unknown;
  repairedText?: string;
  strategy: string;
  diagnostics?: Record<string, unknown>;
};

export type IntentJsonRepairAdapter = {
  repair(input: IntentJsonRepairInput): Promise<IntentJsonRepairResult>;
};

export type IntentFallbackAdapterInput = IntentResolverAdapterInput & {
  error?: unknown;
  rawText?: string;
};

export type IntentFallbackAdapterResult = IntentResolverAdapterResult & {
  fallbackReason: string;
};

export type IntentFallbackAdapter = {
  resolveFallback(
    input: IntentFallbackAdapterInput,
  ): Promise<IntentFallbackAdapterResult>;
};

export type IntentResolverAdapter = {
  resolve(
    input: IntentResolverAdapterInput,
  ): Promise<IntentResolverAdapterResult>;
};

export type IntentClarificationAdapterInput = ClarificationPolicyInput & {
  interactiveChannel: boolean;
};

export type IntentPolicyAdapterInput = {
  userPrompt: string;
  intent: IntentFrame;
  history: ConversationTurn[];
  executionContext: IntentRuntimeExecutionContext;
  metadata?: Record<string, unknown>;
};

export type IntentPolicyEvaluation = {
  querySubject: QuerySubject;
  trace: IntentFrame["policyTrace"];
  diagnostics?: Record<string, unknown>;
};

export type IntentPolicyAdapter = {
  evaluate(input: IntentPolicyAdapterInput): Promise<IntentPolicyEvaluation>;
};

export type IntentClarificationAdapter = {
  decide(
    input: IntentClarificationAdapterInput,
  ): Promise<ClarificationDecision>;
};

export type IntentExecutionPlanner = {
  plan(intent: IntentFrame | null): IntentExecutionPlan | null;
};

export type IntentConfidenceDimension =
  | keyof IntentFrame["confidenceByDimension"]
  | "overall";

export type IntentConfidenceGate = {
  dimension: IntentConfidenceDimension;
  min: number;
  severity?: "warning" | "critical";
  reasonCode?: string;
  message?: string;
};

export type IntentConfidenceGateResult = {
  gate: Required<Pick<IntentConfidenceGate, "severity">> &
    Omit<IntentConfidenceGate, "severity">;
  actual: number;
  passed: boolean;
};

export type IntentConfidenceEvaluation = {
  passed: boolean;
  results: IntentConfidenceGateResult[];
  warnings: IntentConfidenceGateResult[];
  critical: IntentConfidenceGateResult[];
};

export function evaluateIntentConfidence(
  intent: IntentFrame,
  gates: IntentConfidenceGate[] = [],
): IntentConfidenceEvaluation {
  const results = gates.map((gate) => {
    const normalizedGate = {
      ...gate,
      severity: gate.severity ?? "warning",
    } satisfies IntentConfidenceGateResult["gate"];
    const actual =
      gate.dimension === "overall"
        ? intent.confidence
        : (intent.confidenceByDimension?.[gate.dimension] ?? 0);

    return {
      gate: normalizedGate,
      actual,
      passed: actual >= gate.min,
    };
  });

  const warnings = results.filter(
    (result) => !result.passed && result.gate.severity === "warning",
  );
  const critical = results.filter(
    (result) => !result.passed && result.gate.severity === "critical",
  );

  return {
    passed: warnings.length === 0 && critical.length === 0,
    results,
    warnings,
    critical,
  };
}

export class IntentConfidenceGateError extends Error {
  constructor(readonly evaluation: IntentConfidenceEvaluation) {
    super(
      `Intent confidence gate failed: ${evaluation.critical
        .map(
          (result) =>
            `${result.gate.dimension}=${result.actual.toFixed(2)} < ${result.gate.min.toFixed(2)}`,
        )
        .join(", ")}`,
    );
    this.name = "IntentConfidenceGateError";
  }
}

export type IntentRuntimeEvent =
  | {
      type: "intent_resolve_started";
      input: {
        promptLength: number;
        historyTurns: number;
        executionContext: IntentRuntimeExecutionContext;
      };
    }
  | {
      type: "intent_resolved";
      intent: IntentFrame;
      source: string;
      durationMs: number;
      diagnostics?: Record<string, unknown>;
    }
  | {
      type: "policy_evaluated";
      evaluation: IntentPolicyEvaluation;
      durationMs: number;
    }
  | {
      type: "confidence_evaluated";
      evaluation: IntentConfidenceEvaluation;
      durationMs: number;
    }
  | {
      type: "clarification_resolved";
      decision: ClarificationDecision;
      durationMs: number;
    }
  | {
      type: "execution_planned";
      plan: IntentExecutionPlan | null;
      durationMs: number;
    }
  | {
      type: "intent_runtime_failed";
      error: string;
      durationMs: number;
    };

export type IntentRuntimeObserver = (
  event: IntentRuntimeEvent,
) => void | Promise<void>;

export type IntentRuntimeConfig = {
  defaultExecutionContext?: IntentRuntimeExecutionContext;
  defaultInteractiveChannel?: boolean;
  confidenceGates?: IntentConfidenceGate[];
  failOnCriticalConfidenceGate?: boolean;
  observer?: IntentRuntimeObserver;
};

export type IntentRuntimeResult = {
  intent: IntentFrame;
  querySubject: QuerySubject;
  clarification: ClarificationDecision;
  executionPlan: IntentExecutionPlan | null;
  source: string;
  diagnostics: {
    resolver?: Record<string, unknown>;
    policy: IntentPolicyEvaluation;
    confidence: IntentConfidenceEvaluation;
    durationsMs: {
      resolve: number;
      policy: number;
      confidence: number;
      clarification: number;
      executionPlan: number;
      total: number;
    };
  };
};

export interface IntentRuntime {
  understand(input: IntentRuntimeInput): Promise<IntentRuntimeResult>;
}

class DefaultClarificationAdapter implements IntentClarificationAdapter {
  async decide(
    input: IntentClarificationAdapterInput,
  ): Promise<ClarificationDecision> {
    return applyClarificationChannelState(
      buildClarificationDecision(input),
      input.interactiveChannel,
    );
  }
}

class DefaultPolicyAdapter implements IntentPolicyAdapter {
  async evaluate(
    input: IntentPolicyAdapterInput,
  ): Promise<IntentPolicyEvaluation> {
    return {
      querySubject: input.intent.subject,
      trace: input.intent.policyTrace ?? [],
    };
  }
}

class DefaultExecutionPlanner implements IntentExecutionPlanner {
  plan(intent: IntentFrame | null): IntentExecutionPlan | null {
    return buildIntentExecutionPlan(intent);
  }
}

export class StaticIntentResolverAdapter implements IntentResolverAdapter {
  constructor(
    private readonly resolveFn: (
      input: IntentResolverAdapterInput,
    ) => Promise<IntentFrame> | IntentFrame,
    private readonly source = "static-intent-resolver",
  ) {}

  async resolve(
    input: IntentResolverAdapterInput,
  ): Promise<IntentResolverAdapterResult> {
    return {
      intent: await this.resolveFn(input),
      source: this.source,
    };
  }
}

export class DefaultIntentRuntime implements IntentRuntime {
  private readonly policy: IntentPolicyAdapter;
  private readonly clarification: IntentClarificationAdapter;
  private readonly executionPlanner: IntentExecutionPlanner;
  private readonly config: Required<
    Pick<
      IntentRuntimeConfig,
      | "defaultExecutionContext"
      | "defaultInteractiveChannel"
      | "confidenceGates"
      | "failOnCriticalConfidenceGate"
    >
  > &
    Pick<IntentRuntimeConfig, "observer">;

  constructor(
    private readonly resolver: IntentResolverAdapter,
    options: {
      policy?: IntentPolicyAdapter;
      clarification?: IntentClarificationAdapter;
      executionPlanner?: IntentExecutionPlanner;
      config?: IntentRuntimeConfig;
    } = {},
  ) {
    this.policy = options.policy ?? new DefaultPolicyAdapter();
    this.clarification =
      options.clarification ?? new DefaultClarificationAdapter();
    this.executionPlanner =
      options.executionPlanner ?? new DefaultExecutionPlanner();
    this.config = {
      defaultExecutionContext:
        options.config?.defaultExecutionContext ?? "interactive",
      defaultInteractiveChannel:
        options.config?.defaultInteractiveChannel ?? true,
      confidenceGates: options.config?.confidenceGates ?? [],
      failOnCriticalConfidenceGate:
        options.config?.failOnCriticalConfidenceGate ?? false,
      observer: options.config?.observer,
    };
  }

  async understand(input: IntentRuntimeInput): Promise<IntentRuntimeResult> {
    const startedAt = Date.now();
    const history = input.history ?? [];
    const now = input.now ?? new Date();
    const executionContext =
      input.executionContext ?? this.config.defaultExecutionContext;
    const interactiveChannel =
      input.interactiveChannel ?? this.config.defaultInteractiveChannel;

    await this.emit({
      type: "intent_resolve_started",
      input: {
        promptLength: input.userPrompt.length,
        historyTurns: history.length,
        executionContext,
      },
    });

    try {
      const resolveStarted = Date.now();
      const resolved = await this.resolver.resolve({
        userPrompt: input.userPrompt,
        history,
        now,
        metadata: input.metadata,
      });
      const resolveMs = Date.now() - resolveStarted;
      await this.emit({
        type: "intent_resolved",
        intent: resolved.intent,
        source: resolved.source,
        durationMs: resolveMs,
        diagnostics: resolved.diagnostics,
      });

      const policyStarted = Date.now();
      const policy = await this.policy.evaluate({
        userPrompt: input.userPrompt,
        intent: resolved.intent,
        history,
        executionContext,
        metadata: input.metadata,
      });
      const policyMs = Date.now() - policyStarted;
      await this.emit({
        type: "policy_evaluated",
        evaluation: policy,
        durationMs: policyMs,
      });

      const confidenceStarted = Date.now();
      const confidence = evaluateIntentConfidence(
        resolved.intent,
        this.config.confidenceGates,
      );
      const confidenceMs = Date.now() - confidenceStarted;
      await this.emit({
        type: "confidence_evaluated",
        evaluation: confidence,
        durationMs: confidenceMs,
      });
      if (
        this.config.failOnCriticalConfidenceGate &&
        confidence.critical.length > 0
      ) {
        throw new IntentConfidenceGateError(confidence);
      }

      const clarificationStarted = Date.now();
      const clarification = await this.clarification.decide({
        userPrompt: input.userPrompt,
        intent: resolved.intent,
        querySubject: policy.querySubject,
        candidateAgents: resolved.intent.candidateAgents ?? [],
        recentHistoryLength: history.length,
        executionContext,
        interactiveChannel,
      });
      const clarificationMs = Date.now() - clarificationStarted;
      await this.emit({
        type: "clarification_resolved",
        decision: clarification,
        durationMs: clarificationMs,
      });

      const executionStarted = Date.now();
      const executionPlan = this.executionPlanner.plan(resolved.intent);
      const executionMs = Date.now() - executionStarted;
      await this.emit({
        type: "execution_planned",
        plan: executionPlan,
        durationMs: executionMs,
      });

      return {
        intent: resolved.intent,
        querySubject: policy.querySubject,
        clarification,
        executionPlan,
        source: resolved.source,
        diagnostics: {
          resolver: resolved.diagnostics,
          policy,
          confidence,
          durationsMs: {
            resolve: resolveMs,
            policy: policyMs,
            confidence: confidenceMs,
            clarification: clarificationMs,
            executionPlan: executionMs,
            total: Date.now() - startedAt,
          },
        },
      };
    } catch (error: any) {
      await this.emit({
        type: "intent_runtime_failed",
        error: error?.message ?? String(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private async emit(event: IntentRuntimeEvent): Promise<void> {
    await this.config.observer?.(event);
  }
}
