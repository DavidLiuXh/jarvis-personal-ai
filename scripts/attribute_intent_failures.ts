#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type FailedCheck = {
  dimension?: string;
  key?: string;
  message?: string;
  expected?: unknown;
  actual?: unknown;
  pass?: boolean;
};

type FailureCategory =
  | "schema_invalid"
  | "json_repair_unstable"
  | "subject_boundary_error"
  | "memory_target_error"
  | "topic_boundary_error"
  | "action_boundary_error"
  | "multi_intent_step_error"
  | "clarification_policy_error"
  | "memory_policy_leak"
  | "retrieval_gap"
  | "routing_calibration_error"
  | "model_instability"
  | "unknown";

type RecommendedAction =
  | "add_expression_to_existing_invariant"
  | "create_new_invariant"
  | "fix_policy_priority"
  | "fix_model_prompt_schema"
  | "fix_retrieval"
  | "ignore_noise";

type FailureSample = {
  source: string;
  id: string;
  runKey?: string;
  model?: string;
  prompt?: string;
  history?: unknown[];
  tags?: string[];
  failedChecks: FailedCheck[];
  observed?: Record<string, unknown>;
  invariant?: string;
  dimension?: string;
  error?: string;
};

type Attribution = {
  source: string;
  id: string;
  runKey?: string;
  model?: string;
  prompt?: string;
  history?: unknown[];
  tags: string[];
  failedChecks: FailedCheck[];
  failureCategory: FailureCategory;
  suspectedPrinciple: string;
  suspectedInvariant: string;
  confidence: number;
  recommendedAction: RecommendedAction;
  reason: string;
  observed?: Record<string, unknown>;
  generatedAt: string;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultLogsDir = path.join(repoRoot, "evals/logs");
const defaultCandidatesDir = path.join(repoRoot, "evals/intent/candidates");
const defaultOutputJsonl = path.join(
  defaultCandidatesDir,
  "failure-attribution-latest.jsonl",
);
const defaultOutputMd = path.join(
  defaultCandidatesDir,
  "failure-attribution-latest.md",
);

const CATEGORY_TO_PRINCIPLE: Record<FailureCategory, string> = {
  schema_invalid: "SCHEMA_VALIDATION_AND_REPAIR",
  json_repair_unstable: "SCHEMA_VALIDATION_AND_REPAIR",
  subject_boundary_error: "SUBJECT_MEMORY_SEPARATION",
  memory_target_error: "MEMORY_TARGET_SPECIFICITY",
  topic_boundary_error: "TOPIC_BOUNDARY_GROUNDING",
  action_boundary_error: "ACTION_DOMINANCE",
  multi_intent_step_error: "MULTI_STEP_PRESERVATION",
  clarification_policy_error: "CLARIFICATION_BEFORE_RISKY_ACTION",
  memory_policy_leak: "SUBJECT_MEMORY_SEPARATION",
  retrieval_gap: "TIME_SCOPED_RECALL_ISOLATION",
  routing_calibration_error: "ROUTING_CALIBRATION",
  model_instability: "MODEL_STABILITY",
  unknown: "UNKNOWN",
};

const CATEGORY_TO_INVARIANT: Record<FailureCategory, string> = {
  schema_invalid: "INTENT_MODEL_OUTPUT_MUST_PARSE_TO_SCHEMA",
  json_repair_unstable: "INTENT_JSON_REPAIR_RATE_STAYS_BOUNDED",
  subject_boundary_error: "SUBJECT_BOUNDARY_MATCHES_USER_CONTEXT",
  memory_target_error: "MEMORY_TARGET_SPECIFICITY",
  topic_boundary_error: "TOPIC_BOUNDARY_GROUNDING",
  action_boundary_error: "ACTION_BOUNDARY_MATCHES_EXPLICIT_REQUEST",
  multi_intent_step_error: "MULTI_STEP_PRESERVATION",
  clarification_policy_error: "CLARIFICATION_BEFORE_RISKY_ACTION",
  memory_policy_leak: "EXTERNAL_SUBJECT_HAS_EMPTY_PERSONAL_MEMORY_CONTRACT",
  retrieval_gap: "TIME_SCOPED_HISTORY_RECALL_USES_ENTRY_SCOPE",
  routing_calibration_error: "ROUTING_SCORE_REFLECTS_OPERATIONAL_COMPLEXITY",
  model_instability: "MODEL_OUTPUT_STABILITY",
  unknown: "UNKNOWN",
};

function parseArgs(argv: string[]) {
  const args = {
    logsDir: defaultLogsDir,
    candidatesPath: path.join(
      defaultCandidatesDir,
      "intent-eval-candidates-latest.jsonl",
    ),
    matrixJson: "",
    realModelJson: "",
    outputJsonl: defaultOutputJsonl,
    outputMd: defaultOutputMd,
    includeHistoricalCandidates: true,
    failOnAttribution: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--logs-dir" && next) {
      args.logsDir = path.resolve(next);
      i += 1;
    } else if (arg === "--candidates" && next) {
      args.candidatesPath = path.resolve(next);
      i += 1;
    } else if (arg === "--matrix-json" && next) {
      args.matrixJson = path.resolve(next);
      i += 1;
    } else if (arg === "--real-model-json" && next) {
      args.realModelJson = path.resolve(next);
      i += 1;
    } else if (arg === "--output-jsonl" && next) {
      args.outputJsonl = path.resolve(next);
      i += 1;
    } else if (arg === "--output-md" && next) {
      args.outputMd = path.resolve(next);
      i += 1;
    } else if (arg === "--no-historical-candidates") {
      args.includeHistoricalCandidates = false;
    } else if (arg === "--fail-on-attribution") {
      args.failOnAttribution = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  npx tsx scripts/attribute_intent_failures.ts [options]

Options:
  --logs-dir <path>          Eval logs directory. Default: evals/logs
  --matrix-json <path>       Matrix report. Default: intent-matrix-latest.json
  --real-model-json <path>   Real-model report. Default: latest intent-eval-*.json
  --candidates <path>        Historical candidate JSONL.
  --output-jsonl <path>      Output JSONL. Default: evals/intent/candidates/failure-attribution-latest.jsonl
  --output-md <path>         Output markdown report.
  --no-historical-candidates Ignore prior eval candidates.
  --fail-on-attribution      Exit non-zero when attributions are produced.
`);
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function findLatestReport(logsDir: string, prefix: string): string | null {
  if (!fs.existsSync(logsDir)) return null;
  const files = fs
    .readdirSync(logsDir)
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        name.endsWith(".json") &&
        !name.includes("latest"),
    )
    .map((name) => path.join(logsDir, name))
    .sort(
      (left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs,
    );
  return files[0] ?? null;
}

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error: any) {
        throw new Error(`${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function failedChecksFrom(value: any): FailedCheck[] {
  const checks = Array.isArray(value?.failedChecks)
    ? value.failedChecks
    : Array.isArray(value?.checks)
      ? value.checks.filter((check: any) => check.pass === false)
      : [];
  return checks.map((check: any) => ({
    dimension: check.dimension,
    key: check.key,
    message: check.message,
    expected: check.expected,
    actual: check.actual,
    pass: check.pass,
  }));
}

function collectMatrixFailures(report: any): FailureSample[] {
  if (!report) return [];
  return (report.results ?? [])
    .filter((result: any) => result.passed === false)
    .map((result: any) => ({
      source: "intent_matrix_failure",
      id: result.id,
      prompt: result.prompt,
      tags: result.tags ?? [],
      failedChecks: failedChecksFrom(result),
      invariant: result.invariant,
      dimension: result.dimension,
      observed: {
        intent: result.intent,
        clarification: result.clarification,
        memoryPolicy: result.memoryPolicy,
      },
      error: result.error,
    }));
}

function collectRealModelFailures(report: any): FailureSample[] {
  if (!report) return [];
  return (report.reports ?? []).flatMap((modelReport: any) =>
    (modelReport.results ?? [])
      .filter((result: any) => result.passed === false)
      .map((result: any) => ({
        source: "intent_eval_failure",
        id: result.id,
        runKey: result.runKey,
        model: modelReport.model,
        prompt: result.prompt,
        history: result.history,
        tags: result.tags ?? [],
        failedChecks: failedChecksFrom(result),
        observed: {
          intent: result.intent,
          clarification: result.clarification,
        },
        error: result.error,
      })),
  );
}

function collectHistoricalCandidates(filePath: string): FailureSample[] {
  return readJsonl(filePath).map((item: any) => ({
    source: item.source ?? "intent_eval_candidate",
    id: item.id ?? item.runKey ?? "unknown",
    runKey: item.runKey,
    model: item.model,
    prompt: item.prompt,
    history: item.history,
    tags: item.tags ?? [],
    failedChecks: failedChecksFrom(item),
    observed: item.observed,
    error: item.error,
  }));
}

function normalizeCheckName(check: FailedCheck): string {
  return String(
    check.dimension ?? check.key ?? check.message ?? "",
  ).toLowerCase();
}

function inferCategory(sample: FailureSample): {
  category: FailureCategory;
  confidence: number;
  reason: string;
} {
  if (sample.error) {
    const text = sample.error.toLowerCase();
    if (
      text.includes("json") ||
      text.includes("parse") ||
      text.includes("schema")
    ) {
      return {
        category: "schema_invalid",
        confidence: 0.9,
        reason: "failure error mentions JSON parsing or schema validation",
      };
    }
  }

  const names = sample.failedChecks.map(normalizeCheckName);
  const joined = names.join(" ");
  if (joined.includes("schemavalid")) {
    return {
      category: "schema_invalid",
      confidence: 0.95,
      reason: "schemaValid check failed",
    };
  }
  if (joined.includes("subject")) {
    return {
      category: "subject_boundary_error",
      confidence: 0.85,
      reason: "subject boundary check failed",
    };
  }
  if (joined.includes("memorypolicy")) {
    return {
      category: "memory_policy_leak",
      confidence: 0.9,
      reason: "memory policy contract check failed",
    };
  }
  if (joined.includes("memorytarget") || joined.includes("memoryrecall")) {
    return {
      category: "memory_target_error",
      confidence: 0.9,
      reason: "memory target check failed",
    };
  }
  if (joined.includes("topic") || joined.includes("referencesrecenthistory")) {
    return {
      category: "topic_boundary_error",
      confidence: 0.85,
      reason: "topic boundary or recent-history check failed",
    };
  }
  if (joined.includes("intentstep") || joined.includes("executionplan")) {
    return {
      category: "multi_intent_step_error",
      confidence: 0.9,
      reason: "intent step or execution plan check failed",
    };
  }
  if (joined.includes("clarification")) {
    return {
      category: "clarification_policy_error",
      confidence: 0.9,
      reason: "clarification policy check failed",
    };
  }
  if (
    joined.includes("tasktype") ||
    joined.includes("needstool") ||
    joined.includes("needsscheduling") ||
    joined.includes("action")
  ) {
    return {
      category: "action_boundary_error",
      confidence: 0.8,
      reason: "task/action boundary check failed",
    };
  }
  if (joined.includes("routing")) {
    return {
      category: "routing_calibration_error",
      confidence: 0.8,
      reason: "routing check failed",
    };
  }

  return {
    category: "unknown",
    confidence: 0.3,
    reason: "no deterministic attribution rule matched",
  };
}

function inferInvariant(
  sample: FailureSample,
  category: FailureCategory,
): string {
  if (sample.invariant) return sample.invariant;

  const text = [
    sample.prompt,
    JSON.stringify(sample.failedChecks),
    JSON.stringify(sample.observed ?? {}),
  ]
    .join("\n")
    .toLowerCase();

  if (category === "topic_boundary_error") {
    if (
      text.includes("current_context_reference") ||
      text.includes("gemini spark")
    ) {
      return "SELF_CONTAINED_ENTITY_QUERY_DOES_NOT_BORROW_CURRENT_CONTEXT";
    }
    if (text.includes("personal identity") || text.includes("david liu")) {
      return "PERSONAL_FACT_ASSERTION_STARTS_NEW_TOPIC";
    }
    return "TOPIC_BOUNDARY_GROUNDING";
  }
  if (category === "memory_target_error") {
    if (text.includes("current_context_reference")) {
      return "ANAPHORIC_FOLLOWUP_USES_CURRENT_CONTEXT_REFERENCE";
    }
    if (text.includes("external_past_event")) {
      return "EXTERNAL_PAST_EVENTS_ARE_NOT_PERSONAL_RECALL";
    }
    if (text.includes("conversation_history")) {
      return "CONVERSATION_HISTORY_RECALL_USES_HISTORY_TARGET";
    }
    if (text.includes("user_memory")) {
      return "USER_MEMORY_RECALL_USES_USER_MEMORY_TARGET";
    }
  }
  if (category === "memory_policy_leak" && text.includes("external")) {
    return "EXTERNAL_SUBJECT_HAS_EMPTY_PERSONAL_MEMORY_CONTRACT";
  }
  if (category === "multi_intent_step_error" && text.includes("delegate")) {
    return "MULTI_INTENT_ORDER_PRESERVES_DELEGATE_THEN_SCHEDULE";
  }
  if (category === "clarification_policy_error" && text.includes("schedule")) {
    return "INTERACTIVE_SCHEDULE_CREATE_REQUIRES_TIME";
  }
  return CATEGORY_TO_INVARIANT[category];
}

function inferRecommendedAction(
  sample: FailureSample,
  category: FailureCategory,
  invariant: string,
): RecommendedAction {
  if (category === "schema_invalid" || category === "json_repair_unstable") {
    return "fix_model_prompt_schema";
  }
  if (category === "retrieval_gap") return "fix_retrieval";
  if (category === "unknown") return "create_new_invariant";
  if (sample.invariant || invariant !== CATEGORY_TO_INVARIANT[category]) {
    return "add_expression_to_existing_invariant";
  }
  if (
    category === "subject_boundary_error" ||
    category === "memory_target_error" ||
    category === "topic_boundary_error" ||
    category === "action_boundary_error" ||
    category === "multi_intent_step_error" ||
    category === "clarification_policy_error" ||
    category === "memory_policy_leak"
  ) {
    return "fix_policy_priority";
  }
  return "add_expression_to_existing_invariant";
}

function attribute(sample: FailureSample): Attribution {
  const inferred = inferCategory(sample);
  const invariant = inferInvariant(sample, inferred.category);
  return {
    source: sample.source,
    id: sample.id,
    runKey: sample.runKey,
    model: sample.model,
    prompt: sample.prompt,
    history: sample.history,
    tags: sample.tags ?? [],
    failedChecks: sample.failedChecks,
    failureCategory: inferred.category,
    suspectedPrinciple: CATEGORY_TO_PRINCIPLE[inferred.category],
    suspectedInvariant: invariant,
    confidence: inferred.confidence,
    recommendedAction: inferRecommendedAction(
      sample,
      inferred.category,
      invariant,
    ),
    reason: inferred.reason,
    observed: sample.observed,
    generatedAt: new Date().toISOString(),
  };
}

function dedupe(samples: FailureSample[]): FailureSample[] {
  const seen = new Set<string>();
  const output: FailureSample[] = [];
  for (const sample of samples) {
    const key = `${sample.source}:${sample.model ?? ""}:${sample.runKey ?? sample.id}:${sample.prompt ?? ""}:${JSON.stringify(sample.failedChecks)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(sample);
  }
  return output;
}

function statsBy<T extends string>(
  rows: Attribution[],
  keyOf: (row: Attribution) => T,
) {
  const stats: Record<string, number> = {};
  for (const row of rows) {
    const key = keyOf(row);
    stats[key] = (stats[key] ?? 0) + 1;
  }
  return stats;
}

function table(stats: Record<string, number>): string {
  const rows = Object.entries(stats).sort(
    ([, left], [, right]) => right - left,
  );
  if (rows.length === 0) return "_None._";
  return [
    "| Name | Count |",
    "| --- | ---: |",
    ...rows.map(([name, count]) => `| ${name} | ${count} |`),
  ].join("\n");
}

function renderMarkdown(attributions: Attribution[]): string {
  const lines = [
    "# Intent Failure Attribution Report",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Attributions: ${attributions.length}`,
    "",
    "## By Category",
    "",
    table(statsBy(attributions, (item) => item.failureCategory)),
    "",
    "## By Principle",
    "",
    table(statsBy(attributions, (item) => item.suspectedPrinciple)),
    "",
    "## By Recommended Action",
    "",
    table(statsBy(attributions, (item) => item.recommendedAction)),
  ];

  if (attributions.length > 0) {
    lines.push("", "## Samples", "");
    for (const item of attributions.slice(0, 50)) {
      lines.push(
        `### ${item.id}`,
        "",
        `- Source: ${item.source}`,
        `- Category: ${item.failureCategory}`,
        `- Principle: ${item.suspectedPrinciple}`,
        `- Invariant: ${item.suspectedInvariant}`,
        `- Confidence: ${item.confidence.toFixed(2)}`,
        `- Recommended action: ${item.recommendedAction}`,
        `- Reason: ${item.reason}`,
      );
      if (item.prompt) lines.push(`- Prompt: ${item.prompt}`);
      if (item.failedChecks.length > 0) {
        lines.push("- Failed checks:");
        for (const check of item.failedChecks) {
          lines.push(
            `  - ${check.dimension ?? check.key ?? check.message ?? "check"}: expected ${JSON.stringify(check.expected)}, actual ${JSON.stringify(check.actual)}`,
          );
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrixPath =
    args.matrixJson || path.join(args.logsDir, "intent-matrix-latest.json");
  const realModelPath =
    args.realModelJson || findLatestReport(args.logsDir, "intent-eval-");

  const samples = dedupe([
    ...collectMatrixFailures(readJson(matrixPath)),
    ...collectRealModelFailures(realModelPath ? readJson(realModelPath) : null),
    ...(args.includeHistoricalCandidates
      ? collectHistoricalCandidates(args.candidatesPath)
      : []),
  ]);
  const attributions = samples.map(attribute);

  fs.mkdirSync(path.dirname(args.outputJsonl), { recursive: true });
  fs.writeFileSync(
    args.outputJsonl,
    attributions.map((item) => JSON.stringify(item)).join("\n") +
      (attributions.length > 0 ? "\n" : ""),
  );
  fs.writeFileSync(args.outputMd, renderMarkdown(attributions) + "\n");

  console.log(
    `Attributed ${attributions.length} intent failure sample(s): ${path.relative(repoRoot, args.outputJsonl)}`,
  );
  console.log(`Report: ${path.relative(repoRoot, args.outputMd)}`);
  if (args.failOnAttribution && attributions.length > 0) {
    process.exitCode = 1;
  }
}

main();
