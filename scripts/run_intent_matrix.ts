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
  IntentModelClient,
  IntentModelClientRequest,
} from "../jarvis/src/memory-runtime/adapters.js";
import {
  buildIntentAwareMemoryPolicy,
  type IntentAwareMemoryPolicy,
} from "../jarvis/src/memory-runtime/intentAwareMemoryPolicy.js";

type MatrixDimension =
  | "memoryTarget"
  | "topicBoundary"
  | "actionBoundary"
  | "multiIntent"
  | "memoryPolicy"
  | "agentRouting"
  | "clarification";

type MatrixCase = {
  id: string;
  dimension: MatrixDimension;
  invariant: string;
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
  invariant: string;
  tags: string[];
  passed: boolean;
  durationMs: number;
  checks: CheckResult[];
  intent?: IntentFrame;
  memoryPolicy?: IntentAwareMemoryPolicy;
  error?: string;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultCasesPath = path.join(repoRoot, "evals/intent/matrix-cases.jsonl");
const defaultOutputDir = path.join(repoRoot, "evals/logs");
const defaultNow = "2026-05-26T04:00:00.000Z";

function parseArgs(argv: string[]) {
  const args = {
    casesPath: defaultCasesPath,
    outputDir: defaultOutputDir,
    tag: "",
    invariant: "",
    dimension: "" as "" | MatrixDimension,
    limit: 0,
    updateLatest: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cases" && next) {
      args.casesPath = path.resolve(next);
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
  return args;
}

function printHelp() {
  console.log(`
Usage:
  npx tsx scripts/run_intent_matrix.ts [options]

Options:
  --cases <path>       JSONL matrix case file. Default: evals/intent/matrix-cases.jsonl
  --output-dir <path>  Report directory. Default: evals/logs
  --dimension <name>   Run one taxonomy dimension
  --invariant <id>     Run one invariant id
  --tag <tag>          Run cases with a tag
  --limit <n>          Run the first n selected cases
  --no-latest          Do not update intent-matrix-latest.md/json
`);
}

function readCases(casesPath: string): MatrixCase[] {
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

async function runCase(evalCase: MatrixCase): Promise<CaseResult> {
  const startedAt = Date.now();
  try {
    const raw = deepMerge(baseRawIntent(evalCase.prompt), evalCase.model);
    const client = new MatrixIntentModelClient(
      raw,
      evalCase.focusedResponses ?? [],
    );
    const resolver = new IntentResolver({
      modelClient: client,
      modelSource: "intent-matrix/fake-model",
      historyTurns: 8,
    });
    const intent = await resolver.resolve({
      userPrompt: evalCase.prompt,
      history: evalCase.history ?? [],
      now: new Date(evalCase.now ?? defaultNow),
    });
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
    const checks = compareCase(evalCase, intent, memoryPolicy);
    return {
      id: evalCase.id,
      dimension: evalCase.dimension,
      invariant: evalCase.invariant,
      tags: evalCase.tags ?? [],
      passed: checks.every((check) => check.pass),
      durationMs: Date.now() - startedAt,
      checks,
      intent,
      memoryPolicy,
    };
  } catch (error: any) {
    return {
      id: evalCase.id,
      dimension: evalCase.dimension,
      invariant: evalCase.invariant,
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

function formatStats(stats: Record<string, { passed: number; total: number }>) {
  return Object.entries(stats)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const rate = value.total === 0 ? 0 : value.passed / value.total;
      return `| ${key} | ${value.passed}/${value.total} | ${(rate * 100).toFixed(1)}% |`;
    })
    .join("\n");
}

function buildMarkdownReport(results: CaseResult[], casesPath: string) {
  const passed = results.filter((result) => result.passed).length;
  const total = results.length;
  const dimensionStats = summarizeBy(results, (result) => result.dimension);
  const invariantStats = summarizeBy(results, (result) => result.invariant);
  const failed = results.filter((result) => !result.passed);
  const lines: string[] = [
    "# Intent Matrix Eval Report",
    "",
    `- Cases: ${passed}/${total}`,
    `- Pass rate: ${total === 0 ? "0.0" : ((passed / total) * 100).toFixed(1)}%`,
    `- Cases file: ${path.relative(repoRoot, casesPath)}`,
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
  ];

  if (failed.length > 0) {
    lines.push("", "## Failures", "");
    for (const result of failed) {
      lines.push(`### ${result.id}`, "");
      lines.push(`- Dimension: ${result.dimension}`);
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
  let cases = readCases(args.casesPath);
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
  for (const evalCase of cases) {
    const result = await runCase(evalCase);
    results.push(result);
    const status = result.passed ? "PASS" : "FAIL";
    console.log(
      `${status} ${evalCase.id} (${evalCase.dimension}/${evalCase.invariant})`,
    );
  }

  fs.mkdirSync(args.outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    generatedAt: new Date().toISOString(),
    casesPath: args.casesPath,
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    dimensionStats: summarizeBy(results, (result) => result.dimension),
    invariantStats: summarizeBy(results, (result) => result.invariant),
    results,
  };
  const markdown = buildMarkdownReport(results, args.casesPath);
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
