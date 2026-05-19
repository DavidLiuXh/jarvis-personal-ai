#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IntentResolver,
  type ConversationTurn,
  type IntentFrame,
} from "../jarvis/src/core/intentResolver.js";

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
  | "topicAnalysis"
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
  tags: string[];
  prompt: string;
  passed: boolean;
  durationMs: number;
  checks: CheckResult[];
  intent?: IntentFrame;
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
  results: CaseResult[];
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultCasesPath = path.join(repoRoot, "evals/intent/cases.jsonl");
const defaultOutputDir = path.join(repoRoot, "evals/logs");

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
    tag: "",
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
    } else if (arg === "--tag" && next) {
      args.tag = next;
      i += 1;
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
  if (args.models.length === 0) {
    throw new Error("At least one model is required.");
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
  --tag <tag>          Run only cases with this tag
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

  return checks;
}

async function runCase(
  model: string,
  evalCase: IntentEvalCase,
  options: { baseUrl: string; timeoutMs: number },
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
    const checks = compareIntent(intent, evalCase.expect);
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
      tags: evalCase.tags ?? [],
      prompt: evalCase.prompt,
      passed: checks.every((check) => check.pass),
      durationMs: Date.now() - started,
      checks,
      intent,
    };
  } catch (error: any) {
    return {
      id: evalCase.id,
      tags: evalCase.tags ?? [],
      prompt: evalCase.prompt,
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

function summarizeModel(model: string, results: CaseResult[]): ModelReport {
  const durationMs = results.reduce(
    (sum, result) => sum + result.durationMs,
    0,
  );
  const dimensionStats: ModelReport["dimensionStats"] = {};
  const tagStats: ModelReport["tagStats"] = {};

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
    results,
  };
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

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cases = readCases(args.casesPath);
  if (args.tag)
    cases = cases.filter((evalCase) => evalCase.tags?.includes(args.tag));
  if (args.limit > 0) cases = cases.slice(0, args.limit);
  if (cases.length === 0) throw new Error("No eval cases selected.");

  fs.mkdirSync(args.outputDir, { recursive: true });

  console.log(
    `Running ${cases.length} intent eval case(s) across ${args.models.length} model(s).`,
  );
  console.log(`Cases: ${args.casesPath}`);
  console.log(`Ollama: ${args.baseUrl}`);

  const reports: ModelReport[] = [];
  for (const model of args.models) {
    console.log(`\n--- Model: ${model} ---`);
    const results: CaseResult[] = [];
    for (const evalCase of cases) {
      const result = await runCase(model, evalCase, {
        baseUrl: args.baseUrl,
        timeoutMs: args.timeoutMs,
      });
      results.push(result);
      const marker = result.passed ? "PASS" : "FAIL";
      console.log(`${marker} ${evalCase.id} (${result.durationMs}ms)`);
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
    reports,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  const markdown = renderMarkdown(reports);
  fs.writeFileSync(mdPath, markdown);
  fs.writeFileSync(latestMdPath, markdown);

  console.log(`\nJSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);
  console.log(`Latest report: ${latestMdPath}`);

  const hasFailures = reports.some((report) => report.failed > 0);
  process.exitCode = hasFailures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
