#!/usr/bin/env tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Candidate = {
  id: string;
  source?: string;
  generatedAt?: string;
  signals?: string[];
  prompt?: string;
  history?: Array<{ role: string; content: string }>;
  observed?: Record<string, unknown>;
  candidateCase?: {
    id?: string;
    prompt?: string;
    history?: Array<{ role: string; content: string }>;
    expect?: Record<string, unknown>;
    tags?: string[];
  };
};

type ReviewDecision = {
  candidateId: string;
  decision: "accept" | "reject" | "merge" | "pending";
  caseId?: string;
  dimension?: string;
  invariant?: string;
  principle?: string;
  rootCause?: string;
  mergeInto?: string;
  expect?: Record<string, unknown>;
  model?: Record<string, unknown>;
  tags?: string[];
  notes?: string;
};

type PromotedCase = {
  id: string;
  dimension: string;
  invariant: string;
  principles: string[];
  axes: Record<string, string>;
  prompt: string;
  history?: Array<{ role: string; content: string }>;
  model?: Record<string, unknown>;
  expect: Record<string, unknown>;
  tags: string[];
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultInput = path.join(
  os.homedir(),
  ".gemini-jarvis",
  "intent-feedback",
  "runtime-intent-candidates-latest.jsonl",
);
const defaultOutput = path.join(
  repoRoot,
  "evals/intent/reviewed-runtime-cases.jsonl",
);

function parseArgs(argv: string[]) {
  const args = {
    input: defaultInput,
    decisions: "",
    output: defaultOutput,
    template: "",
    promote: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--input" && next) {
      args.input = path.resolve(next);
      i += 1;
    } else if (arg === "--decisions" && next) {
      args.decisions = path.resolve(next);
      i += 1;
    } else if (arg === "--output" && next) {
      args.output = path.resolve(next);
      i += 1;
    } else if (arg === "--template" && next) {
      args.template = path.resolve(next);
      i += 1;
    } else if (arg === "--promote") {
      args.promote = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!args.template && !args.promote) {
    args.template = path.join(
      repoRoot,
      "evals/intent/candidates/intent-feedback-review-template.jsonl",
    );
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  npx tsx scripts/review_intent_feedback.ts [options]

Options:
  --input <path>       Runtime feedback candidates JSONL
  --template <path>    Write a review template JSONL
  --decisions <path>   Reviewed decisions JSONL
  --promote            Promote accepted decisions to reviewed eval cases
  --output <path>      Output promoted cases JSONL
`);
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error: any) {
        throw new Error(
          `Failed to parse ${filePath}:${index + 1}: ${error.message}`,
        );
      }
    });
}

function writeJsonl<T>(filePath: string, rows: T[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") +
      (rows.length > 0 ? "\n" : ""),
  );
}

function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}

function inferDimension(signals: string[]): string {
  if (signals.some((signal) => signal.includes("clarification"))) {
    return "clarification";
  }
  if (signals.some((signal) => signal.includes("memory"))) {
    return "memoryPolicy";
  }
  if (signals.some((signal) => signal.includes("routing"))) {
    return "agentRouting";
  }
  return "actionBoundary";
}

function inferInvariant(signals: string[]): string {
  const first = signals[0] ?? "runtime_observation";
  return `RUNTIME_${first.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function buildTemplateRow(candidate: Candidate): ReviewDecision & {
  suggestedCase: PromotedCase;
} {
  const signals = candidate.signals ?? [];
  const dimension = inferDimension(signals);
  const invariant = inferInvariant(signals);
  const caseId = sanitizeId(
    `reviewed.${dimension}.${candidate.id || candidate.candidateCase?.id || "candidate"}`,
  );
  return {
    candidateId: candidate.id,
    decision: "pending",
    caseId,
    dimension,
    invariant,
    rootCause: signals.join(",") || "capture_all",
    expect: candidate.candidateCase?.expect ?? {},
    tags: [
      "runtime-reviewed",
      "needs-human-review",
      ...(candidate.candidateCase?.tags ?? []),
    ],
    notes:
      "Set decision=accept and fill expect/model when this should become a stable eval case.",
    suggestedCase: buildPromotedCase(candidate, {
      candidateId: candidate.id,
      decision: "pending",
      caseId,
      dimension,
      invariant,
      rootCause: signals.join(",") || "capture_all",
      expect: candidate.candidateCase?.expect ?? {},
      tags: ["runtime-reviewed", ...(candidate.candidateCase?.tags ?? [])],
    }),
  };
}

function buildPromotedCase(
  candidate: Candidate,
  decision: ReviewDecision,
): PromotedCase {
  const signals = candidate.signals ?? [];
  const rootCause = decision.rootCause || signals.join(",") || "unknown";
  const caseId =
    decision.caseId ??
    sanitizeId(
      `reviewed.${decision.dimension ?? inferDimension(signals)}.${candidate.id}`,
    );
  return {
    id: caseId,
    dimension: decision.dimension ?? inferDimension(signals),
    invariant: decision.invariant ?? inferInvariant(signals),
    principles: [
      decision.principle ??
        `Runtime feedback candidate promoted after human review: ${rootCause}`,
    ],
    axes: {
      source: candidate.source ?? "runtime_feedback",
      rootCause,
      generatedAt: candidate.generatedAt ?? "",
    },
    prompt: candidate.candidateCase?.prompt ?? candidate.prompt ?? "",
    history: candidate.candidateCase?.history ?? candidate.history ?? [],
    model: decision.model,
    expect: decision.expect ?? candidate.candidateCase?.expect ?? {},
    tags: [
      "runtime-reviewed",
      `root:${sanitizeId(rootCause)}`,
      ...(candidate.candidateCase?.tags ?? []),
      ...(decision.tags ?? []),
    ],
  };
}

function promote(candidates: Candidate[], decisions: ReviewDecision[]) {
  const candidatesById = new Map(candidates.map((item) => [item.id, item]));
  const promoted: PromotedCase[] = [];
  const rejected: ReviewDecision[] = [];
  const merged: ReviewDecision[] = [];

  for (const decision of decisions) {
    if (decision.decision === "reject") {
      rejected.push(decision);
      continue;
    }
    if (decision.decision === "merge") {
      merged.push(decision);
      continue;
    }
    if (decision.decision !== "accept") continue;
    const candidate = candidatesById.get(decision.candidateId);
    if (!candidate) {
      throw new Error(
        `Decision references missing candidate: ${decision.candidateId}`,
      );
    }
    promoted.push(buildPromotedCase(candidate, decision));
  }

  return { promoted, rejected, merged };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = readJsonl<Candidate>(args.input);
  if (candidates.length === 0) {
    console.log(`No candidates found: ${args.input}`);
    return;
  }

  if (args.template) {
    const rows = candidates.map(buildTemplateRow);
    writeJsonl(args.template, rows);
    console.log(
      `Wrote review template: ${args.template} (${rows.length} rows)`,
    );
  }

  if (args.promote) {
    if (!args.decisions) {
      throw new Error("--promote requires --decisions");
    }
    const decisions = readJsonl<ReviewDecision>(args.decisions);
    const { promoted, rejected, merged } = promote(candidates, decisions);
    writeJsonl(args.output, promoted);
    console.log(
      `Promoted ${promoted.length} case(s) to ${args.output}; rejected=${rejected.length}; merged=${merged.length}`,
    );
  }
}

main();
