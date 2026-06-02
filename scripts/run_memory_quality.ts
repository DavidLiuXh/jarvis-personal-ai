/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DefaultMemoryRetriever,
  DefaultMemoryStore,
  DefaultMemoryWriterRuntime,
  MemoryInjectionPlanner,
  type FactMemory,
  type MemoryContract,
} from "@jarvis/memory-runtime";

type MemoryQualityCaseResult = {
  id: string;
  passed: boolean;
  details: Record<string, unknown>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const logsDir = path.join(repoRoot, "evals", "logs");

function fact(overrides: Partial<FactMemory> = {}): FactMemory {
  const now = "2026-06-02T00:00:00.000Z";
  return {
    id: overrides.id ?? "fact-1",
    scope: "fact",
    subject: overrides.subject ?? "profile",
    content: overrides.content ?? "The user prefers concise Chinese replies.",
    confidence: overrides.confidence ?? 0.8,
    sourceRefs: overrides.sourceRefs ?? ["quality"],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    metadata: overrides.metadata,
  };
}

function memoryContract(query: string): MemoryContract {
  return {
    needMemory: true,
    subjectBoundary: "personal",
    targetScopes: ["fact", "entry"],
    memoryTarget: "user_memory",
    query: { raw: query, entities: ["preference"] },
    confidence: { subject: 1, target: 1, query: 1 },
    constraints: {
      allowPersonalFacts: true,
      allowSessionHistory: false,
      allowEntries: true,
      maxChars: 1200,
    },
    reasons: ["memory_quality"],
    policyTrace: [],
  };
}

async function runDuplicateGovernanceCase(): Promise<MemoryQualityCaseResult> {
  const store = new DefaultMemoryStore({
    facts: [fact({ id: "existing", confidence: 0.6, sourceRefs: ["old"] })],
  });
  const writer = new DefaultMemoryWriterRuntime({ store });
  const [result] = await writer.write([
    {
      operation: "upsert",
      item: fact({ id: "incoming", confidence: 0.95, sourceRefs: ["new"] }),
    },
  ]);
  const facts = await store.listFacts();
  return {
    id: "duplicate_fact_governance",
    passed:
      result.decision.action === "merge" &&
      facts.length === 1 &&
      facts[0].confidence === 0.95 &&
      facts[0].sourceRefs.includes("old") &&
      facts[0].sourceRefs.includes("new"),
    details: {
      action: result.decision.action,
      reasonCode: result.decision.reasonCode,
      factCount: facts.length,
      confidence: facts[0]?.confidence,
      sourceRefs: facts[0]?.sourceRefs,
    },
  };
}

async function runConflictGovernanceCase(): Promise<MemoryQualityCaseResult> {
  const store = new DefaultMemoryStore({
    facts: [
      fact({
        id: "profile",
        content: "The user prefers detailed explanations.",
        confidence: 0.96,
      }),
    ],
  });
  const writer = new DefaultMemoryWriterRuntime({ store });
  const [result] = await writer.write([
    {
      operation: "upsert",
      item: fact({
        id: "conflict",
        content: "The user prefers one-word answers.",
        confidence: 0.4,
      }),
    },
  ]);
  return {
    id: "low_confidence_conflict_skip",
    passed: result.decision.action === "skip" && result.written === null,
    details: {
      action: result.decision.action,
      reasonCode: result.decision.reasonCode,
      confidenceDelta: result.decision.confidenceDelta,
    },
  };
}

async function runRetrieveInjectCase(): Promise<MemoryQualityCaseResult> {
  const store = new DefaultMemoryStore({
    facts: [
      fact({
        id: "preference",
        content: "The user prefers concise Chinese replies.",
        confidence: 0.95,
      }),
    ],
  });
  const retriever = new DefaultMemoryRetriever({
    stores: { facts: store, entries: store },
  });
  const retrieval = await retriever.retrieve(memoryContract("concise Chinese"));
  const plan = new MemoryInjectionPlanner().buildPlan({
    querySubject: "personal",
    factCandidates: retrieval.facts.map((item) => ({
      category: item.item.subject,
      content: item.item.content,
    })),
    summaryCandidates: [],
    prewarmCandidates: [],
  });
  return {
    id: "retrieve_then_inject",
    passed:
      retrieval.facts.length === 1 &&
      plan.factsInjected === 1 &&
      plan.facts[0]?.content.includes("concise Chinese"),
    details: {
      retrievedFacts: retrieval.facts.length,
      factsInjected: plan.factsInjected,
      rejected: plan.rejected.length,
    },
  };
}

async function runExternalBoundaryCase(): Promise<MemoryQualityCaseResult> {
  const store = new DefaultMemoryStore({
    facts: [fact({ id: "private" })],
  });
  const retriever = new DefaultMemoryRetriever({ stores: { facts: store } });
  const contract = {
    ...memoryContract("private preference"),
    subjectBoundary: "external" as const,
  };
  const retrieval = await retriever.retrieve(contract);
  return {
    id: "external_memory_boundary",
    passed:
      retrieval.facts.length === 0 &&
      retrieval.entries.length === 0 &&
      retrieval.session.length === 0,
    details: {
      facts: retrieval.facts.length,
      entries: retrieval.entries.length,
      session: retrieval.session.length,
    },
  };
}

const results = [
  await runDuplicateGovernanceCase(),
  await runConflictGovernanceCase(),
  await runRetrieveInjectCase(),
  await runExternalBoundaryCase(),
];
const passed = results.filter((result) => result.passed).length;
const report = {
  generatedAt: new Date().toISOString(),
  passed,
  total: results.length,
  results,
};

await mkdir(logsDir, { recursive: true });
await writeFile(
  path.join(logsDir, "memory-quality-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
await writeFile(
  path.join(logsDir, "memory-quality-latest.md"),
  [
    "# Memory Quality Report",
    "",
    `Result: ${passed}/${results.length} passed`,
    "",
    ...results.map(
      (result) =>
        `- ${result.passed ? "PASS" : "FAIL"} ${result.id}: \`${JSON.stringify(
          result.details,
        )}\``,
    ),
    "",
  ].join("\n"),
);

for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id}`);
}
console.log(`Result: ${passed}/${results.length} passed`);

if (passed !== results.length) process.exit(1);
