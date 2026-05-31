/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QuerySubject } from "./types.js";

export type { QuerySubject } from "./types.js";

export type FactCandidate = {
  category: string;
  content: string;
};

export type SummaryCandidate = {
  text: string;
  source?: "vector" | "fallback";
};

export type PrewarmCandidate = {
  text: string;
  score: number;
  tier: "verified" | "uncertain";
};

export type MemoryInjectionRejectReason =
  | "external_query"
  | "item_limit"
  | "source_budget"
  | "total_budget"
  | "empty_text";

export type MemoryInjectionRejectedItem = {
  source: "fact" | "summary" | "prewarm";
  reason: MemoryInjectionRejectReason;
  text: string;
};

export type MemoryInjectionPlan = {
  facts: FactCandidate[];
  relevantSummarySection: string;
  prewarmSection: string;
  factsInjected: number;
  summaryInjected: number;
  prewarmInjected: number;
  usedChars: number;
  rejected: MemoryInjectionRejectedItem[];
};

export type MemoryInjectionPlannerOptions = {
  maxTotalChars?: number;
  maxFactChars?: number;
  maxSummaryChars?: number;
  maxPrewarmChars?: number;
  maxFactItemChars?: number;
  maxSummaryItemChars?: number;
  maxPrewarmItemChars?: number;
  maxFactItemsPersonal?: number;
  maxFactItemsMixed?: number;
  maxSummaryItemsPersonal?: number;
  maxSummaryItemsMixed?: number;
  maxPrewarmItemsPersonal?: number;
  maxPrewarmItemsMixed?: number;
};

const DEFAULT_OPTIONS: Required<MemoryInjectionPlannerOptions> = {
  maxTotalChars: 1800,
  maxFactChars: 900,
  maxSummaryChars: 520,
  maxPrewarmChars: 1100,
  maxFactItemChars: 220,
  maxSummaryItemChars: 180,
  maxPrewarmItemChars: 500,
  maxFactItemsPersonal: 8,
  maxFactItemsMixed: 4,
  maxSummaryItemsPersonal: 2,
  maxSummaryItemsMixed: 1,
  maxPrewarmItemsPersonal: 3,
  maxPrewarmItemsMixed: 1,
};

export class MemoryInjectionPlanner {
  private readonly options: Required<MemoryInjectionPlannerOptions>;

  constructor(options: MemoryInjectionPlannerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  buildPlan(args: {
    querySubject: QuerySubject;
    factCandidates?: FactCandidate[];
    summaryCandidates: SummaryCandidate[];
    prewarmCandidates: PrewarmCandidate[];
  }): MemoryInjectionPlan {
    const rejected: MemoryInjectionRejectedItem[] = [];
    if (args.querySubject === "external") {
      for (const item of args.factCandidates ?? []) {
        rejected.push({
          source: "fact",
          reason: "external_query",
          text: item.content,
        });
      }
      for (const item of args.summaryCandidates) {
        rejected.push({
          source: "summary",
          reason: "external_query",
          text: item.text,
        });
      }
      for (const item of args.prewarmCandidates) {
        rejected.push({
          source: "prewarm",
          reason: "external_query",
          text: item.text,
        });
      }
      return {
        facts: [],
        relevantSummarySection: "",
        prewarmSection: "",
        factsInjected: 0,
        summaryInjected: 0,
        prewarmInjected: 0,
        usedChars: 0,
        rejected,
      };
    }

    let usedChars = 0;
    const factLimit =
      args.querySubject === "mixed"
        ? this.options.maxFactItemsMixed
        : this.options.maxFactItemsPersonal;
    const summaryLimit =
      args.querySubject === "mixed"
        ? this.options.maxSummaryItemsMixed
        : this.options.maxSummaryItemsPersonal;
    const prewarmLimit =
      args.querySubject === "mixed"
        ? this.options.maxPrewarmItemsMixed
        : this.options.maxPrewarmItemsPersonal;

    const selectedFacts = this.selectItems({
      source: "fact",
      candidates: (args.factCandidates ?? []).map((item) => ({
        category: item.category,
        content: compactText(item.content, this.options.maxFactItemChars),
        text: compactText(item.content, this.options.maxFactItemChars),
      })),
      itemLimit: factLimit,
      sourceBudget: this.options.maxFactChars,
      getUsedChars: () => usedChars,
      addUsedChars: (chars) => {
        usedChars += chars;
      },
      rejected,
    }).map(({ category, content }) => ({ category, content }));

    const selectedSummary = this.selectItems({
      source: "summary",
      candidates: args.summaryCandidates.map((item) => ({
        text: compactText(item.text, this.options.maxSummaryItemChars),
      })),
      itemLimit: summaryLimit,
      sourceBudget: this.options.maxSummaryChars,
      getUsedChars: () => usedChars,
      addUsedChars: (chars) => {
        usedChars += chars;
      },
      rejected,
    });

    const selectedPrewarm = this.selectItems({
      source: "prewarm",
      candidates: args.prewarmCandidates.map((item) => ({
        ...item,
        text: compactText(item.text, this.options.maxPrewarmItemChars),
      })),
      itemLimit: prewarmLimit,
      sourceBudget: this.options.maxPrewarmChars,
      getUsedChars: () => usedChars,
      addUsedChars: (chars) => {
        usedChars += chars;
      },
      rejected,
    }) as PrewarmCandidate[];

    return {
      facts: selectedFacts,
      relevantSummarySection: buildSummarySectionFromChunks(
        selectedSummary.map((item) => item.text),
      ),
      prewarmSection: buildPrewarmSection(selectedPrewarm),
      factsInjected: selectedFacts.length,
      summaryInjected: selectedSummary.length,
      prewarmInjected: selectedPrewarm.length,
      usedChars,
      rejected,
    };
  }

  private selectItems<T extends { text: string }>(args: {
    source: "fact" | "summary" | "prewarm";
    candidates: T[];
    itemLimit: number;
    sourceBudget: number;
    getUsedChars: () => number;
    addUsedChars: (chars: number) => void;
    rejected: MemoryInjectionRejectedItem[];
  }): T[] {
    const selected: T[] = [];
    let sourceChars = 0;

    for (const candidate of args.candidates) {
      const text = candidate.text.trim();
      if (!text) {
        args.rejected.push({
          source: args.source,
          reason: "empty_text",
          text: candidate.text,
        });
        continue;
      }
      if (selected.length >= args.itemLimit) {
        args.rejected.push({
          source: args.source,
          reason: "item_limit",
          text,
        });
        continue;
      }
      if (sourceChars + text.length > args.sourceBudget) {
        args.rejected.push({
          source: args.source,
          reason: "source_budget",
          text,
        });
        continue;
      }
      if (args.getUsedChars() + text.length > this.options.maxTotalChars) {
        args.rejected.push({
          source: args.source,
          reason: "total_budget",
          text,
        });
        continue;
      }

      selected.push({ ...candidate, text });
      sourceChars += text.length;
      args.addUsedChars(text.length);
    }

    return selected;
  }
}

function compactText(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const firstSentence =
    cleaned.split(/(?<=[。！？.!?；;])/u)[0]?.trim() ?? cleaned;
  const compacted = firstSentence || cleaned;
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, maxChars).trimEnd()}…`;
}

function buildSummarySectionFromChunks(chunks: string[]): string {
  if (chunks.length === 0) return "";

  const compactSnippet = (text: string, maxLen = 300): string => {
    const cleaned = text.replace(/\s+/g, " ").trim();
    const firstSentence =
      cleaned.split(/(?<=[。！？.!?；;])/u)[0]?.trim() ?? cleaned;
    if (firstSentence.length <= maxLen) return firstSentence;
    return `${firstSentence.slice(0, maxLen).trimEnd()}…`;
  };

  return (
    "\n<relevant_session_summary>\n" +
    chunks.map((item) => `- ${compactSnippet(item)}`).join("\n") +
    "\n</relevant_session_summary>"
  );
}

function buildPrewarmSection(candidates: PrewarmCandidate[]): string {
  if (candidates.length === 0) return "";

  const verified = candidates.filter((item) => item.tier === "verified");
  const uncertain = candidates.filter((item) => item.tier === "uncertain");
  let memoryIndex = 1;
  let memoryContent = "";

  if (verified.length > 0) {
    memoryContent +=
      "<verified_memories>\n" +
      verified.map((m) => `[Memory ${memoryIndex++}]: ${m.text}`).join("\n") +
      "\n</verified_memories>";
  }

  if (uncertain.length > 0) {
    memoryContent +=
      (memoryContent ? "\n" : "") +
      "<possibly_relevant_memories>\n" +
      "(Low confidence — treat as hints only, not facts. Use only if directly matching the question.)\n" +
      uncertain.map((m) => `[Memory ${memoryIndex++}]: ${m.text}`).join("\n") +
      "\n</possibly_relevant_memories>";
  }

  return (
    "\n<relevant_past_conversations>\n" +
    memoryContent +
    "\n</relevant_past_conversations>"
  );
}
