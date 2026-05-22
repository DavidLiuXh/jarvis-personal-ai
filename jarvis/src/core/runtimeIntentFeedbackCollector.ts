/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClarificationDecision } from "./clarificationPolicy.js";
import type { ConversationTurn, IntentFrame } from "./intentResolver.js";
import type { RoutingResult } from "./localModelRouter.js";
import type { MemoryRuntimeEvent } from "../memory-runtime/index.js";

export type RuntimeIntentFeedbackConfig = {
  enabled?: boolean;
  outputPath?: string;
  captureAll?: boolean;
  redact?: boolean;
  maxPromptChars?: number;
  maxHistoryTurns?: number;
  maxHistoryChars?: number;
};

export type RuntimeIntentFeedbackInput = {
  sessionId: string;
  userPrompt: string;
  history: ConversationTurn[];
  intent: IntentFrame | null;
  clarification: ClarificationDecision;
  routing: Pick<
    RoutingResult,
    "source" | "model" | "score" | "decision" | "classifierReason"
  >;
  executionContext: "interactive" | "proactive_task";
};

export type RuntimeIntentFeedbackCandidate = {
  source: "runtime_intent_feedback";
  generatedAt: string;
  sessionId: string;
  id: string;
  signals: string[];
  prompt: string;
  history: ConversationTurn[];
  observed: {
    routing: RuntimeIntentFeedbackInput["routing"];
    intent: IntentFrame | null;
    clarification: ClarificationDecision;
    executionContext: RuntimeIntentFeedbackInput["executionContext"];
  };
  candidateCase: {
    id: string;
    prompt: string;
    history: ConversationTurn[];
    expect: Record<string, never>;
    tags: string[];
  };
};

const DEFAULT_OUTPUT_PATH = path.join(
  os.homedir(),
  ".gemini-jarvis",
  "intent-feedback",
  "runtime-intent-candidates-latest.jsonl",
);

const DEFAULT_MAX_PROMPT_CHARS = 800;
const DEFAULT_MAX_HISTORY_TURNS = 6;
const DEFAULT_MAX_HISTORY_CHARS = 240;
const LOW_CONFIDENCE_THRESHOLD = 0.55;

export class RuntimeIntentFeedbackCollector {
  constructor(private readonly config: RuntimeIntentFeedbackConfig = {}) {}

  public record(input: RuntimeIntentFeedbackInput): boolean {
    if (this.config.enabled !== true) return false;
    const signals = collectSignals(input);
    if (signals.length === 0 && this.config.captureAll !== true) return false;

    const candidate = this.buildCandidate(input, signals);
    const outputPath = this.config.outputPath || DEFAULT_OUTPUT_PATH;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, `${JSON.stringify(candidate)}\n`);
    console.error(
      `🧪 [RuntimeIntentFeedback] captured ${candidate.id} signals=${signals.join(",") || "capture_all"} path=${outputPath}`,
    );
    return true;
  }

  public recordMemoryEvent(event: MemoryRuntimeEvent): boolean {
    if (this.config.enabled !== true) return false;
    const signals = collectMemorySignals(event);
    if (signals.length === 0 && this.config.captureAll !== true) return false;

    const generatedAt = new Date().toISOString();
    const id = `memory.${generatedAt.replace(/[^0-9TZ]/g, "")}.${sanitizeId(
      event.sessionId,
    )}`;
    const outputPath = this.config.outputPath || DEFAULT_OUTPUT_PATH;
    const redact = this.config.redact !== false;
    const candidate = {
      source: "runtime_memory_feedback",
      generatedAt,
      sessionId: sanitizeId(event.sessionId),
      id,
      signals,
      observed: sanitizeRuntimeValue(event, redact),
      candidateCase: {
        id: `${id}.candidate`,
        prompt:
          event.type === "intent_resolved"
            ? sanitizeAndTruncate(
                event.prompt,
                this.config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
                redact,
              )
            : "",
        history: [],
        expect: {},
        tags: [
          "runtime-candidate",
          "from-memory-runtime-feedback",
          ...signals.map((signal) => `signal:${signal}`),
        ],
      },
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, `${JSON.stringify(candidate)}\n`);
    console.error(
      `🧪 [RuntimeMemoryFeedback] captured ${id} signals=${signals.join(",") || "capture_all"} path=${outputPath}`,
    );
    return true;
  }

  private buildCandidate(
    input: RuntimeIntentFeedbackInput,
    signals: string[],
  ): RuntimeIntentFeedbackCandidate {
    const generatedAt = new Date().toISOString();
    const id = `runtime.${generatedAt.replace(/[^0-9TZ]/g, "")}.${sanitizeId(
      input.sessionId,
    )}`;
    const prompt = sanitizeAndTruncate(
      input.userPrompt,
      this.config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
      this.config.redact !== false,
    );
    const history = input.history
      .slice(-(this.config.maxHistoryTurns ?? DEFAULT_MAX_HISTORY_TURNS))
      .map((turn) => ({
        role: turn.role,
        content: sanitizeAndTruncate(
          turn.content,
          this.config.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS,
          this.config.redact !== false,
        ),
      }));

    return {
      source: "runtime_intent_feedback",
      generatedAt,
      sessionId: sanitizeId(input.sessionId),
      id,
      signals,
      prompt,
      history,
      observed: {
        routing: sanitizeRuntimeValue(
          input.routing,
          this.config.redact !== false,
        ),
        intent: sanitizeRuntimeValue(
          input.intent,
          this.config.redact !== false,
        ),
        clarification: sanitizeRuntimeValue(
          input.clarification,
          this.config.redact !== false,
        ),
        executionContext: input.executionContext,
      },
      candidateCase: {
        id: `${id}.candidate`,
        prompt,
        history,
        expect: {},
        tags: [
          "runtime-candidate",
          "from-runtime-feedback",
          ...signals.map((signal) => `signal:${signal}`),
        ],
      },
    };
  }
}

export function collectMemorySignals(event: MemoryRuntimeEvent): string[] {
  const signals = new Set<string>();

  if (event.type === "memory_retrieved") {
    const retrieved =
      event.result.session.length +
      event.result.facts.length +
      event.result.entries.length;
    if (event.contract.needMemory && retrieved === 0) {
      signals.add("memory_retrieval_empty");
    }
    if (
      event.contract.subjectBoundary === "external" &&
      (event.result.facts.length > 0 || event.result.entries.length > 0)
    ) {
      signals.add("external_memory_leakage");
    }
  }

  if (event.type === "memory_injected") {
    if (event.result.rejected.length > 0) {
      signals.add("memory_injection_rejected");
    }
    if (event.contract.needMemory && event.result.usedChars === 0) {
      signals.add("memory_injection_empty");
    }
  }

  if (event.type === "runtime_feedback") {
    signals.add(event.signal);
  }

  return Array.from(signals);
}

export function collectSignals(input: RuntimeIntentFeedbackInput): string[] {
  const signals = new Set<string>();
  const { intent, clarification, routing } = input;

  if (routing.source === "local-router/fallback" || intent === null) {
    signals.add("router_fallback");
  }
  if (intent?.evidence.includes("deterministic_parse_fallback")) {
    signals.add("deterministic_parse_fallback");
  }
  if (
    intent?.policyTrace.some((entry) => entry.reason.severity === "critical")
  ) {
    signals.add("critical_policy_correction");
  }
  if (
    intent?.policyTrace.some((entry) => entry.reason.severity === "warning")
  ) {
    signals.add("warning_policy_correction");
  }
  if (intent?.topicAnalysis.lowGrounding === true) {
    signals.add("topic_low_grounding");
  }
  if (intent && hasLowConfidenceDimension(intent)) {
    signals.add("low_confidence_dimension");
  }
  if (clarification.shouldAsk) {
    signals.add("clarification_requested");
  }
  if (clarification.blocking) {
    signals.add("clarification_blocking");
  }
  if (clarification.state === "blocked_without_channel") {
    signals.add("clarification_blocked_without_channel");
  }

  return Array.from(signals);
}

function hasLowConfidenceDimension(intent: IntentFrame): boolean {
  return Object.values(intent.confidenceByDimension).some(
    (value) => value < LOW_CONFIDENCE_THRESHOLD,
  );
}

function sanitizeAndTruncate(
  value: string,
  maxChars: number,
  redact: boolean,
): string {
  const sanitized = redact ? redactSensitiveText(value) : value;
  return sanitized.length <= maxChars
    ? sanitized
    : `${sanitized.slice(0, Math.max(0, maxChars - 20))}...[truncated]`;
}

function sanitizeRuntimeValue<T>(value: T, redact: boolean): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === "string"
        ? sanitizeAndTruncate(nested, 500, redact)
        : nested,
    ),
  ) as T;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted_email]")
    .replace(/\b(?:\+?\d[\d -]{7,}\d)\b/g, "[redacted_phone]")
    .replace(
      /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[^"',\s]+/gi,
      "[redacted_secret]",
    );
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "unknown";
}
