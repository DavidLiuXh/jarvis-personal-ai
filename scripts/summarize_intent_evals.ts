#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Stats = Record<string, { passed: number; total: number }>;

type MatrixReport = {
  generatedAt: string;
  casesPath: string;
  total: number;
  passed: number;
  failed: number;
  dimensionStats: Stats;
  invariantStats: Stats;
  results: Array<{
    id: string;
    dimension: string;
    invariant: string;
    passed: boolean;
    checks: Array<{
      key: string;
      pass: boolean;
      expected: unknown;
      actual: unknown;
    }>;
    error?: string;
  }>;
};

type RealModelEvalReport = {
  generatedAt: string;
  models: string[];
  casesPath: string;
  filters: {
    suite: string | null;
    tag: string | null;
    tags: string[];
    limit: number | null;
    repeat: number;
  };
  reports: Array<{
    model: string;
    total: number;
    passed: number;
    failed: number;
    avgLatencyMs: number;
    dimensionStats: Stats;
    tagStats: Stats;
    consistency?: {
      repeat: number;
      cases: number;
      stableCases: number;
      unstableCases: number;
      inconsistencyRate: number;
    };
    results: Array<{
      id: string;
      runKey: string;
      passed: boolean;
      checks: Array<{
        dimension: string;
        pass: boolean;
        expected: unknown;
        actual: unknown;
        message: string;
      }>;
      error?: string;
    }>;
  }>;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultLogsDir = path.join(repoRoot, "evals/logs");

function parseArgs(argv: string[]) {
  const args = {
    logsDir: defaultLogsDir,
    outputDir: defaultLogsDir,
    matrixJson: "",
    realModelJson: "",
    failOnFailure: false,
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
    } else if (arg === "--real-model-json" && next) {
      args.realModelJson = path.resolve(next);
      i += 1;
    } else if (arg === "--fail-on-failure") {
      args.failOnFailure = true;
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
  npx tsx scripts/summarize_intent_evals.ts [options]

Options:
  --logs-dir <path>         Eval logs directory. Default: evals/logs
  --output-dir <path>       Summary output directory. Default: evals/logs
  --matrix-json <path>      Matrix JSON report. Default: intent-matrix-latest.json
  --real-model-json <path>  Real-model JSON report. Default: latest intent-eval-*.json
  --fail-on-failure         Exit non-zero if either suite has failures
`);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function findLatestReport(logsDir: string, prefix: string): string | null {
  const candidates = fs
    .readdirSync(logsDir)
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        name.endsWith(".json") &&
        !name.includes("latest"),
    )
    .map((name) => path.join(logsDir, name))
    .sort((left, right) => {
      const leftStat = fs.statSync(left);
      const rightStat = fs.statSync(right);
      return rightStat.mtimeMs - leftStat.mtimeMs;
    });
  return candidates[0] ?? null;
}

function percent(passed: number, total: number): string {
  return total === 0 ? "0.0%" : `${((passed / total) * 100).toFixed(1)}%`;
}

function formatStats(stats: Stats, limit = 12): string {
  const rows = Object.entries(stats)
    .sort(([, left], [, right]) => {
      const leftRate = left.total === 0 ? 0 : left.passed / left.total;
      const rightRate = right.total === 0 ? 0 : right.passed / right.total;
      return leftRate - rightRate || right.total - left.total;
    })
    .slice(0, limit);
  if (rows.length === 0) return "_No stats._";
  return [
    "| Name | Pass | Rate |",
    "| --- | ---: | ---: |",
    ...rows.map(
      ([name, value]) =>
        `| ${name} | ${value.passed}/${value.total} | ${percent(value.passed, value.total)} |`,
    ),
  ].join("\n");
}

function matrixFailures(report: MatrixReport) {
  return report.results
    .filter((result) => !result.passed)
    .map((result) => ({
      id: result.id,
      detail:
        result.error ??
        result.checks
          .filter((check) => !check.pass)
          .map(
            (check) =>
              `${check.key}: expected ${JSON.stringify(check.expected)}, actual ${JSON.stringify(check.actual)}`,
          )
          .join("; "),
    }));
}

function realModelFailures(report: RealModelEvalReport) {
  return report.reports.flatMap((modelReport) =>
    modelReport.results
      .filter((result) => !result.passed)
      .map((result) => ({
        id: `${modelReport.model}:${result.runKey}`,
        detail:
          result.error ??
          result.checks
            .filter((check) => !check.pass)
            .map(
              (check) =>
                `${check.dimension}: expected ${JSON.stringify(check.expected)}, actual ${JSON.stringify(check.actual)}`,
            )
            .join("; "),
      })),
  );
}

function buildMarkdown(args: {
  matrix: MatrixReport | null;
  matrixPath: string | null;
  realModel: RealModelEvalReport | null;
  realModelPath: string | null;
}) {
  const lines: string[] = [
    "# Intent Eval Unified Report",
    "",
    `- Generated: ${new Date().toISOString()}`,
  ];

  if (args.matrix) {
    lines.push(
      `- Matrix: ${args.matrix.passed}/${args.matrix.total} (${percent(args.matrix.passed, args.matrix.total)})`,
    );
  } else {
    lines.push("- Matrix: unavailable");
  }
  if (args.realModel) {
    const total = args.realModel.reports.reduce(
      (sum, report) => sum + report.total,
      0,
    );
    const passed = args.realModel.reports.reduce(
      (sum, report) => sum + report.passed,
      0,
    );
    lines.push(`- Real model: ${passed}/${total} (${percent(passed, total)})`);
  } else {
    lines.push("- Real model: unavailable");
  }

  if (args.matrix) {
    lines.push(
      "",
      "## Matrix Regression",
      "",
      `- Source: ${args.matrixPath ? path.relative(repoRoot, args.matrixPath) : "unknown"}`,
      `- Cases file: ${path.relative(repoRoot, args.matrix.casesPath)}`,
      "",
      "### Matrix Dimensions",
      "",
      formatStats(args.matrix.dimensionStats),
      "",
      "### Matrix Invariants",
      "",
      formatStats(args.matrix.invariantStats, 30),
    );
    const failures = matrixFailures(args.matrix);
    if (failures.length > 0) {
      lines.push("", "### Matrix Failures", "");
      for (const failure of failures) {
        lines.push(`- ${failure.id}: ${failure.detail}`);
      }
    }
  }

  if (args.realModel) {
    lines.push(
      "",
      "## Real Model Eval",
      "",
      `- Source: ${args.realModelPath ? path.relative(repoRoot, args.realModelPath) : "unknown"}`,
      `- Cases file: ${path.relative(repoRoot, args.realModel.casesPath)}`,
      `- Models: ${args.realModel.models.join(", ")}`,
      `- Filters: suite=${args.realModel.filters.suite ?? "-"}, tags=${
        args.realModel.filters.tags.length > 0
          ? args.realModel.filters.tags.join(",")
          : "-"
      }, repeat=${args.realModel.filters.repeat}`,
    );
    for (const modelReport of args.realModel.reports) {
      lines.push(
        "",
        `### ${modelReport.model}`,
        "",
        `- Result: ${modelReport.passed}/${modelReport.total} (${percent(modelReport.passed, modelReport.total)})`,
        `- Avg latency: ${modelReport.avgLatencyMs}ms`,
      );
      if (modelReport.consistency && modelReport.consistency.cases > 0) {
        lines.push(
          `- Consistency: ${modelReport.consistency.stableCases}/${modelReport.consistency.cases} stable, inconsistency ${percent(
            Math.round((1 - modelReport.consistency.inconsistencyRate) * 1000),
            1000,
          )} stable-equivalent`,
        );
      }
      lines.push(
        "",
        "#### Weakest Dimensions",
        "",
        formatStats(modelReport.dimensionStats),
      );
    }
    const failures = realModelFailures(args.realModel);
    if (failures.length > 0) {
      lines.push("", "### Real Model Failures", "");
      for (const failure of failures.slice(0, 30)) {
        lines.push(`- ${failure.id}: ${failure.detail}`);
      }
    }
  }

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrixPath =
    args.matrixJson ||
    (fs.existsSync(path.join(args.logsDir, "intent-matrix-latest.json"))
      ? path.join(args.logsDir, "intent-matrix-latest.json")
      : findLatestReport(args.logsDir, "intent-matrix-"));
  const realModelPath =
    args.realModelJson || findLatestReport(args.logsDir, "intent-eval-");

  const matrix = matrixPath ? readJson<MatrixReport>(matrixPath) : null;
  const realModel = realModelPath
    ? readJson<RealModelEvalReport>(realModelPath)
    : null;

  if (!matrix && !realModel) {
    throw new Error(`No intent eval reports found in ${args.logsDir}`);
  }

  fs.mkdirSync(args.outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    generatedAt: new Date().toISOString(),
    matrixPath,
    realModelPath,
    matrix,
    realModel,
  };
  const markdown = buildMarkdown({
    matrix,
    matrixPath,
    realModel,
    realModelPath,
  });
  const jsonPath = path.join(
    args.outputDir,
    `intent-unified-${timestamp}.json`,
  );
  const mdPath = path.join(args.outputDir, `intent-unified-${timestamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");
  fs.writeFileSync(mdPath, markdown + "\n");
  fs.writeFileSync(
    path.join(args.outputDir, "intent-unified-latest.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(args.outputDir, "intent-unified-latest.md"),
    markdown + "\n",
  );

  console.log(`Unified report: ${path.relative(repoRoot, mdPath)}`);
  if (
    args.failOnFailure &&
    ((matrix?.failed ?? 0) > 0 ||
      (realModel?.reports.some((report) => report.failed > 0) ?? false))
  ) {
    process.exitCode = 1;
  }
}

main();
