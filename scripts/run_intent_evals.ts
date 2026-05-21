#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IntentResolver,
  type ConversationTurn,
  type IntentFrame,
} from "../jarvis/src/core/intentResolver.js";
import type {
  IntentPolicyReasonCategory,
  IntentPolicyReasonSeverity,
  IntentPolicyTraceEntry,
} from "../jarvis/src/core/intentPolicy.js";
import {
  applyClarificationChannelState,
  buildClarificationDecision,
  type ClarificationDecision,
} from "../jarvis/src/core/clarificationPolicy.js";
import {
  buildIntentExecutionPlan,
  type IntentExecutionMode,
} from "../jarvis/src/core/intentExecutionPlan.js";

type IntentEvalCase = {
  id: string;
  prompt: string;
  history?: ConversationTurn[];
  expect: IntentExpectation;
  tags?: string[];
};

type IntentExpectation = {
  subject?: IntentFrame["subject"];
  taskType?: IntentFrame["taskType"];
  needsMemory?: boolean;
  needsExternalKnowledge?: boolean;
  needsTool?: boolean;
  needsScheduling?: boolean;
  topicShifted?: boolean;
  referencesRecentHistory?: boolean;
  candidateAgentsContains?: string[];
  candidateAgentsNotContains?: string[];
  semanticEvidence?: {
    personalContext?: {
      present?: boolean;
    };
    memoryRecall?: {
      target?: IntentFrame["semanticEvidence"]["memoryRecall"]["target"];
      present?: boolean;
    };
    actionRequest?: {
      action?: IntentFrame["semanticEvidence"]["actionRequest"]["action"];
      present?: boolean;
    };
    entityHints?: {
      tickers?: string[];
      technicalTerms?: string[];
      peopleOrCompanies?: string[];
    };
  };
  richIntent?: {
    primaryAction?: IntentFrame["richIntent"]["primaryAction"];
    riskLevel?: IntentFrame["richIntent"]["riskLevel"];
    targetsContain?: Array<{
      type: IntentFrame["richIntent"]["targets"][number]["type"];
      value: string;
    }>;
    contextDependency?: Partial<IntentFrame["richIntent"]["contextDependency"]>;
  };
  intentSteps?: {
    minCount?: number;
    order?: Array<IntentFrame["intentSteps"][number]["type"]>;
    contains?: Array<{
      type: IntentFrame["intentSteps"][number]["type"];
      actionIncludes?: string;
      targetIncludes?: string;
      requiresConfirmation?: boolean;
    }>;
  };
  executionPlan?: {
    mode?: "single_llm" | "orchestrated";
    requiredToolsContain?: string[];
    stepsContain?: Array<{
      stepType?: IntentFrame["intentSteps"][number]["type"];
      mode?: IntentExecutionMode;
      requiredTool?: string;
    }>;
  };
  topicAnalysis?: {
    relation?: IntentFrame["topicAnalysis"]["relation"];
    relationOneOf?: IntentFrame["topicAnalysis"]["relation"][];
    confidenceMin?: number;
    lowGrounding?: boolean;
    historyLabelNotContains?: string[];
    currentLabelNotContains?: string[];
    historyEvidenceContains?: string[];
    currentEvidenceContains?: string[];
  };
  policyTrace?: {
    reasonCodesContain?: string[];
    reasonCodesNotContain?: string[];
  };
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
  confidenceByDimensionMin?: Partial<IntentFrame["confidenceByDimension"]>;
};

type Dimension =
  | "schemaValid"
  | "subject"
  | "taskType"
  | "needsMemory"
  | "needsExternalKnowledge"
  | "needsTool"
  | "needsScheduling"
  | "topicShifted"
  | "referencesRecentHistory"
  | "candidateAgents"
  | "personalContext"
  | "memoryTarget"
  | "action"
  | "entityHints"
  | "richIntent"
  | "intentSteps"
  | "executionPlan"
  | "topicAnalysis"
  | "policyTrace"
  | "clarification"
  | "dimensionConfidence";

type CheckResult = {
  dimension: Dimension;
  pass: boolean;
  expected: unknown;
  actual: unknown;
  message: string;
};

type CaseResult = {
  id: string;
  runIndex: number;
  runKey: string;
  tags: string[];
  prompt: string;
  history: ConversationTurn[];
  passed: boolean;
  durationMs: number;
  checks: CheckResult[];
  intent?: IntentFrame;
  clarification?: ClarificationDecision;
  error?: string;
};

type ModelReport = {
  model: string;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  avgLatencyMs: number;
  dimensionStats: Record<string, { passed: number; total: number }>;
  tagStats: Record<string, { passed: number; total: number }>;
  policyReasonCodeStats: Record<
    string,
    {
      cases: number;
      applications: number;
      category: IntentPolicyReasonCategory;
      severity: IntentPolicyReasonSeverity;
    }
  >;
  confidenceCalibration: ConfidenceCalibrationReport;
  consistency: ConsistencyReport;
  results: CaseResult[];
};

type CaseConsistency = {
  id: string;
  runs: number;
  stable: boolean;
  signatures: string[];
  passValues: boolean[];
};

type ConsistencyReport = {
  repeat: number;
  cases: number;
  stableCases: number;
  unstableCases: number;
  inconsistencyRate: number;
  unstable: CaseConsistency[];
};

type ConfidenceDimension = keyof IntentFrame["confidenceByDimension"];

type ConfidenceCalibrationReport = Partial<
  Record<
    ConfidenceDimension,
    {
      samples: number;
      passSamples: number;
      failSamples: number;
      passMin: number | null;
      passP10: number | null;
      passAvg: number | null;
      failMax: number | null;
      suggestedFloor: number | null;
      currentDefaultFloor: number;
    }
  >
>;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultCasesPath = path.join(repoRoot, "evals/intent/cases.jsonl");
const defaultOutputDir = path.join(repoRoot, "evals/logs");

const BUILTIN_SUITES = new Set(["smoke", "core", "extended", "stress"]);

function parseArgs(argv: string[]) {
  const args = {
    models: process.env.INTENT_EVAL_MODELS?.split(",").filter(Boolean) ?? [
      "gemma4:e2b",
    ],
    casesPath: defaultCasesPath,
    outputDir: defaultOutputDir,
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    timeoutMs: Number(process.env.INTENT_EVAL_TIMEOUT_MS ?? 120_000),
    limit: 0,
    repeat: 1,
    tag: "",
    tags: [] as string[],
    suite: "",
    minPassRate: null as number | null,
    maxInconsistencyRate: null as number | null,
    writePolicyBaseline: "",
    comparePolicyBaseline: "",
    writeEvalCandidates: "",
    listSuites: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--models" && next) {
      args.models = next
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--cases" && next) {
      args.casesPath = path.resolve(next);
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      i += 1;
    } else if (arg === "--base-url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      args.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      i += 1;
    } else if (arg === "--repeat" && next) {
      args.repeat = Number(next);
      i += 1;
    } else if (arg === "--tag" && next) {
      args.tag = next;
      i += 1;
    } else if (arg === "--tags" && next) {
      args.tags = next
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--suite" && next) {
      args.suite = next.trim();
      i += 1;
    } else if (arg === "--min-pass-rate" && next) {
      args.minPassRate = Number(next);
      i += 1;
    } else if (arg === "--max-inconsistency-rate" && next) {
      args.maxInconsistencyRate = Number(next);
      i += 1;
    } else if (arg === "--write-policy-baseline" && next) {
      args.writePolicyBaseline = path.resolve(next);
      i += 1;
    } else if (arg === "--compare-policy-baseline" && next) {
      args.comparePolicyBaseline = path.resolve(next);
      i += 1;
    } else if (arg === "--write-eval-candidates" && next) {
      args.writeEvalCandidates = path.resolve(next);
      i += 1;
    } else if (arg === "--list-suites") {
      args.listSuites = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${args.timeoutMs}`);
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error(`Invalid --limit: ${args.limit}`);
  }
  if (
    !Number.isFinite(args.repeat) ||
    args.repeat < 1 ||
    !Number.isInteger(args.repeat)
  ) {
    throw new Error(`Invalid --repeat: ${args.repeat}`);
  }
  if (args.models.length === 0) {
    throw new Error("At least one model is required.");
  }
  if (
    args.minPassRate !== null &&
    (!Number.isFinite(args.minPassRate) ||
      args.minPassRate < 0 ||
      args.minPassRate > 1)
  ) {
    throw new Error(`Invalid --min-pass-rate: ${args.minPassRate}`);
  }
  if (
    args.maxInconsistencyRate !== null &&
    (!Number.isFinite(args.maxInconsistencyRate) ||
      args.maxInconsistencyRate < 0 ||
      args.maxInconsistencyRate > 1)
  ) {
    throw new Error(
      `Invalid --max-inconsistency-rate: ${args.maxInconsistencyRate}`,
    );
  }
  if (args.suite && !BUILTIN_SUITES.has(args.suite)) {
    throw new Error(
      `Unknown --suite "${args.suite}". Known suites: ${Array.from(
        BUILTIN_SUITES,
      ).join(", ")}`,
    );
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  npx tsx scripts/run_intent_evals.ts [options]

Options:
  --models <a,b>       Ollama models to compare. Default: INTENT_EVAL_MODELS or gemma4:e2b
  --cases <path>       JSONL case file. Default: evals/intent/cases.jsonl
  --output-dir <path>  Report directory. Default: evals/logs
  --base-url <url>     Ollama base URL. Default: OLLAMA_BASE_URL or http://localhost:11434
  --timeout-ms <ms>    Per-case timeout. Default: INTENT_EVAL_TIMEOUT_MS or 120000
  --limit <n>          Run only the first n cases after tag filtering
  --repeat <n>         Run each selected case n times to measure consistency
  --tag <tag>          Run only cases with this tag
  --tags <a,b>         Run cases containing any of these tags
  --suite <name>       Run a named suite: smoke, core, extended, or stress
  --min-pass-rate <n>  Require each model to meet this pass rate, e.g. 1 or 0.95
  --max-inconsistency-rate <n>
                       Fail if repeated runs exceed this inconsistency rate
  --write-policy-baseline <path>
                       Write compact policy trace baseline JSON
  --compare-policy-baseline <path>
                       Fail if compact policy trace differs from baseline
  --write-eval-candidates <path>
                       Write failed cases as JSONL eval candidates
  --list-suites        Print built-in suite definitions
`);
}

function readCases(casesPath: string): IntentEvalCase[] {
  const text = fs.readFileSync(casesPath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line) as IntentEvalCase;
      } catch (error: any) {
        throw new Error(
          `Failed to parse ${casesPath}:${index + 1}: ${error.message}`,
        );
      }
    });
}

function caseHasTag(evalCase: IntentEvalCase, tag: string) {
  return evalCase.tags?.includes(tag) === true;
}

function suiteIncludesCase(suite: string, evalCase: IntentEvalCase): boolean {
  if (suite === "smoke") return caseHasTag(evalCase, "suite:smoke");
  if (suite === "core") return caseHasTag(evalCase, "suite:core");
  if (suite === "stress") return caseHasTag(evalCase, "suite:stress");
  if (suite === "extended") return !caseHasTag(evalCase, "candidate");
  return false;
}

function printSuites(cases: IntentEvalCase[]) {
  const rows = Array.from(BUILTIN_SUITES).map((suite) => ({
    suite,
    cases: cases.filter((evalCase) => suiteIncludesCase(suite, evalCase)),
  }));
  console.log("Built-in intent eval suites:");
  for (const row of rows) {
    console.log(
      `- ${row.suite}: ${row.cases.length} case(s)${
        row.suite === "extended" ? " (all non-candidate cases)" : ""
      }`,
    );
  }
}

function includesAll(actual: string[], expected: string[] | undefined) {
  if (!expected || expected.length === 0) return true;
  return expected.every((item) => actual.includes(item));
}

function includesNone(actual: string[], expected: string[] | undefined) {
  if (!expected || expected.length === 0) return true;
  return expected.every((item) => !actual.includes(item));
}

function textContainsAll(actual: string[], expected: string[] | undefined) {
  if (!expected || expected.length === 0) return true;
  const actualText = actual.join("\n").toLowerCase();
  return expected.every((item) => actualText.includes(item.toLowerCase()));
}

function addCheck(
  checks: CheckResult[],
  dimension: Dimension,
  expected: unknown,
  actual: unknown,
  pass: boolean,
  message: string,
) {
  checks.push({ dimension, expected, actual, pass, message });
}

function compareIntent(intent: IntentFrame, expect: IntentExpectation) {
  const checks: CheckResult[] = [];

  if (expect.subject !== undefined) {
    addCheck(
      checks,
      "subject",
      expect.subject,
      intent.subject,
      intent.subject === expect.subject,
      "subject matches",
    );
  }
  if (expect.taskType !== undefined) {
    addCheck(
      checks,
      "taskType",
      expect.taskType,
      intent.taskType,
      intent.taskType === expect.taskType,
      "taskType matches",
    );
  }
  for (const key of [
    "needsMemory",
    "needsExternalKnowledge",
    "needsTool",
    "needsScheduling",
    "topicShifted",
    "referencesRecentHistory",
  ] as const) {
    if (expect[key] !== undefined) {
      addCheck(
        checks,
        key,
        expect[key],
        intent[key],
        intent[key] === expect[key],
        `${key} matches`,
      );
    }
  }

  if (expect.candidateAgentsContains) {
    addCheck(
      checks,
      "candidateAgents",
      expect.candidateAgentsContains,
      intent.candidateAgents,
      includesAll(intent.candidateAgents, expect.candidateAgentsContains),
      "candidateAgents contains expected agents",
    );
  }
  if (expect.candidateAgentsNotContains) {
    addCheck(
      checks,
      "candidateAgents",
      expect.candidateAgentsNotContains,
      intent.candidateAgents,
      includesNone(intent.candidateAgents, expect.candidateAgentsNotContains),
      "candidateAgents excludes forbidden agents",
    );
  }

  const semantic = expect.semanticEvidence;
  if (semantic?.personalContext?.present !== undefined) {
    addCheck(
      checks,
      "personalContext",
      semantic.personalContext.present,
      intent.semanticEvidence.personalContext.present,
      intent.semanticEvidence.personalContext.present ===
        semantic.personalContext.present,
      "personalContext.present matches",
    );
  }
  if (semantic?.memoryRecall?.target !== undefined) {
    addCheck(
      checks,
      "memoryTarget",
      semantic.memoryRecall.target,
      intent.semanticEvidence.memoryRecall.target,
      intent.semanticEvidence.memoryRecall.target ===
        semantic.memoryRecall.target,
      "memoryRecall.target matches",
    );
  }
  if (semantic?.memoryRecall?.present !== undefined) {
    addCheck(
      checks,
      "memoryTarget",
      semantic.memoryRecall.present,
      intent.semanticEvidence.memoryRecall.present,
      intent.semanticEvidence.memoryRecall.present ===
        semantic.memoryRecall.present,
      "memoryRecall.present matches",
    );
  }
  if (semantic?.actionRequest?.action !== undefined) {
    addCheck(
      checks,
      "action",
      semantic.actionRequest.action,
      intent.semanticEvidence.actionRequest.action,
      intent.semanticEvidence.actionRequest.action ===
        semantic.actionRequest.action,
      "actionRequest.action matches",
    );
  }
  if (semantic?.actionRequest?.present !== undefined) {
    addCheck(
      checks,
      "action",
      semantic.actionRequest.present,
      intent.semanticEvidence.actionRequest.present,
      intent.semanticEvidence.actionRequest.present ===
        semantic.actionRequest.present,
      "actionRequest.present matches",
    );
  }

  for (const key of [
    "tickers",
    "technicalTerms",
    "peopleOrCompanies",
  ] as const) {
    const expectedValues = semantic?.entityHints?.[key];
    if (expectedValues !== undefined) {
      const actualValues = intent.semanticEvidence.entityHints[key];
      addCheck(
        checks,
        "entityHints",
        expectedValues,
        actualValues,
        includesAll(actualValues, expectedValues),
        `entityHints.${key} contains expected values`,
      );
    }
  }

  const richIntent = expect.richIntent;
  if (richIntent?.primaryAction !== undefined) {
    addCheck(
      checks,
      "richIntent",
      richIntent.primaryAction,
      intent.richIntent.primaryAction,
      intent.richIntent.primaryAction === richIntent.primaryAction,
      "richIntent.primaryAction matches",
    );
  }
  if (richIntent?.riskLevel !== undefined) {
    addCheck(
      checks,
      "richIntent",
      richIntent.riskLevel,
      intent.richIntent.riskLevel,
      intent.richIntent.riskLevel === richIntent.riskLevel,
      "richIntent.riskLevel matches",
    );
  }
  if (richIntent?.targetsContain) {
    for (const target of richIntent.targetsContain) {
      addCheck(
        checks,
        "richIntent",
        target,
        intent.richIntent.targets,
        intent.richIntent.targets.some(
          (actual) =>
            actual.type === target.type && actual.value === target.value,
        ),
        "richIntent.targets contains expected target",
      );
    }
  }
  if (richIntent?.contextDependency) {
    for (const [key, expectedValue] of Object.entries(
      richIntent.contextDependency,
    )) {
      const dependencyKey =
        key as keyof IntentFrame["richIntent"]["contextDependency"];
      addCheck(
        checks,
        "richIntent",
        expectedValue,
        intent.richIntent.contextDependency[dependencyKey],
        intent.richIntent.contextDependency[dependencyKey] === expectedValue,
        `richIntent.contextDependency.${key} matches`,
      );
    }
  }

  const intentSteps = expect.intentSteps;
  if (intentSteps?.minCount !== undefined) {
    addCheck(
      checks,
      "intentSteps",
      `>=${intentSteps.minCount}`,
      intent.intentSteps.length,
      intent.intentSteps.length >= intentSteps.minCount,
      "intentSteps has enough steps",
    );
  }
  if (intentSteps?.order !== undefined) {
    const actualOrder = intent.intentSteps
      .slice(0, intentSteps.order.length)
      .map((step) => step.type);
    addCheck(
      checks,
      "intentSteps",
      intentSteps.order,
      actualOrder,
      JSON.stringify(actualOrder) === JSON.stringify(intentSteps.order),
      "intentSteps order matches",
    );
  }
  if (intentSteps?.contains) {
    for (const expectedStep of intentSteps.contains) {
      addCheck(
        checks,
        "intentSteps",
        expectedStep,
        intent.intentSteps,
        intent.intentSteps.some(
          (actual) =>
            actual.type === expectedStep.type &&
            (expectedStep.actionIncludes === undefined ||
              actual.action
                .toLowerCase()
                .includes(expectedStep.actionIncludes.toLowerCase())) &&
            (expectedStep.targetIncludes === undefined ||
              actual.target
                .toLowerCase()
                .includes(expectedStep.targetIncludes.toLowerCase())) &&
            (expectedStep.requiresConfirmation === undefined ||
              actual.requiresConfirmation ===
                expectedStep.requiresConfirmation),
        ),
        "intentSteps contains expected step",
      );
    }
  }

  const executionPlan = expect.executionPlan;
  if (executionPlan) {
    const actualPlan = buildIntentExecutionPlan(intent);
    if (executionPlan.mode !== undefined) {
      addCheck(
        checks,
        "executionPlan",
        executionPlan.mode,
        actualPlan?.mode ?? null,
        actualPlan?.mode === executionPlan.mode,
        "executionPlan.mode matches",
      );
    }
    if (executionPlan.requiredToolsContain) {
      for (const tool of executionPlan.requiredToolsContain) {
        addCheck(
          checks,
          "executionPlan",
          tool,
          actualPlan?.requiredTools ?? [],
          actualPlan?.requiredTools.includes(tool) === true,
          "executionPlan includes required tool",
        );
      }
    }
    if (executionPlan.stepsContain) {
      for (const expectedStep of executionPlan.stepsContain) {
        addCheck(
          checks,
          "executionPlan",
          expectedStep,
          actualPlan?.steps ?? [],
          actualPlan?.steps.some(
            (actual) =>
              (expectedStep.stepType === undefined ||
                actual.step.type === expectedStep.stepType) &&
              (expectedStep.mode === undefined ||
                actual.mode === expectedStep.mode) &&
              (expectedStep.requiredTool === undefined ||
                actual.requiredTool === expectedStep.requiredTool),
          ) === true,
          "executionPlan contains expected step",
        );
      }
    }
  }

  if (expect.confidenceByDimensionMin) {
    for (const [key, expectedMin] of Object.entries(
      expect.confidenceByDimensionMin,
    )) {
      const dimensionKey = key as keyof IntentFrame["confidenceByDimension"];
      addCheck(
        checks,
        "dimensionConfidence",
        `>=${expectedMin}`,
        intent.confidenceByDimension[dimensionKey],
        intent.confidenceByDimension[dimensionKey] >= Number(expectedMin),
        `confidenceByDimension.${key} meets minimum`,
      );
    }
  }

  const topicAnalysis = expect.topicAnalysis;
  if (topicAnalysis?.relation !== undefined) {
    addCheck(
      checks,
      "topicAnalysis",
      topicAnalysis.relation,
      intent.topicAnalysis.relation,
      intent.topicAnalysis.relation === topicAnalysis.relation,
      "topicAnalysis.relation matches",
    );
  }
  if (topicAnalysis?.relationOneOf !== undefined) {
    addCheck(
      checks,
      "topicAnalysis",
      topicAnalysis.relationOneOf,
      intent.topicAnalysis.relation,
      topicAnalysis.relationOneOf.includes(intent.topicAnalysis.relation),
      "topicAnalysis.relation is one of expected values",
    );
  }
  if (topicAnalysis?.confidenceMin !== undefined) {
    addCheck(
      checks,
      "topicAnalysis",
      `>=${topicAnalysis.confidenceMin}`,
      intent.topicAnalysis.confidence,
      intent.topicAnalysis.confidence >= topicAnalysis.confidenceMin,
      "topicAnalysis.confidence meets minimum",
    );
  }
  if (topicAnalysis?.lowGrounding !== undefined) {
    addCheck(
      checks,
      "topicAnalysis",
      topicAnalysis.lowGrounding,
      intent.topicAnalysis.lowGrounding,
      intent.topicAnalysis.lowGrounding === topicAnalysis.lowGrounding,
      "topicAnalysis.lowGrounding matches",
    );
  }
  if (topicAnalysis?.historyLabelNotContains) {
    addCheck(
      checks,
      "topicAnalysis",
      topicAnalysis.historyLabelNotContains,
      intent.topicAnalysis.history.label,
      topicAnalysis.historyLabelNotContains.every(
        (item) =>
          !intent.topicAnalysis.history.label
            .toLowerCase()
            .includes(item.toLowerCase()),
      ),
      "topicAnalysis.history.label excludes forbidden terms",
    );
  }
  if (topicAnalysis?.currentLabelNotContains) {
    addCheck(
      checks,
      "topicAnalysis",
      topicAnalysis.currentLabelNotContains,
      intent.topicAnalysis.current.label,
      topicAnalysis.currentLabelNotContains.every(
        (item) =>
          !intent.topicAnalysis.current.label
            .toLowerCase()
            .includes(item.toLowerCase()),
      ),
      "topicAnalysis.current.label excludes forbidden terms",
    );
  }
  if (topicAnalysis?.historyEvidenceContains) {
    addCheck(
      checks,
      "topicAnalysis",
      topicAnalysis.historyEvidenceContains,
      intent.topicAnalysis.history.evidence,
      textContainsAll(
        [
          intent.topicAnalysis.history.label,
          ...intent.topicAnalysis.history.evidence,
        ],
        topicAnalysis.historyEvidenceContains,
      ),
      "topicAnalysis.history.evidence contains expected values",
    );
  }
  if (topicAnalysis?.currentEvidenceContains) {
    addCheck(
      checks,
      "topicAnalysis",
      topicAnalysis.currentEvidenceContains,
      intent.topicAnalysis.current.evidence,
      textContainsAll(
        [
          intent.topicAnalysis.current.label,
          ...intent.topicAnalysis.current.evidence,
        ],
        topicAnalysis.currentEvidenceContains,
      ),
      "topicAnalysis.current.evidence contains expected values",
    );
  }

  const policyTrace = expect.policyTrace;
  if (policyTrace !== undefined) {
    const reasonCodes = intent.policyTrace.map((entry) => entry.reasonCode);
    if (policyTrace.reasonCodesContain !== undefined) {
      addCheck(
        checks,
        "policyTrace",
        policyTrace.reasonCodesContain,
        reasonCodes,
        includesAll(reasonCodes, policyTrace.reasonCodesContain),
        "policyTrace contains expected reason codes",
      );
    }
    if (policyTrace.reasonCodesNotContain !== undefined) {
      addCheck(
        checks,
        "policyTrace",
        policyTrace.reasonCodesNotContain,
        reasonCodes,
        includesNone(reasonCodes, policyTrace.reasonCodesNotContain),
        "policyTrace excludes forbidden reason codes",
      );
    }
  }

  return checks;
}

function compareClarification(
  decision: ClarificationDecision,
  expect: IntentExpectation["clarification"],
) {
  const checks: CheckResult[] = [];
  if (expect === undefined) return checks;

  if (expect.state !== undefined) {
    addCheck(
      checks,
      "clarification",
      expect.state,
      decision.state,
      decision.state === expect.state,
      "clarification state matches",
    );
  }
  if (expect.scope !== undefined) {
    addCheck(
      checks,
      "clarification",
      expect.scope,
      decision.scope,
      decision.scope === expect.scope,
      "clarification scope matches",
    );
  }
  if (expect.shouldAsk !== undefined) {
    addCheck(
      checks,
      "clarification",
      expect.shouldAsk,
      decision.shouldAsk,
      decision.shouldAsk === expect.shouldAsk,
      "clarification shouldAsk matches",
    );
  }
  if (expect.blocking !== undefined) {
    addCheck(
      checks,
      "clarification",
      expect.blocking,
      decision.blocking,
      decision.blocking === expect.blocking,
      "clarification blocking matches",
    );
  }
  if (expect.reasonsContain !== undefined) {
    addCheck(
      checks,
      "clarification",
      expect.reasonsContain,
      decision.reasons,
      includesAll(decision.reasons, expect.reasonsContain),
      "clarification reasons contain expected values",
    );
  }
  if (expect.reasonsNotContain !== undefined) {
    addCheck(
      checks,
      "clarification",
      expect.reasonsNotContain,
      decision.reasons,
      includesNone(decision.reasons, expect.reasonsNotContain),
      "clarification reasons exclude forbidden values",
    );
  }
  if (expect.stepRequirementsContain !== undefined) {
    for (const requirement of expect.stepRequirementsContain) {
      addCheck(
        checks,
        "clarification",
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
        "clarification step requirements contain expected requirement",
      );
    }
  }

  return checks;
}

async function runCase(
  model: string,
  evalCase: IntentEvalCase,
  options: { baseUrl: string; timeoutMs: number },
  runIndex = 0,
): Promise<CaseResult> {
  const resolver = new IntentResolver({
    model,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
  });
  const started = Date.now();
  try {
    const intent = await resolver.resolve({
      userPrompt: evalCase.prompt,
      history: evalCase.history ?? [],
    });
    const clarification = applyClarificationChannelState(
      buildClarificationDecision({
        userPrompt: evalCase.prompt,
        intent,
        querySubject: intent.subject,
        candidateAgents: intent.candidateAgents,
        recentHistoryLength: evalCase.history?.length ?? 0,
        executionContext:
          evalCase.expect.clarification?.executionContext ?? "interactive",
      }),
      evalCase.expect.clarification?.interactiveChannel ?? true,
    );
    const checks = [
      ...compareIntent(intent, evalCase.expect),
      ...compareClarification(clarification, evalCase.expect.clarification),
    ];
    addCheck(
      checks,
      "schemaValid",
      true,
      true,
      true,
      "resolver returned intent",
    );
    return {
      id: evalCase.id,
      runIndex,
      runKey: formatRunKey(evalCase.id, runIndex),
      tags: evalCase.tags ?? [],
      prompt: evalCase.prompt,
      history: evalCase.history ?? [],
      passed: checks.every((check) => check.pass),
      durationMs: Date.now() - started,
      checks,
      intent,
      clarification,
    };
  } catch (error: any) {
    return {
      id: evalCase.id,
      runIndex,
      runKey: formatRunKey(evalCase.id, runIndex),
      tags: evalCase.tags ?? [],
      prompt: evalCase.prompt,
      history: evalCase.history ?? [],
      passed: false,
      durationMs: Date.now() - started,
      checks: [
        {
          dimension: "schemaValid",
          pass: false,
          expected: "no error",
          actual: error?.message ?? String(error),
          message: "resolver failed",
        },
      ],
      error: error?.stack ?? error?.message ?? String(error),
    };
  }
}

function formatRunKey(id: string, runIndex: number) {
  return runIndex === 0 ? id : `${id}#${runIndex + 1}`;
}

function summarizeModel(model: string, results: CaseResult[]): ModelReport {
  const durationMs = results.reduce(
    (sum, result) => sum + result.durationMs,
    0,
  );
  const dimensionStats: ModelReport["dimensionStats"] = {};
  const tagStats: ModelReport["tagStats"] = {};
  const policyReasonCodeStats: ModelReport["policyReasonCodeStats"] = {};

  for (const result of results) {
    for (const tag of result.tags) {
      tagStats[tag] ??= { passed: 0, total: 0 };
      tagStats[tag].total += 1;
      if (result.passed) tagStats[tag].passed += 1;
    }
    for (const check of result.checks) {
      dimensionStats[check.dimension] ??= { passed: 0, total: 0 };
      dimensionStats[check.dimension].total += 1;
      if (check.pass) dimensionStats[check.dimension].passed += 1;
    }
    const caseReasonCodes = new Set<string>();
    for (const entry of result.intent?.policyTrace ?? []) {
      policyReasonCodeStats[entry.reasonCode] ??= {
        cases: 0,
        applications: 0,
        category: entry.reason.category,
        severity: entry.reason.severity,
      };
      policyReasonCodeStats[entry.reasonCode].applications += 1;
      caseReasonCodes.add(entry.reasonCode);
    }
    for (const reasonCode of caseReasonCodes) {
      policyReasonCodeStats[reasonCode].cases += 1;
    }
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    model,
    total: results.length,
    passed,
    failed: results.length - passed,
    durationMs,
    avgLatencyMs:
      results.length === 0 ? 0 : Math.round(durationMs / results.length),
    dimensionStats,
    tagStats,
    policyReasonCodeStats,
    confidenceCalibration: buildConfidenceCalibration(results),
    consistency: buildConsistencyReport(results),
    results,
  };
}

function buildConsistencySignature(result: CaseResult): string {
  if (!result.intent) {
    return JSON.stringify({
      passed: result.passed,
      error: result.error ?? "unknown_error",
    });
  }
  const intent = result.intent;
  return JSON.stringify({
    passed: result.passed,
    subject: intent.subject,
    taskType: intent.taskType,
    needsMemory: intent.needsMemory,
    needsExternalKnowledge: intent.needsExternalKnowledge,
    needsTool: intent.needsTool,
    needsScheduling: intent.needsScheduling,
    topicShifted: intent.topicShifted,
    referencesRecentHistory: intent.referencesRecentHistory,
    memoryTarget: intent.semanticEvidence.memoryRecall.target,
    action: intent.semanticEvidence.actionRequest.action,
    candidateAgents: [...intent.candidateAgents].sort(),
    intentSteps: intent.intentSteps.map((step) => ({
      type: step.type,
      action: step.action,
      target: step.target,
      requiresConfirmation: step.requiresConfirmation,
    })),
    topicRelation: intent.topicAnalysis.relation,
    policyReasonCodes: intent.policyTrace.map((entry) => entry.reasonCode),
    clarification: result.clarification
      ? {
          state: result.clarification.state,
          shouldAsk: result.clarification.shouldAsk,
          reasons: result.clarification.reasons,
        }
      : null,
  });
}

function buildConsistencyReport(results: CaseResult[]): ConsistencyReport {
  const byCase = new Map<string, CaseResult[]>();
  for (const result of results) {
    const bucket = byCase.get(result.id) ?? [];
    bucket.push(result);
    byCase.set(result.id, bucket);
  }

  const caseReports: CaseConsistency[] = [];
  for (const [id, caseResults] of byCase) {
    const signatures = caseResults.map(buildConsistencySignature);
    const uniqueSignatures = Array.from(new Set(signatures));
    caseReports.push({
      id,
      runs: caseResults.length,
      stable: uniqueSignatures.length === 1,
      signatures: uniqueSignatures,
      passValues: caseResults.map((result) => result.passed),
    });
  }

  const repeated = caseReports.filter((result) => result.runs > 1);
  const unstable = repeated.filter((result) => !result.stable);
  return {
    repeat:
      results.length === 0
        ? 1
        : Math.max(...caseReports.map((result) => result.runs)),
    cases: repeated.length,
    stableCases: repeated.length - unstable.length,
    unstableCases: unstable.length,
    inconsistencyRate:
      repeated.length === 0 ? 0 : unstable.length / repeated.length,
    unstable,
  };
}

const CONFIDENCE_DIMENSIONS: ConfidenceDimension[] = [
  "subject",
  "taskType",
  "memoryTarget",
  "action",
  "entityHints",
  "topicShift",
  "richIntent",
];

const CURRENT_DEFAULT_CONFIDENCE_FLOOR = 0.55;

function roundConfidence(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(3));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p)),
  );
  return sorted[index];
}

function buildConfidenceCalibration(
  results: CaseResult[],
): ConfidenceCalibrationReport {
  const report: ConfidenceCalibrationReport = {};

  for (const dimension of CONFIDENCE_DIMENSIONS) {
    const passValues: number[] = [];
    const failValues: number[] = [];

    for (const result of results) {
      const confidence = result.intent?.confidenceByDimension[dimension];
      if (confidence === undefined) continue;
      if (result.passed) {
        passValues.push(confidence);
      } else {
        failValues.push(confidence);
      }
    }

    const passP10 = percentile(passValues, 0.1);
    const failMax = failValues.length === 0 ? null : Math.max(...failValues);
    const suggestedFloor =
      passP10 === null
        ? null
        : failMax === null
          ? passP10
          : Math.max(failMax, passP10);

    report[dimension] = {
      samples: passValues.length + failValues.length,
      passSamples: passValues.length,
      failSamples: failValues.length,
      passMin:
        passValues.length === 0
          ? null
          : roundConfidence(Math.min(...passValues)),
      passP10: roundConfidence(passP10),
      passAvg: roundConfidence(average(passValues)),
      failMax: roundConfidence(failMax),
      suggestedFloor: roundConfidence(suggestedFloor),
      currentDefaultFloor: CURRENT_DEFAULT_CONFIDENCE_FLOOR,
    };
  }

  return report;
}

function percent(passed: number, total: number) {
  if (total === 0) return "n/a";
  return `${Math.round((passed / total) * 100)}%`;
}

function renderStatsTable(
  stats: Record<string, { passed: number; total: number }>,
) {
  const rows = Object.entries(stats).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return "_No checks._\n";
  return [
    "| Name | Pass | Total | Rate |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map(
      ([name, stat]) =>
        `| ${name} | ${stat.passed} | ${stat.total} | ${percent(stat.passed, stat.total)} |`,
    ),
    "",
  ].join("\n");
}

function renderPolicyReasonCodeStats(
  stats: ModelReport["policyReasonCodeStats"],
) {
  const rows = Object.entries(stats).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return "_No policy rules applied._\n";
  return [
    "| Reason Code | Category | Severity | Cases | Applications |",
    "| --- | --- | --- | ---: | ---: |",
    ...rows.map(
      ([reasonCode, stat]) =>
        `| ${reasonCode} | ${stat.category} | ${stat.severity} | ${stat.cases} | ${stat.applications} |`,
    ),
    "",
  ].join("\n");
}

function renderConfidenceCalibration(report: ConfidenceCalibrationReport) {
  const rows = CONFIDENCE_DIMENSIONS.map(
    (dimension) => [dimension, report[dimension]] as const,
  ).filter(([, stat]) => stat !== undefined);
  if (rows.length === 0) return "_No confidence samples._\n";
  return [
    "| Dimension | Samples | Pass P10 | Pass Avg | Fail Max | Suggested Floor | Current Floor |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(([dimension, stat]) =>
      [
        `| ${dimension}`,
        stat!.samples,
        stat!.passP10 ?? "n/a",
        stat!.passAvg ?? "n/a",
        stat!.failMax ?? "n/a",
        stat!.suggestedFloor ?? "n/a",
        stat!.currentDefaultFloor,
        "|",
      ].join(" | "),
    ),
    "",
  ].join("\n");
}

function renderConsistency(report: ConsistencyReport) {
  if (report.repeat <= 1) {
    return "_Repeat disabled. Use `--repeat N` to measure volatility._\n";
  }
  const lines = [
    "| Repeat | Cases | Stable | Unstable | Inconsistency Rate |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${report.repeat} | ${report.cases} | ${report.stableCases} | ${report.unstableCases} | ${percent(report.unstableCases, report.cases)} |`,
    "",
  ];
  if (report.unstable.length > 0) {
    lines.push("Unstable cases:", "");
    for (const unstable of report.unstable) {
      lines.push(
        `- ${unstable.id}: ${unstable.signatures.length} distinct signature(s), pass values=${unstable.passValues.join(",")}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderCrossModelComparison(reports: ModelReport[]) {
  if (reports.length < 2) return "";
  const modelNames = reports.map((report) => report.model);
  const caseIds = Array.from(
    new Set(
      reports.flatMap((report) => report.results.map((result) => result.id)),
    ),
  ).sort();
  const divergent = caseIds.flatMap((caseId) => {
    const byModel = reports.map((report) => {
      const caseResults = report.results.filter(
        (result) => result.id === caseId,
      );
      const passed = caseResults.filter((result) => result.passed).length;
      return {
        model: report.model,
        passed,
        total: caseResults.length,
      };
    });
    const rates = new Set(
      byModel.map((item) =>
        item.total === 0 ? "missing" : `${item.passed}/${item.total}`,
      ),
    );
    return rates.size > 1 ? [{ caseId, byModel }] : [];
  });

  const lines = ["## Cross-Model Comparison", ""];
  if (divergent.length === 0) {
    lines.push("_No pass-rate divergence across selected models._", "");
    return lines.join("\n");
  }
  lines.push(
    `Found ${divergent.length} case(s) with cross-model pass-rate divergence.`,
    "",
  );
  lines.push(
    `| Case | ${modelNames.map((model) => `${model} Pass`).join(" | ")} |`,
  );
  lines.push(`| --- | ${modelNames.map(() => "---:").join(" | ")} |`);
  for (const item of divergent) {
    const byModel = new Map(
      item.byModel.map((entry) => [
        entry.model,
        `${entry.passed}/${entry.total}`,
      ]),
    );
    lines.push(
      `| ${item.caseId} | ${modelNames.map((model) => byModel.get(model) ?? "0/0").join(" | ")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderMarkdown(reports: ModelReport[]) {
  const lines: string[] = [
    "# Intent Eval Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    "| Model | Passed | Total | Rate | Avg Latency |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...reports.map(
      (report) =>
        `| ${report.model} | ${report.passed} | ${report.total} | ${percent(report.passed, report.total)} | ${report.avgLatencyMs}ms |`,
    ),
    "",
  ];

  for (const report of reports) {
    lines.push(`## ${report.model}`, "");
    lines.push("### By Dimension", "", renderStatsTable(report.dimensionStats));
    lines.push("### By Tag", "", renderStatsTable(report.tagStats));
    lines.push(
      "### Policy Reason Codes",
      "",
      renderPolicyReasonCodeStats(report.policyReasonCodeStats),
    );
    lines.push(
      "### Confidence Calibration",
      "",
      renderConfidenceCalibration(report.confidenceCalibration),
    );
    lines.push(
      "### Repeat Consistency",
      "",
      renderConsistency(report.consistency),
    );
    const failures = report.results.filter((result) => !result.passed);
    lines.push("### Failures", "");
    if (failures.length === 0) {
      lines.push("_None._", "");
    } else {
      for (const failure of failures) {
        lines.push(`#### ${failure.id}`, "");
        lines.push(`Prompt: ${failure.prompt}`, "");
        for (const check of failure.checks.filter((check) => !check.pass)) {
          lines.push(
            `- ${check.dimension}: expected \`${JSON.stringify(check.expected)}\`, got \`${JSON.stringify(check.actual)}\``,
          );
        }
        if (failure.error) {
          lines.push("", "```text", failure.error, "```");
        }
        lines.push("");
      }
    }
  }

  const crossModel = renderCrossModelComparison(reports);
  if (crossModel) lines.push(crossModel);

  return lines.join("\n");
}

type PolicyTraceBaseline = {
  version: 2;
  reports: Array<{
    model: string;
    cases: Array<{
      id: string;
      runKey?: string;
      passed: boolean;
      reasonCodes: string[];
      trace: Array<
        Pick<
          IntentPolicyTraceEntry,
          "ruleId" | "stage" | "priority" | "reasonCode" | "reason"
        >
      >;
    }>;
  }>;
};

function buildPolicyTraceBaseline(reports: ModelReport[]): PolicyTraceBaseline {
  return {
    version: 2,
    reports: reports.map((report) => ({
      model: report.model,
      cases: report.results.map((result) => {
        const trace = (result.intent?.policyTrace ?? []).map((entry) => ({
          ruleId: entry.ruleId,
          stage: entry.stage,
          priority: entry.priority,
          reasonCode: entry.reasonCode,
          reason: entry.reason,
        }));
        return {
          id: result.id,
          runKey: result.runKey,
          passed: result.passed,
          reasonCodes: trace.map((entry) => entry.reasonCode),
          trace,
        };
      }),
    })),
  };
}

function comparePolicyTraceBaseline(
  expected: PolicyTraceBaseline,
  actual: PolicyTraceBaseline,
) {
  const diffs: string[] = [];
  if (expected.version !== actual.version) {
    diffs.push(`baseline version ${expected.version} -> ${actual.version}`);
  }
  const expectedReports = new Map(
    expected.reports.map((report) => [report.model, report]),
  );
  const actualReports = new Map(
    actual.reports.map((report) => [report.model, report]),
  );

  for (const [model, expectedReport] of expectedReports) {
    const actualReport = actualReports.get(model);
    if (!actualReport) {
      diffs.push(`missing model ${model}`);
      continue;
    }
    const actualCases = new Map(
      actualReport.cases.map((caseResult) => [
        caseResult.runKey ?? caseResult.id,
        caseResult,
      ]),
    );
    for (const expectedCase of expectedReport.cases) {
      const expectedKey = expectedCase.runKey ?? expectedCase.id;
      const actualCase = actualCases.get(expectedKey);
      if (!actualCase) {
        diffs.push(`${model}/${expectedKey}: missing case`);
        continue;
      }
      const expectedSignature = formatPolicyTraceSignature(expectedCase.trace);
      const actualSignature = formatPolicyTraceSignature(actualCase.trace);
      if (expectedSignature !== actualSignature) {
        diffs.push(
          `${model}/${expectedCase.id}: trace ${expectedSignature || "(none)"} -> ${actualSignature || "(none)"}`,
        );
      }
    }
    const expectedCaseIds = new Set(
      expectedReport.cases.map(
        (caseResult) => caseResult.runKey ?? caseResult.id,
      ),
    );
    for (const actualCase of actualReport.cases) {
      const actualKey = actualCase.runKey ?? actualCase.id;
      if (!expectedCaseIds.has(actualKey)) {
        diffs.push(`${model}/${actualKey}: unexpected case`);
      }
    }
  }

  for (const model of actualReports.keys()) {
    if (!expectedReports.has(model)) {
      diffs.push(`unexpected model ${model}`);
    }
  }

  return diffs;
}

function formatPolicyTraceSignature(
  trace: PolicyTraceBaseline["reports"][number]["cases"][number]["trace"],
) {
  return trace
    .map(
      (entry) =>
        `${entry.ruleId}@${entry.stage}:${entry.priority}:${entry.reasonCode}:${entry.reason.category}:${entry.reason.severity}`,
    )
    .join(",");
}

type EvalCandidate = {
  source: "intent_eval_failure";
  generatedAt: string;
  model: string;
  id: string;
  runKey: string;
  prompt: string;
  history: ConversationTurn[];
  tags: string[];
  failedChecks: CheckResult[];
  observed: {
    intent?: IntentFrame;
    clarification?: ClarificationDecision;
  };
  candidateCase: IntentEvalCase;
};

function buildEvalCandidates(reports: ModelReport[]): EvalCandidate[] {
  const generatedAt = new Date().toISOString();
  return reports.flatMap((report) =>
    report.results
      .filter((result) => !result.passed)
      .map((result) => {
        const failedChecks = result.checks.filter((check) => !check.pass);
        return {
          source: "intent_eval_failure" as const,
          generatedAt,
          model: report.model,
          id: `${result.id}.${report.model.replace(/[^a-zA-Z0-9]+/g, "_")}`,
          runKey: result.runKey,
          prompt: result.prompt,
          history: result.history,
          tags: [...result.tags, "candidate", "from-eval-failure"],
          failedChecks,
          observed: {
            intent: result.intent,
            clarification: result.clarification,
          },
          candidateCase: {
            id: `${result.id}.candidate`,
            prompt: result.prompt,
            history: result.history,
            expect: {},
            tags: [...result.tags, "candidate"],
          },
        };
      }),
  );
}

function writeEvalCandidates(pathname: string, candidates: EvalCandidate[]) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(
    pathname,
    candidates.map((candidate) => JSON.stringify(candidate)).join("\n") +
      (candidates.length > 0 ? "\n" : ""),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cases = readCases(args.casesPath);
  if (args.listSuites) {
    printSuites(cases);
    return;
  }
  if (args.suite) {
    cases = cases.filter((evalCase) => suiteIncludesCase(args.suite, evalCase));
  }
  if (args.tag)
    cases = cases.filter((evalCase) => caseHasTag(evalCase, args.tag));
  if (args.tags.length > 0) {
    cases = cases.filter((evalCase) =>
      args.tags.some((tag) => caseHasTag(evalCase, tag)),
    );
  }
  if (args.limit > 0) cases = cases.slice(0, args.limit);
  if (cases.length === 0) throw new Error("No eval cases selected.");

  fs.mkdirSync(args.outputDir, { recursive: true });

  console.log(
    `Running ${cases.length} intent eval case(s) across ${args.models.length} model(s).`,
  );
  if (args.repeat > 1) console.log(`Repeat: ${args.repeat}`);
  console.log(`Cases: ${args.casesPath}`);
  console.log(`Ollama: ${args.baseUrl}`);
  if (args.suite) console.log(`Suite: ${args.suite}`);
  if (args.tag) console.log(`Tag: ${args.tag}`);
  if (args.tags.length > 0) console.log(`Tags: ${args.tags.join(",")}`);
  if (args.minPassRate !== null)
    console.log(`Min pass rate: ${Math.round(args.minPassRate * 100)}%`);

  const reports: ModelReport[] = [];
  for (const model of args.models) {
    console.log(`\n--- Model: ${model} ---`);
    const results: CaseResult[] = [];
    for (let runIndex = 0; runIndex < args.repeat; runIndex += 1) {
      if (args.repeat > 1) {
        console.log(`Run ${runIndex + 1}/${args.repeat}`);
      }
      for (const evalCase of cases) {
        const result = await runCase(
          model,
          evalCase,
          {
            baseUrl: args.baseUrl,
            timeoutMs: args.timeoutMs,
          },
          runIndex,
        );
        results.push(result);
        const marker = result.passed ? "PASS" : "FAIL";
        console.log(`${marker} ${result.runKey} (${result.durationMs}ms)`);
      }
    }
    const report = summarizeModel(model, results);
    reports.push(report);
    console.log(
      `Result: ${report.passed}/${report.total} passed (${percent(report.passed, report.total)}), avg ${report.avgLatencyMs}ms`,
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(args.outputDir, `intent-eval-${stamp}.json`);
  const mdPath = path.join(args.outputDir, `intent-eval-${stamp}.md`);
  const latestMdPath = path.join(args.outputDir, "intent-eval-latest.md");
  const payload = {
    generatedAt: new Date().toISOString(),
    models: args.models,
    casesPath: args.casesPath,
    filters: {
      suite: args.suite || null,
      tag: args.tag || null,
      tags: args.tags,
      limit: args.limit || null,
      repeat: args.repeat,
    },
    minPassRate: args.minPassRate,
    maxInconsistencyRate: args.maxInconsistencyRate,
    reports,
  };
  const policyBaseline = buildPolicyTraceBaseline(reports);
  const evalCandidates = buildEvalCandidates(reports);

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  const markdown = renderMarkdown(reports);
  fs.writeFileSync(mdPath, markdown);
  fs.writeFileSync(latestMdPath, markdown);
  if (args.writePolicyBaseline) {
    fs.mkdirSync(path.dirname(args.writePolicyBaseline), { recursive: true });
    fs.writeFileSync(
      args.writePolicyBaseline,
      JSON.stringify(policyBaseline, null, 2),
    );
    console.log(`Policy baseline: ${args.writePolicyBaseline}`);
  }
  const candidatePath =
    args.writeEvalCandidates ||
    (evalCandidates.length > 0
      ? path.join(
          repoRoot,
          "evals/intent/candidates/intent-eval-candidates-latest.jsonl",
        )
      : "");
  if (candidatePath) {
    writeEvalCandidates(candidatePath, evalCandidates);
    console.log(`Eval candidates: ${candidatePath} (${evalCandidates.length})`);
  }

  console.log(`\nJSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);
  console.log(`Latest report: ${latestMdPath}`);

  const hasFailures = reports.some((report) => report.failed > 0);
  const missesPassRate =
    args.minPassRate !== null &&
    reports.some(
      (report) =>
        report.total === 0 || report.passed / report.total < args.minPassRate!,
    );
  const missesConsistency =
    args.maxInconsistencyRate !== null &&
    reports.some(
      (report) =>
        report.consistency.inconsistencyRate > args.maxInconsistencyRate!,
    );
  if (missesConsistency) {
    console.error(
      `\nConsistency gate failed: max allowed ${args.maxInconsistencyRate}`,
    );
    for (const report of reports) {
      if (report.consistency.inconsistencyRate > args.maxInconsistencyRate!) {
        console.error(
          `- ${report.model}: ${report.consistency.unstableCases}/${report.consistency.cases} unstable case(s)`,
        );
      }
    }
  }
  let policyBaselineDiffs: string[] = [];
  if (args.comparePolicyBaseline) {
    const expectedBaseline = JSON.parse(
      fs.readFileSync(args.comparePolicyBaseline, "utf8"),
    ) as PolicyTraceBaseline;
    policyBaselineDiffs = comparePolicyTraceBaseline(
      expectedBaseline,
      policyBaseline,
    );
    if (policyBaselineDiffs.length > 0) {
      console.error("\nPolicy baseline differs:");
      for (const diff of policyBaselineDiffs) console.error(`- ${diff}`);
    } else {
      console.log(`Policy baseline matched: ${args.comparePolicyBaseline}`);
    }
  }
  process.exitCode =
    hasFailures ||
    missesPassRate ||
    missesConsistency ||
    policyBaselineDiffs.length > 0
      ? 1
      : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
