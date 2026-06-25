#!/usr/bin/env tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type GateResult = {
  id: string;
  passed: boolean;
  severity: "blocker" | "warning";
  message: string;
  actual: unknown;
  expected: unknown;
};

function parseArgs(argv: string[]) {
  const args = {
    logsDir: path.join(repoRoot, "evals/logs"),
    outputDir: path.join(repoRoot, "evals/logs"),
    matrixJson: "",
    llmBackendJson: "",
    memoryQualityJson: "",
    taskGraphQualityJson: "",
    gate: false,
    highRiskConfidenceFloor: 0.8,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--logs-dir" && next) {
      args.logsDir = path.resolve(next);
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      i += 1;
    } else if (arg === "--matrix-json" && next) {
      args.matrixJson = path.resolve(next);
      i += 1;
    } else if (arg === "--llm-backend-json" && next) {
      args.llmBackendJson = path.resolve(next);
      i += 1;
    } else if (arg === "--memory-quality-json" && next) {
      args.memoryQualityJson = path.resolve(next);
      i += 1;
    } else if (arg === "--task-graph-quality-json" && next) {
      args.taskGraphQualityJson = path.resolve(next);
      i += 1;
    } else if (arg === "--gate") {
      args.gate = true;
    } else if (arg === "--high-risk-confidence-floor" && next) {
      args.highRiskConfidenceFloor = Number(next);
      i += 1;
    }
  }
  return args;
}

function readJson<T = any>(filePath: string): T | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function countJsonl(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#")).length;
}

function findLatest(logsDir: string, name: string, prefix: string): string {
  const direct = path.join(logsDir, name);
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(logsDir)) return "";
  const files = fs
    .readdirSync(logsDir)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
    .sort()
    .reverse();
  return files[0] ? path.join(logsDir, files[0]) : "";
}

function passRate(passed: number, total: number): number {
  return total === 0 ? 0 : Number((passed / total).toFixed(4));
}

function highRiskConfidenceViolations(matrix: any, floor: number) {
  return (matrix?.results ?? []).filter((result: any) => {
    const intent = result.intent;
    if (!intent) return false;
    const highRisk =
      intent.richIntent?.riskLevel === "high" ||
      intent.intentSteps?.some((step: any) => step.riskLevel === "high");
    if (!highRisk) return false;
    const confidence = Math.min(
      intent.confidence ?? 0,
      intent.confidenceByDimension?.action ?? 0,
      intent.confidenceByDimension?.richIntent ?? 0,
    );
    return confidence < floor;
  });
}

function externalMemoryLeakageViolations(matrix: any) {
  return (matrix?.results ?? []).filter((result: any) => {
    if (result.intent?.subject !== "external") return false;
    const contract = result.memoryPolicy?.contract;
    if (!contract) return false;
    return (
      contract.needMemory === true ||
      contract.targetScopes?.length > 0 ||
      contract.constraints?.allowPersonalFacts === true ||
      contract.constraints?.allowSessionHistory === true ||
      contract.constraints?.allowEntries === true
    );
  });
}

function successWithoutToolViolations(matrix: any) {
  return (matrix?.results ?? []).filter((result: any) => {
    if (!result.passed || result.intent?.needsTool !== true) return false;
    const expectedTools = (result.checks ?? []).filter((check: any) =>
      String(check.key).includes("requiredToolsContain"),
    );
    const planTools = result.executionPlan?.requiredTools ?? [];
    return expectedTools.length > 0 && planTools.length === 0;
  });
}

function buildGates(input: {
  matrix: any;
  llmBackend: any;
  memoryQuality: any;
  taskGraphQuality: any;
  highRiskConfidenceFloor: number;
}): GateResult[] {
  const highRiskViolations = highRiskConfidenceViolations(
    input.matrix,
    input.highRiskConfidenceFloor,
  );
  const leakageViolations = externalMemoryLeakageViolations(input.matrix);
  const successWithoutTool = successWithoutToolViolations(input.matrix);
  return [
    {
      id: "required_invariant_pass_rate",
      passed: (input.matrix?.failed ?? 1) === 0,
      severity: "blocker",
      message: "Required matrix invariants must pass at 100%.",
      actual: `${input.matrix?.passed ?? 0}/${input.matrix?.total ?? 0}`,
      expected: "failed=0",
    },
    {
      id: "high_risk_action_confidence_floor",
      passed: highRiskViolations.length === 0,
      severity: "blocker",
      message: "High-risk actions must meet confidence floor.",
      actual: highRiskViolations.map((result: any) => result.id),
      expected: `confidence>=${input.highRiskConfidenceFloor}`,
    },
    {
      id: "external_personal_memory_leakage_zero",
      passed: leakageViolations.length === 0,
      severity: "blocker",
      message: "External-only requests must not allow personal memory.",
      actual: leakageViolations.map((result: any) => result.id),
      expected: [],
    },
    {
      id: "tool_backed_success_without_tool_zero",
      passed: successWithoutTool.length === 0,
      severity: "blocker",
      message: "Tool-backed success must have required tool contract.",
      actual: successWithoutTool.map((result: any) => result.id),
      expected: [],
    },
    {
      id: "llm_backend_eval_pass",
      passed: (input.llmBackend?.failed ?? 1) === 0,
      severity: "blocker",
      message: "Backend adapter smoke evals must pass.",
      actual: `${input.llmBackend?.passed ?? 0}/${input.llmBackend?.total ?? 0}`,
      expected: "failed=0",
    },
    {
      id: "memory_quality_eval_pass",
      passed:
        input.memoryQuality !== null &&
        (input.memoryQuality.total ?? 0) > 0 &&
        input.memoryQuality.passed === input.memoryQuality.total,
      severity: "blocker",
      message: "Memory runtime write/read/injection quality evals must pass.",
      actual: `${input.memoryQuality?.passed ?? 0}/${input.memoryQuality?.total ?? 0}`,
      expected: "passed=total",
    },
    {
      id: "task_graph_quality_eval_pass",
      passed:
        input.taskGraphQuality !== null &&
        (input.taskGraphQuality.total ?? 0) > 0 &&
        input.taskGraphQuality.passed === input.taskGraphQuality.total,
      severity: "blocker",
      message:
        "TaskGraph planning/execution/acceptance/replanning quality evals must pass.",
      actual: `${input.taskGraphQuality?.passed ?? 0}/${input.taskGraphQuality?.total ?? 0}`,
      expected: "passed=total",
    },
  ];
}

function feedbackMetrics() {
  const runtimeCandidates = countJsonl(
    path.join(
      os.homedir(),
      ".gemini-jarvis/intent-feedback/runtime-intent-candidates-latest.jsonl",
    ),
  );
  const evalCandidates = countJsonl(
    path.join(
      repoRoot,
      "evals/intent/candidates/intent-eval-candidates-latest.jsonl",
    ),
  );
  const reviewTemplate = countJsonl(
    path.join(
      repoRoot,
      "evals/intent/candidates/intent-feedback-review-template.jsonl",
    ),
  );
  const promoted = countJsonl(
    path.join(repoRoot, "evals/intent/reviewed-runtime-cases.jsonl"),
  );
  const captured = runtimeCandidates + evalCandidates;
  return {
    captured,
    runtimeCandidates,
    evalCandidates,
    reviewTemplateRows: reviewTemplate,
    promotedRegressions: promoted,
    closureRate: passRate(promoted, captured),
  };
}

function table(rows: string[][]): string[] {
  return rows.map((row) => `| ${row.join(" | ")} |`);
}

function renderMarkdown(payload: any): string {
  const gateRows = payload.gates.map((gate: GateResult) => [
    gate.id,
    gate.passed ? "PASS" : "FAIL",
    gate.message,
  ]);
  const trend = payload.trend ?? {};
  return [
    "# Runtime Quality Dashboard",
    "",
    `- Generated: ${payload.generatedAt}`,
    `- Verdict: ${payload.verdict}`,
    `- Matrix: ${payload.summary.matrix.passed}/${payload.summary.matrix.total}`,
    `- LLM backend: ${payload.summary.llmBackend.passed}/${payload.summary.llmBackend.total}`,
    `- Memory quality: ${payload.summary.memoryQuality.passed}/${payload.summary.memoryQuality.total}`,
    `- TaskGraph quality: ${payload.summary.taskGraphQuality.passed}/${payload.summary.taskGraphQuality.total}`,
    "",
    "## Quality Gates",
    "",
    "| Gate | Result | Meaning |",
    "| --- | --- | --- |",
    ...table(gateRows),
    "",
    "## Runtime Trend",
    "",
    `- Policy correction rate: ${trend.rates?.policyCorrection ?? 0}`,
    `- JSON repair rate: ${trend.rates?.jsonRepair ?? 0}`,
    `- Fallback rate: ${trend.rates?.fallback ?? 0}`,
    `- Clarification block rate: ${trend.rates?.clarificationBlock ?? 0}`,
    `- Execution contract enforcement rate: ${trend.rates?.executionContractEnforcement ?? 0}`,
    `- Tool failure rate: ${trend.rates?.toolFailure ?? 0}`,
    `- Tool blocked rate: ${trend.rates?.toolBlocked ?? 0}`,
    `- Memory empty rate: ${trend.rates?.memoryInjectionEmpty ?? 0}`,
    "",
    "## Feedback Loop",
    "",
    `- Captured candidates: ${payload.feedback.captured}`,
    `- Runtime candidates: ${payload.feedback.runtimeCandidates}`,
    `- Eval candidates: ${payload.feedback.evalCandidates}`,
    `- Review template rows: ${payload.feedback.reviewTemplateRows}`,
    `- Promoted regressions: ${payload.feedback.promotedRegressions}`,
    `- Closure rate: ${payload.feedback.closureRate}`,
    "",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrixPath =
    args.matrixJson ||
    findLatest(args.logsDir, "intent-matrix-latest.json", "intent-matrix-");
  const llmBackendPath =
    args.llmBackendJson ||
    findLatest(args.logsDir, "llm-backend-latest.json", "llm-backend-");
  const memoryQualityPath =
    args.memoryQualityJson ||
    findLatest(args.logsDir, "memory-quality-latest.json", "memory-quality-");
  const taskGraphQualityPath =
    args.taskGraphQualityJson ||
    findLatest(
      args.logsDir,
      "task-graph-quality-latest.json",
      "task-graph-quality-",
    );
  const matrix = readJson<any>(matrixPath);
  const llmBackend = readJson<any>(llmBackendPath);
  const memoryQuality = readJson<any>(memoryQualityPath);
  const taskGraphQuality = readJson<any>(taskGraphQualityPath);
  if (!matrix) throw new Error(`Matrix report not found: ${matrixPath}`);
  if (!llmBackend) {
    throw new Error(`LLM backend report not found: ${llmBackendPath}`);
  }
  if (!memoryQuality) {
    throw new Error(`Memory quality report not found: ${memoryQualityPath}`);
  }
  if (!taskGraphQuality) {
    throw new Error(
      `TaskGraph quality report not found: ${taskGraphQualityPath}`,
    );
  }

  const gates = buildGates({
    matrix,
    llmBackend,
    memoryQuality,
    taskGraphQuality,
    highRiskConfidenceFloor: args.highRiskConfidenceFloor,
  });
  const verdict = gates.every((gate) => gate.passed) ? "pass" : "fail";
  const payload = {
    generatedAt: new Date().toISOString(),
    verdict,
    sources: {
      matrix: path.relative(repoRoot, matrixPath),
      llmBackend: path.relative(repoRoot, llmBackendPath),
      memoryQuality: path.relative(repoRoot, memoryQualityPath),
      taskGraphQuality: path.relative(repoRoot, taskGraphQualityPath),
    },
    summary: {
      matrix: {
        total: matrix.total ?? 0,
        passed: matrix.passed ?? 0,
        failed: matrix.failed ?? 0,
        passRate: passRate(matrix.passed ?? 0, matrix.total ?? 0),
      },
      llmBackend: {
        total: llmBackend.total ?? 0,
        passed: llmBackend.passed ?? 0,
        failed: llmBackend.failed ?? 0,
        passRate: passRate(llmBackend.passed ?? 0, llmBackend.total ?? 0),
      },
      memoryQuality: {
        total: memoryQuality.total ?? 0,
        passed: memoryQuality.passed ?? 0,
        failed: (memoryQuality.total ?? 0) - (memoryQuality.passed ?? 0),
        passRate: passRate(memoryQuality.passed ?? 0, memoryQuality.total ?? 0),
      },
      taskGraphQuality: {
        total: taskGraphQuality.total ?? 0,
        passed: taskGraphQuality.passed ?? 0,
        failed: (taskGraphQuality.total ?? 0) - (taskGraphQuality.passed ?? 0),
        passRate: passRate(
          taskGraphQuality.passed ?? 0,
          taskGraphQuality.total ?? 0,
        ),
      },
    },
    trend: matrix.trend,
    feedback: feedbackMetrics(),
    gates,
  };

  fs.mkdirSync(args.outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(
    args.outputDir,
    `runtime-quality-${timestamp}.json`,
  );
  const mdPath = path.join(args.outputDir, `runtime-quality-${timestamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");
  fs.writeFileSync(mdPath, renderMarkdown(payload) + "\n");
  fs.writeFileSync(
    path.join(args.outputDir, "runtime-quality-latest.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(args.outputDir, "runtime-quality-latest.md"),
    renderMarkdown(payload) + "\n",
  );

  console.log(`Runtime quality dashboard: ${path.relative(repoRoot, mdPath)}`);
  console.log(`Verdict: ${verdict}`);
  if (args.gate && verdict !== "pass") process.exit(1);
}

main();
