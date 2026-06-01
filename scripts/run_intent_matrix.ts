#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConversationTurn,
  IntentFrame,
} from "../jarvis/src/memory-runtime/types.js";
import type {
  IntentModelClient,
  IntentModelClientRequest,
} from "../jarvis/src/memory-runtime/adapters.js";
import {
  buildIntentAwareMemoryPolicy,
  type IntentAwareMemoryPolicy,
} from "../jarvis/src/memory-runtime/intentAwareMemoryPolicy.js";
import type { ClarificationDecision } from "../jarvis/src/memory-runtime/clarificationPolicy.js";
import {
  buildIntentExecutionPlan,
  IntentStepRuntime,
  type FunctionResponseLike,
  type ToolCallLike,
} from "../jarvis/src/intent-runtime/executionPlan.js";
import { DefaultIntentRuntime } from "../jarvis/src/intent-runtime/index.js";
import { JarvisIntentResolverAdapter } from "../jarvis/src/core/jarvisIntentResolverAdapter.js";

type MatrixDimension =
  | "memoryTarget"
  | "topicBoundary"
  | "actionBoundary"
  | "multiIntent"
  | "memoryPolicy"
  | "agentRouting"
  | "clarification"
  | "executionContract";

type MatrixCase = {
  id: string;
  dimension: MatrixDimension;
  invariant: string;
  principles?: string[];
  axes?: Record<string, string>;
  prompt: string;
  history?: ConversationTurn[];
  now?: string;
  model?: Record<string, unknown>;
  focusedResponses?: Array<Record<string, unknown>>;
  expect: MatrixExpectation;
  tags?: string[];
};

type MatrixExpectation = {
  subject?: IntentFrame["subject"];
  taskType?: IntentFrame["taskType"];
  needsMemory?: boolean;
  needsExternalKnowledge?: boolean;
  needsTool?: boolean;
  needsScheduling?: boolean;
  referencesRecentHistory?: boolean;
  topicShifted?: boolean;
  memoryTarget?: IntentFrame["semanticEvidence"]["memoryRecall"]["target"];
  dateFrom?: string | null;
  dateTo?: string | null;
  topicRelation?: IntentFrame["topicAnalysis"]["relation"];
  topicRelationOneOf?: IntentFrame["topicAnalysis"]["relation"][];
  topicCurrentEvidenceContains?: string[];
  candidateAgentsContain?: string[];
  candidateAgentsNotContain?: string[];
  intentStepCount?: number;
  intentStepOrder?: Array<IntentFrame["intentSteps"][number]["type"]>;
  policyReasonCodesContain?: string[];
  policyReasonCodesNotContain?: string[];
  clarification?: {
    executionContext?: "interactive" | "proactive_task";
    interactiveChannel?: boolean;
    state?: ClarificationDecision["state"];
    scope?: ClarificationDecision["scope"];
    shouldAsk?: boolean;
    blocking?: boolean;
    reasonsContain?: string[];
    reasonsNotContain?: string[];
    stepRequirementsContain?: Array<{
      stepType?: IntentFrame["intentSteps"][number]["type"];
      reason?: string;
      blocking?: boolean;
    }>;
  };
  memoryPolicy?: {
    allowFacts?: boolean;
    allowSummary?: boolean;
    allowPrewarm?: boolean;
    targetScopes?: Array<
      IntentAwareMemoryPolicy["contract"]["targetScopes"][number]
    >;
    reasonsContain?: string[];
    reasonsNotContain?: string[];
  };
  executionContract?: {
    mode?: "single_llm" | "orchestrated";
    requiredToolsContain?: string[];
    requiredToolsNotContain?: string[];
    stepModes?: string[];
    initialStatuses?: string[];
    missingPromptContains?: string[];
    deterministicToolRequestsContain?: string[];
    suppressDependentToolCall?: {
      request: ToolCallLike;
      suppressedStepId: string;
      reasonContains?: string;
    };
    failedToolBlocksAfterAttempts?: {
      request: ToolCallLike;
      response: FunctionResponseLike;
      expectedStatus: string;
    };
  };
  calibration?: {
    minConfidence?: number;
    confidenceFloors?: Partial<
      Record<keyof IntentFrame["confidenceByDimension"], number>
    >;
  };
};

type CheckResult = {
  key: string;
  pass: boolean;
  expected: unknown;
  actual: unknown;
};

type CaseResult = {
  id: string;
  dimension: MatrixDimension;
  run: number;
  invariant: string;
  principles: string[];
  axes: Record<string, string>;
  tags: string[];
  passed: boolean;
  durationMs: number;
  checks: CheckResult[];
  intent?: IntentFrame;
  clarification?: ClarificationDecision;
  memoryPolicy?: IntentAwareMemoryPolicy;
  executionPlan?: ReturnType<typeof buildIntentExecutionPlan>;
  error?: string;
};

type CountMap = Record<string, number>;

type IntentMatrixTrend = {
  distributions: {
    subject: CountMap;
    taskType: CountMap;
    memoryTarget: CountMap;
    riskLevel: CountMap;
    clarificationState: CountMap;
  };
  rates: {
    policyCorrection: number;
    jsonRepair: number;
    fallback: number;
    clarificationBlock: number;
    executionContractEnforcement: number;
    toolFailure: number;
    toolRetry: number;
    toolBlocked: number;
    memoryInjectionEmpty: number;
    memoryRejected: number;
  };
  counts: {
    total: number;
    passed: number;
    failed: number;
    policyCorrections: number;
    jsonRepairs: number;
    fallbacks: number;
    clarificationBlocks: number;
    executionContractEnforcements: number;
    toolFailures: number;
    toolRetries: number;
    toolBlocked: number;
    memoryInjectionEmpty: number;
    memoryRejected: number;
    runtimeFeedbackCandidates: number;
  };
  policyReasonCodes: CountMap;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultCasePaths = [
  path.join(repoRoot, "evals/intent/matrix-cases.jsonl"),
  path.join(repoRoot, "evals/intent/semantic-space-cases.jsonl"),
  path.join(repoRoot, "evals/intent/execution-contract-cases.jsonl"),
  path.join(repoRoot, "evals/intent/reviewed-runtime-cases.jsonl"),
];
const defaultOutputDir = path.join(repoRoot, "evals/logs");
const defaultNow = "2026-05-26T04:00:00.000Z";

function parseArgs(argv: string[]) {
  const args = {
    casesPaths: [...defaultCasePaths],
    outputDir: defaultOutputDir,
    tag: "",
    invariant: "",
    dimension: "" as "" | MatrixDimension,
    limit: 0,
    repeat: 1,
    confidenceFloor: 0,
    updateLatest: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cases" && next) {
      args.casesPaths = next
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => path.resolve(item));
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      i += 1;
    } else if (arg === "--tag" && next) {
      args.tag = next;
      i += 1;
    } else if (arg === "--invariant" && next) {
      args.invariant = next;
      i += 1;
    } else if (arg === "--dimension" && next) {
      args.dimension = next as MatrixDimension;
      i += 1;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      i += 1;
    } else if (arg === "--repeat" && next) {
      args.repeat = Number(next);
      i += 1;
    } else if (arg === "--confidence-floor" && next) {
      args.confidenceFloor = Number(next);
      i += 1;
    } else if (arg === "--no-latest") {
      args.updateLatest = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error(`Invalid --limit: ${args.limit}`);
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 1) {
    throw new Error(`Invalid --repeat: ${args.repeat}`);
  }
  if (
    !Number.isFinite(args.confidenceFloor) ||
    args.confidenceFloor < 0 ||
    args.confidenceFloor > 1
  ) {
    throw new Error(`Invalid --confidence-floor: ${args.confidenceFloor}`);
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  npx tsx scripts/run_intent_matrix.ts [options]

Options:
  --cases <paths>      Comma-separated JSONL case files. Default: matrix + semantic-space
  --output-dir <path>  Report directory. Default: evals/logs
  --dimension <name>   Run one taxonomy dimension
  --invariant <id>     Run one invariant id
  --tag <tag>          Run cases with a tag
  --limit <n>          Run the first n selected cases
  --repeat <n>         Repeat selected cases to measure stability
  --confidence-floor <n>
                       Global confidence floor for every dimension, 0..1
  --no-latest          Do not update intent-matrix-latest.md/json
`);
}

function readCasesFile(casesPath: string): MatrixCase[] {
  if (!fs.existsSync(casesPath)) return [];
  const text = fs.readFileSync(casesPath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line) as MatrixCase;
      } catch (error: any) {
        throw new Error(
          `Failed to parse ${casesPath}:${index + 1}: ${error.message}`,
        );
      }
    });
}

function readCases(casesPaths: string[]): MatrixCase[] {
  const cases = casesPaths.flatMap((casesPath) => readCasesFile(casesPath));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const evalCase of cases) {
    if (seen.has(evalCase.id)) duplicates.add(evalCase.id);
    seen.add(evalCase.id);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate matrix case id(s): ${Array.from(duplicates).join(", ")}`,
    );
  }
  return cases;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  patch: Record<string, unknown> | undefined,
): T {
  if (!patch) return { ...base };
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = output[key];
    output[key] =
      isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return output as T;
}

function baseRawIntent(prompt: string): Record<string, unknown> {
  return {
    complexity_score: 50,
    knowledge_score: 50,
    operation_score: 50,
    complexity_reasoning: "deterministic matrix case",
    query_subject: "external",
    task_type: "analyze",
    needs_external_knowledge: false,
    needs_tool: false,
    needs_scheduling: false,
    candidate_agents: [],
    confidence: 0.95,
    confidence_by_dimension: {
      subject: 0.95,
      taskType: 0.95,
      memoryTarget: 0.95,
      action: 0.95,
      entityHints: 0.95,
      topicShift: 0.95,
      richIntent: 0.95,
    },
    evidence: ["matrix_case"],
    semantic_evidence: {
      personalContext: { present: false, reason: "", span: "" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: { present: false, action: "none", object: "" },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    references_recent_history: false,
    topic_shifted: false,
    rich_intent: {
      userGoal: prompt,
      domain: "unknown",
      action: "answer",
      targets: [],
      contextDependency: {
        recentConversation: false,
        longTermMemory: false,
        externalWorld: false,
        localWorkspace: false,
      },
      ambiguity: [],
      riskLevel: "low",
    },
    intent_steps: [],
    topic_analysis: {
      relation: "unknown",
      history: {
        label: "",
        evidence: [],
        source_turns: [],
        confidence: 0,
      },
      current: {
        label: prompt.slice(0, 80),
        evidence: [prompt],
        source_turns: [0],
        confidence: 0.9,
      },
      relation_reason: "deterministic matrix case",
      confidence: 0.9,
      low_grounding: false,
    },
  };
}

class MatrixIntentModelClient implements IntentModelClient {
  private readonly responses: string[];

  constructor(
    raw: Record<string, unknown>,
    focused: Array<Record<string, unknown>>,
  ) {
    this.responses = [
      JSON.stringify(raw),
      ...focused.map((response) => JSON.stringify(response)),
    ];
  }

  async generateJson(input: IntentModelClientRequest): Promise<string> {
    const next = this.responses.shift();
    if (next !== undefined) return next;
    if (input.prompt.includes('"tickers"')) {
      return JSON.stringify({
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      });
    }
    if (input.prompt.includes('"target"')) {
      return JSON.stringify({
        present: false,
        target: "none",
        reason: "matrix default",
        span: "",
      });
    }
    return JSON.stringify(baseRawIntent(""));
  }
}

function addCheck(
  checks: CheckResult[],
  key: string,
  expected: unknown,
  actual: unknown,
  pass: boolean,
) {
  checks.push({ key, expected, actual, pass });
}

function includesAll(
  actual: string[],
  expected: string[] | undefined,
): boolean {
  if (!expected || expected.length === 0) return true;
  return expected.every((item) => actual.includes(item));
}

function includesNone(
  actual: string[],
  expected: string[] | undefined,
): boolean {
  if (!expected || expected.length === 0) return true;
  return expected.every((item) => !actual.includes(item));
}

function arrayEquals(actual: unknown[], expected: unknown[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function textContainsAll(actual: string[], expected: string[] | undefined) {
  if (!expected || expected.length === 0) return true;
  const text = actual.join("\n").toLowerCase();
  return expected.every((item) => text.includes(item.toLowerCase()));
}

function compareCase(
  evalCase: MatrixCase,
  intent: IntentFrame,
  memoryPolicy: IntentAwareMemoryPolicy,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const expect = evalCase.expect;

  for (const key of [
    "subject",
    "taskType",
    "needsMemory",
    "needsExternalKnowledge",
    "needsTool",
    "needsScheduling",
    "referencesRecentHistory",
    "topicShifted",
    "dateFrom",
    "dateTo",
  ] as const) {
    if (expect[key] !== undefined) {
      addCheck(
        checks,
        key,
        expect[key],
        intent[key],
        intent[key] === expect[key],
      );
    }
  }

  if (expect.memoryTarget !== undefined) {
    addCheck(
      checks,
      "memoryTarget",
      expect.memoryTarget,
      intent.semanticEvidence.memoryRecall.target,
      intent.semanticEvidence.memoryRecall.target === expect.memoryTarget,
    );
  }
  if (expect.topicRelation !== undefined) {
    addCheck(
      checks,
      "topicRelation",
      expect.topicRelation,
      intent.topicAnalysis.relation,
      intent.topicAnalysis.relation === expect.topicRelation,
    );
  }
  if (expect.topicRelationOneOf !== undefined) {
    addCheck(
      checks,
      "topicRelationOneOf",
      expect.topicRelationOneOf,
      intent.topicAnalysis.relation,
      expect.topicRelationOneOf.includes(intent.topicAnalysis.relation),
    );
  }
  if (expect.topicCurrentEvidenceContains !== undefined) {
    addCheck(
      checks,
      "topicCurrentEvidenceContains",
      expect.topicCurrentEvidenceContains,
      intent.topicAnalysis.current.evidence,
      textContainsAll(
        [
          intent.topicAnalysis.current.label,
          ...intent.topicAnalysis.current.evidence,
        ],
        expect.topicCurrentEvidenceContains,
      ),
    );
  }
  if (expect.candidateAgentsContain !== undefined) {
    addCheck(
      checks,
      "candidateAgentsContain",
      expect.candidateAgentsContain,
      intent.candidateAgents,
      includesAll(intent.candidateAgents, expect.candidateAgentsContain),
    );
  }
  if (expect.candidateAgentsNotContain !== undefined) {
    addCheck(
      checks,
      "candidateAgentsNotContain",
      expect.candidateAgentsNotContain,
      intent.candidateAgents,
      includesNone(intent.candidateAgents, expect.candidateAgentsNotContain),
    );
  }
  if (expect.intentStepCount !== undefined) {
    addCheck(
      checks,
      "intentStepCount",
      expect.intentStepCount,
      intent.intentSteps.length,
      intent.intentSteps.length === expect.intentStepCount,
    );
  }
  if (expect.intentStepOrder !== undefined) {
    const actual = intent.intentSteps.map((step) => step.type);
    addCheck(
      checks,
      "intentStepOrder",
      expect.intentStepOrder,
      actual,
      arrayEquals(actual, expect.intentStepOrder),
    );
  }

  const reasonCodes = intent.policyTrace.map((entry) => entry.reasonCode);
  if (expect.policyReasonCodesContain !== undefined) {
    addCheck(
      checks,
      "policyReasonCodesContain",
      expect.policyReasonCodesContain,
      reasonCodes,
      includesAll(reasonCodes, expect.policyReasonCodesContain),
    );
  }
  if (expect.policyReasonCodesNotContain !== undefined) {
    addCheck(
      checks,
      "policyReasonCodesNotContain",
      expect.policyReasonCodesNotContain,
      reasonCodes,
      includesNone(reasonCodes, expect.policyReasonCodesNotContain),
    );
  }

  const policyExpect = expect.memoryPolicy;
  if (policyExpect) {
    for (const key of ["allowFacts", "allowSummary", "allowPrewarm"] as const) {
      if (policyExpect[key] !== undefined) {
        addCheck(
          checks,
          `memoryPolicy.${key}`,
          policyExpect[key],
          memoryPolicy[key],
          memoryPolicy[key] === policyExpect[key],
        );
      }
    }
    if (policyExpect.targetScopes !== undefined) {
      addCheck(
        checks,
        "memoryPolicy.targetScopes",
        policyExpect.targetScopes,
        memoryPolicy.contract.targetScopes,
        arrayEquals(
          memoryPolicy.contract.targetScopes,
          policyExpect.targetScopes,
        ),
      );
    }
    if (policyExpect.reasonsContain !== undefined) {
      addCheck(
        checks,
        "memoryPolicy.reasonsContain",
        policyExpect.reasonsContain,
        memoryPolicy.reasons,
        includesAll(memoryPolicy.reasons, policyExpect.reasonsContain),
      );
    }
    if (policyExpect.reasonsNotContain !== undefined) {
      addCheck(
        checks,
        "memoryPolicy.reasonsNotContain",
        policyExpect.reasonsNotContain,
        memoryPolicy.reasons,
        includesNone(memoryPolicy.reasons, policyExpect.reasonsNotContain),
      );
    }
  }

  return checks;
}

function compareClarification(
  decision: ClarificationDecision,
  expect: MatrixExpectation["clarification"],
): CheckResult[] {
  const checks: CheckResult[] = [];
  if (!expect) return checks;

  for (const key of ["state", "scope", "shouldAsk", "blocking"] as const) {
    if (expect[key] !== undefined) {
      addCheck(
        checks,
        `clarification.${key}`,
        expect[key],
        decision[key],
        decision[key] === expect[key],
      );
    }
  }
  if (expect.reasonsContain !== undefined) {
    addCheck(
      checks,
      "clarification.reasonsContain",
      expect.reasonsContain,
      decision.reasons,
      includesAll(decision.reasons, expect.reasonsContain),
    );
  }
  if (expect.reasonsNotContain !== undefined) {
    addCheck(
      checks,
      "clarification.reasonsNotContain",
      expect.reasonsNotContain,
      decision.reasons,
      includesNone(decision.reasons, expect.reasonsNotContain),
    );
  }
  if (expect.stepRequirementsContain !== undefined) {
    for (const requirement of expect.stepRequirementsContain) {
      addCheck(
        checks,
        "clarification.stepRequirementsContain",
        requirement,
        decision.stepRequirements,
        decision.stepRequirements.some(
          (actual) =>
            (requirement.stepType === undefined ||
              actual.stepType === requirement.stepType) &&
            (requirement.reason === undefined ||
              actual.reason === requirement.reason) &&
            (requirement.blocking === undefined ||
              actual.blocking === requirement.blocking),
        ),
      );
    }
  }

  return checks;
}

function compareExecutionContract(
  intent: IntentFrame,
  expect: MatrixExpectation["executionContract"],
): {
  checks: CheckResult[];
  plan: ReturnType<typeof buildIntentExecutionPlan>;
} {
  const checks: CheckResult[] = [];
  const plan = buildIntentExecutionPlan(intent);
  if (!expect) return { checks, plan };

  if (expect.mode !== undefined) {
    addCheck(
      checks,
      "executionContract.mode",
      expect.mode,
      plan?.mode ?? null,
      plan?.mode === expect.mode,
    );
  }
  if (expect.requiredToolsContain !== undefined) {
    addCheck(
      checks,
      "executionContract.requiredToolsContain",
      expect.requiredToolsContain,
      plan?.requiredTools ?? [],
      includesAll(plan?.requiredTools ?? [], expect.requiredToolsContain),
    );
  }
  if (expect.requiredToolsNotContain !== undefined) {
    addCheck(
      checks,
      "executionContract.requiredToolsNotContain",
      expect.requiredToolsNotContain,
      plan?.requiredTools ?? [],
      includesNone(plan?.requiredTools ?? [], expect.requiredToolsNotContain),
    );
  }
  if (expect.stepModes !== undefined) {
    const actual = plan?.steps.map((step) => step.mode) ?? [];
    addCheck(
      checks,
      "executionContract.stepModes",
      expect.stepModes,
      actual,
      arrayEquals(actual, expect.stepModes),
    );
  }

  const runtime = new IntentStepRuntime(intent);
  if (expect.initialStatuses !== undefined) {
    const actual = runtime.snapshot().map((entry) => entry.status);
    addCheck(
      checks,
      "executionContract.initialStatuses",
      expect.initialStatuses,
      actual,
      arrayEquals(actual, expect.initialStatuses),
    );
  }
  if (expect.missingPromptContains !== undefined) {
    const prompt = runtime.buildMissingStepPrompt() ?? "";
    addCheck(
      checks,
      "executionContract.missingPromptContains",
      expect.missingPromptContains,
      prompt,
      expect.missingPromptContains.every((item) => prompt.includes(item)),
    );
  }
  if (expect.deterministicToolRequestsContain !== undefined) {
    const actual = runtime
      .buildDeterministicToolRequests()
      .map((request) => request.name);
    addCheck(
      checks,
      "executionContract.deterministicToolRequestsContain",
      expect.deterministicToolRequestsContain,
      actual,
      includesAll(actual, expect.deterministicToolRequestsContain),
    );
  }
  if (expect.suppressDependentToolCall !== undefined) {
    const result = runtime.filterDuplicateToolCalls([
      expect.suppressDependentToolCall.request,
    ]);
    const suppressed = result.suppressed[0];
    addCheck(
      checks,
      "executionContract.suppressDependentToolCall",
      expect.suppressDependentToolCall,
      suppressed ?? null,
      result.executableRequests.length === 0 &&
        suppressed?.stepId ===
          expect.suppressDependentToolCall.suppressedStepId &&
        (expect.suppressDependentToolCall.reasonContains === undefined ||
          (suppressed.reason ?? "").includes(
            expect.suppressDependentToolCall.reasonContains,
          )),
    );
  }
  if (expect.failedToolBlocksAfterAttempts !== undefined) {
    const request = expect.failedToolBlocksAfterAttempts.request;
    const response = expect.failedToolBlocksAfterAttempts.response;
    runtime.filterDuplicateToolCalls([request]);
    runtime.observeToolResults([request], [response]);
    runtime.filterDuplicateToolCalls([request]);
    runtime.observeToolResults([request], [response]);
    const actual = runtime.snapshot()[0]?.status ?? "none";
    addCheck(
      checks,
      "executionContract.failedToolBlocksAfterAttempts",
      expect.failedToolBlocksAfterAttempts.expectedStatus,
      actual,
      actual === expect.failedToolBlocksAfterAttempts.expectedStatus,
    );
  }

  return { checks, plan };
}

function compareCalibration(
  intent: IntentFrame,
  expect: MatrixExpectation["calibration"],
  globalConfidenceFloor: number,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const minConfidence = expect?.minConfidence ?? globalConfidenceFloor;
  if (minConfidence > 0) {
    addCheck(
      checks,
      "calibration.minConfidence",
      minConfidence,
      intent.confidence,
      intent.confidence >= minConfidence,
    );
  }
  for (const [dimension, floor] of Object.entries(
    expect?.confidenceFloors ?? {},
  )) {
    const actual =
      intent.confidenceByDimension[
        dimension as keyof IntentFrame["confidenceByDimension"]
      ];
    addCheck(
      checks,
      `calibration.${dimension}`,
      floor,
      actual,
      typeof floor === "number" && actual >= floor,
    );
  }
  return checks;
}

async function runCase(
  evalCase: MatrixCase,
  options: { run: number; confidenceFloor: number },
): Promise<CaseResult> {
  const startedAt = Date.now();
  try {
    const raw = deepMerge(baseRawIntent(evalCase.prompt), evalCase.model);
    const client = new MatrixIntentModelClient(
      raw,
      evalCase.focusedResponses ?? [],
    );
    const runtime = new DefaultIntentRuntime(
      new JarvisIntentResolverAdapter({
        modelClient: client,
        modelSource: "intent-matrix/fake-model",
        historyTurns: 8,
      }),
    );
    const runtimeResult = await runtime.understand({
      userPrompt: evalCase.prompt,
      history: evalCase.history ?? [],
      now: new Date(evalCase.now ?? defaultNow),
      executionContext:
        evalCase.expect.clarification?.executionContext ?? "interactive",
      interactiveChannel:
        evalCase.expect.clarification?.interactiveChannel ?? true,
    });
    const intent = runtimeResult.intent;
    const memoryPolicy = buildIntentAwareMemoryPolicy({
      userPrompt: evalCase.prompt,
      querySubject: intent.subject,
      intent,
      config: {
        prewarmLimit: 3,
        prewarmLimitMixed: 2,
        memoryMaxDistance: 1,
        prewarmMaxDistanceMixed: 0.95,
      },
    });
    const clarification = runtimeResult.clarification;
    const checks = [
      ...compareCase(evalCase, intent, memoryPolicy),
      ...compareClarification(clarification, evalCase.expect.clarification),
      ...compareCalibration(
        intent,
        evalCase.expect.calibration,
        options.confidenceFloor,
      ),
    ];
    const execution = compareExecutionContract(
      intent,
      evalCase.expect.executionContract,
    );
    checks.push(...execution.checks);
    return {
      id: evalCase.id,
      dimension: evalCase.dimension,
      run: options.run,
      invariant: evalCase.invariant,
      principles: evalCase.principles ?? [],
      axes: evalCase.axes ?? {},
      tags: evalCase.tags ?? [],
      passed: checks.every((check) => check.pass),
      durationMs: Date.now() - startedAt,
      checks,
      intent,
      clarification,
      memoryPolicy,
      executionPlan: execution.plan,
    };
  } catch (error: any) {
    return {
      id: evalCase.id,
      dimension: evalCase.dimension,
      run: options.run,
      invariant: evalCase.invariant,
      principles: evalCase.principles ?? [],
      axes: evalCase.axes ?? {},
      tags: evalCase.tags ?? [],
      passed: false,
      durationMs: Date.now() - startedAt,
      checks: [],
      error: error.message,
    };
  }
}

function summarizeBy<T extends string>(
  results: CaseResult[],
  getKey: (result: CaseResult) => T,
) {
  const stats: Record<string, { passed: number; total: number }> = {};
  for (const result of results) {
    const key = getKey(result);
    stats[key] ??= { passed: 0, total: 0 };
    stats[key].total += 1;
    if (result.passed) stats[key].passed += 1;
  }
  return stats;
}

function summarizeAxes(results: CaseResult[]) {
  const stats: Record<string, { passed: number; total: number }> = {};
  for (const result of results) {
    for (const [axis, value] of Object.entries(result.axes)) {
      const key = `${axis}:${value}`;
      stats[key] ??= { passed: 0, total: 0 };
      stats[key].total += 1;
      if (result.passed) stats[key].passed += 1;
    }
  }
  return stats;
}

function increment(map: CountMap, key: string | null | undefined) {
  const normalized = key || "unknown";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : Number((count / total).toFixed(4));
}

function runtimeFeedbackCandidateCount(): number {
  const candidatePath = path.join(
    repoRoot,
    "evals/intent/candidates/intent-eval-candidates-latest.jsonl",
  );
  if (!fs.existsSync(candidatePath)) return 0;
  return fs
    .readFileSync(candidatePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim()).length;
}

function buildTrend(results: CaseResult[]): IntentMatrixTrend {
  const distributions: IntentMatrixTrend["distributions"] = {
    subject: {},
    taskType: {},
    memoryTarget: {},
    riskLevel: {},
    clarificationState: {},
  };
  const policyReasonCodes: CountMap = {};
  let policyCorrections = 0;
  let jsonRepairs = 0;
  let fallbacks = 0;
  let clarificationBlocks = 0;
  let executionContractEnforcements = 0;
  let toolFailures = 0;
  let toolRetries = 0;
  let toolBlocked = 0;
  let memoryInjectionEmpty = 0;
  let memoryRejected = 0;

  for (const result of results) {
    const intent = result.intent;
    increment(distributions.subject, intent?.subject);
    increment(distributions.taskType, intent?.taskType);
    increment(
      distributions.memoryTarget,
      intent?.semanticEvidence?.memoryRecall?.target,
    );
    increment(distributions.riskLevel, intent?.richIntent?.riskLevel);
    increment(distributions.clarificationState, result.clarification?.state);

    const appliedPolicy = intent?.policyTrace?.filter((entry) => entry.applied);
    if (appliedPolicy && appliedPolicy.length > 0) {
      policyCorrections += 1;
      for (const entry of appliedPolicy) {
        increment(policyReasonCodes, entry.reasonCode);
      }
    }
    if (String(intent?.source ?? "").includes("repair")) jsonRepairs += 1;
    if (String(intent?.source ?? "").includes("fallback")) fallbacks += 1;
    if (result.error?.toLowerCase().includes("repair")) jsonRepairs += 1;
    if (result.error?.toLowerCase().includes("fallback")) fallbacks += 1;

    if (result.clarification?.blocking) clarificationBlocks += 1;
    if ((result.executionPlan?.requiredTools?.length ?? 0) > 0) {
      executionContractEnforcements += 1;
    }
    const failedChecks = result.checks.filter((check) => !check.pass);
    if (
      failedChecks.some((check) =>
        check.key.toLowerCase().includes("failedtool"),
      )
    ) {
      toolFailures += 1;
    }
    if (
      failedChecks.some((check) => check.key.toLowerCase().includes("blocked"))
    ) {
      toolBlocked += 1;
    }
    if (result.memoryPolicy && !result.memoryPolicy.contract.needMemory) {
      memoryInjectionEmpty += 1;
    }
    if (
      result.memoryPolicy?.reasons.some((reason) => reason.includes("reject"))
    ) {
      memoryRejected += 1;
    }
  }

  const total = results.length;
  return {
    distributions,
    rates: {
      policyCorrection: rate(policyCorrections, total),
      jsonRepair: rate(jsonRepairs, total),
      fallback: rate(fallbacks, total),
      clarificationBlock: rate(clarificationBlocks, total),
      executionContractEnforcement: rate(executionContractEnforcements, total),
      toolFailure: rate(toolFailures, total),
      toolRetry: rate(toolRetries, total),
      toolBlocked: rate(toolBlocked, total),
      memoryInjectionEmpty: rate(memoryInjectionEmpty, total),
      memoryRejected: rate(memoryRejected, total),
    },
    counts: {
      total,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      policyCorrections,
      jsonRepairs,
      fallbacks,
      clarificationBlocks,
      executionContractEnforcements,
      toolFailures,
      toolRetries,
      toolBlocked,
      memoryInjectionEmpty,
      memoryRejected,
      runtimeFeedbackCandidates: runtimeFeedbackCandidateCount(),
    },
    policyReasonCodes,
  };
}

function formatStats(stats: Record<string, { passed: number; total: number }>) {
  return Object.entries(stats)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const rate = value.total === 0 ? 0 : value.passed / value.total;
      return `| ${key} | ${value.passed}/${value.total} | ${(rate * 100).toFixed(1)}% |`;
    })
    .join("\n");
}

function buildMarkdownReport(results: CaseResult[], casesPaths: string[]) {
  const passed = results.filter((result) => result.passed).length;
  const total = results.length;
  const dimensionStats = summarizeBy(results, (result) => result.dimension);
  const invariantStats = summarizeBy(results, (result) => result.invariant);
  const axisStats = summarizeAxes(results);
  const modelStats = summarizeBy(
    results,
    (result) => result.intent?.source ?? "error",
  );
  const repeatStats = summarizeBy(results, (result) => `run-${result.run}`);
  const failed = results.filter((result) => !result.passed);
  const lines: string[] = [
    "# Intent Matrix Eval Report",
    "",
    `- Cases: ${passed}/${total}`,
    `- Pass rate: ${total === 0 ? "0.0" : ((passed / total) * 100).toFixed(1)}%`,
    `- Cases files: ${casesPaths.map((casesPath) => path.relative(repoRoot, casesPath)).join(", ")}`,
    `- Generated: ${new Date().toISOString()}`,
    "",
    "## By Dimension",
    "",
    "| Dimension | Pass | Rate |",
    "| --- | ---: | ---: |",
    formatStats(dimensionStats),
    "",
    "## By Invariant",
    "",
    "| Invariant | Pass | Rate |",
    "| --- | ---: | ---: |",
    formatStats(invariantStats),
    "",
    "## By Semantic Axis",
    "",
    "| Axis | Pass | Rate |",
    "| --- | ---: | ---: |",
    formatStats(axisStats),
    "",
    "## By Model Source",
    "",
    "| Model Source | Pass | Rate |",
    "| --- | ---: | ---: |",
    formatStats(modelStats),
    "",
    "## By Repeat",
    "",
    "| Repeat | Pass | Rate |",
    "| --- | ---: | ---: |",
    formatStats(repeatStats),
  ];

  if (failed.length > 0) {
    lines.push("", "## Failures", "");
    for (const result of failed) {
      lines.push(`### ${result.id}`, "");
      lines.push(`- Dimension: ${result.dimension}`);
      lines.push(`- Run: ${result.run}`);
      lines.push(`- Invariant: ${result.invariant}`);
      if (result.error) {
        lines.push(`- Error: ${result.error}`);
      }
      for (const check of result.checks.filter((item) => !item.pass)) {
        lines.push(
          `- ${check.key}: expected ${JSON.stringify(check.expected)}, actual ${JSON.stringify(check.actual)}`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cases = readCases(args.casesPaths);
  if (args.dimension) {
    cases = cases.filter((evalCase) => evalCase.dimension === args.dimension);
  }
  if (args.invariant) {
    cases = cases.filter((evalCase) => evalCase.invariant === args.invariant);
  }
  if (args.tag) {
    cases = cases.filter((evalCase) => evalCase.tags?.includes(args.tag));
  }
  if (args.limit > 0) {
    cases = cases.slice(0, args.limit);
  }
  if (cases.length === 0) {
    throw new Error("No matrix cases selected.");
  }

  const results: CaseResult[] = [];
  for (let run = 1; run <= args.repeat; run += 1) {
    for (const evalCase of cases) {
      const result = await runCase(evalCase, {
        run,
        confidenceFloor: args.confidenceFloor,
      });
      results.push(result);
      const status = result.passed ? "PASS" : "FAIL";
      console.log(
        `${status} ${evalCase.id} run=${run} (${evalCase.dimension}/${evalCase.invariant})`,
      );
    }
  }

  fs.mkdirSync(args.outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    generatedAt: new Date().toISOString(),
    casesPath: args.casesPaths.join(","),
    casesPaths: args.casesPaths,
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    dimensionStats: summarizeBy(results, (result) => result.dimension),
    invariantStats: summarizeBy(results, (result) => result.invariant),
    axisStats: summarizeAxes(results),
    modelStats: summarizeBy(
      results,
      (result) => result.intent?.source ?? "error",
    ),
    repeatStats: summarizeBy(results, (result) => `run-${result.run}`),
    trend: buildTrend(results),
    results,
  };
  const markdown = buildMarkdownReport(results, args.casesPaths);
  const jsonPath = path.join(args.outputDir, `intent-matrix-${timestamp}.json`);
  const mdPath = path.join(args.outputDir, `intent-matrix-${timestamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");
  fs.writeFileSync(mdPath, markdown + "\n");
  if (args.updateLatest) {
    fs.writeFileSync(
      path.join(args.outputDir, "intent-matrix-latest.json"),
      JSON.stringify(payload, null, 2) + "\n",
    );
    fs.writeFileSync(
      path.join(args.outputDir, "intent-matrix-trend-latest.json"),
      JSON.stringify(payload.trend, null, 2) + "\n",
    );
    fs.writeFileSync(
      path.join(args.outputDir, "intent-matrix-latest.md"),
      markdown + "\n",
    );
  }

  console.log("");
  console.log(`Report: ${path.relative(repoRoot, mdPath)}`);
  console.log(
    `Result: ${payload.passed}/${payload.total} passed (${((payload.passed / payload.total) * 100).toFixed(1)}%)`,
  );

  if (payload.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: any) => {
  console.error(error.message);
  process.exitCode = 1;
});
