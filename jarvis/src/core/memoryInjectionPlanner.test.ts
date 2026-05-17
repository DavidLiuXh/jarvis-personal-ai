/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { MemoryInjectionPlanner } from "./memoryInjectionPlanner.js";

describe("MemoryInjectionPlanner", () => {
  it("skips all memory candidates for external queries", () => {
    const planner = new MemoryInjectionPlanner();

    const plan = planner.buildPlan({
      querySubject: "external",
      summaryCandidates: [{ text: "Project: user works on Jarvis memory." }],
      prewarmCandidates: [
        { text: "Past Jarvis memory discussion", score: 0.9, tier: "verified" },
      ],
    });

    expect(plan.relevantSummarySection).toBe("");
    expect(plan.prewarmSection).toBe("");
    expect(plan.summaryInjected).toBe(0);
    expect(plan.prewarmInjected).toBe(0);
    expect(plan.rejected.map((item) => item.reason)).toEqual([
      "external_query",
      "external_query",
    ]);
  });

  it("uses conservative mixed-query limits", () => {
    const planner = new MemoryInjectionPlanner();

    const plan = planner.buildPlan({
      querySubject: "mixed",
      factCandidates: [
        { category: "identity", content: "user works on Jarvis" },
        { category: "specification", content: "Jarvis uses TypeScript" },
        { category: "behavior", content: "user frequently tunes memory" },
        { category: "interaction_style", content: "user prefers concise logs" },
        { category: "specification", content: "extra mixed fact is too much" },
      ],
      summaryCandidates: [
        { text: "Jarvis: first related summary." },
        { text: "Jarvis: second related summary." },
      ],
      prewarmCandidates: [
        { text: "first memory", score: 0.92, tier: "verified" },
        { text: "second memory", score: 0.86, tier: "verified" },
      ],
    });

    expect(plan.factsInjected).toBe(4);
    expect(plan.summaryInjected).toBe(1);
    expect(plan.prewarmInjected).toBe(1);
    expect(plan.facts.map((fact) => fact.content)).not.toContain(
      "extra mixed fact is too much",
    );
    expect(plan.relevantSummarySection).toContain("first related summary");
    expect(plan.relevantSummarySection).not.toContain("second related summary");
    expect(plan.prewarmSection).toContain("first memory");
    expect(plan.prewarmSection).not.toContain("second memory");
    expect(plan.rejected.some((item) => item.reason === "item_limit")).toBe(
      true,
    );
  });

  it("renders verified and uncertain prewarm memories into separate tiers", () => {
    const planner = new MemoryInjectionPlanner();

    const plan = planner.buildPlan({
      querySubject: "personal",
      summaryCandidates: [],
      prewarmCandidates: [
        { text: "verified memory", score: 0.91, tier: "verified" },
        { text: "uncertain memory", score: 0.62, tier: "uncertain" },
      ],
    });

    expect(plan.prewarmInjected).toBe(2);
    expect(plan.prewarmSection).toContain("<verified_memories>");
    expect(plan.prewarmSection).toContain("[Memory 1]: verified memory");
    expect(plan.prewarmSection).toContain("<possibly_relevant_memories>");
    expect(plan.prewarmSection).toContain("[Memory 2]: uncertain memory");
  });

  it("compacts long summary chunks before rendering", () => {
    const planner = new MemoryInjectionPlanner({ maxSummaryItemChars: 40 });
    const longChunk =
      "Jarvis memory injection should keep only the first compact sentence without flooding the prompt with implementation details that are not needed.";

    const plan = planner.buildPlan({
      querySubject: "personal",
      summaryCandidates: [{ text: longChunk }],
      prewarmCandidates: [],
    });

    expect(plan.summaryInjected).toBe(1);
    expect(plan.relevantSummarySection).toContain(
      "Jarvis memory injection should keep only…",
    );
    expect(plan.relevantSummarySection).not.toContain(
      "implementation details that are not needed",
    );
  });

  it("rejects candidates that exceed source budgets after compaction", () => {
    const planner = new MemoryInjectionPlanner({
      maxSummaryItemChars: 100,
      maxSummaryChars: 20,
    });

    const plan = planner.buildPlan({
      querySubject: "personal",
      summaryCandidates: [
        { text: "This related summary is longer than the source budget." },
      ],
      prewarmCandidates: [],
    });

    expect(plan.summaryInjected).toBe(0);
    expect(plan.relevantSummarySection).toBe("");
    expect(plan.rejected[0]?.reason).toBe("source_budget");
  });

  it("compacts and budgets injected facts", () => {
    const planner = new MemoryInjectionPlanner({
      maxFactItemChars: 30,
      maxFactChars: 100,
      maxFactItemsPersonal: 3,
    });

    const plan = planner.buildPlan({
      querySubject: "personal",
      factCandidates: [
        {
          category: "specification",
          content:
            "Jarvis memory injection should keep fact content compact before it enters the system prompt.",
        },
        { category: "identity", content: "user is a software engineer" },
        { category: "behavior", content: "user reviews logs carefully" },
        { category: "specification", content: "this fourth fact is over cap" },
      ],
      summaryCandidates: [],
      prewarmCandidates: [],
    });

    expect(plan.factsInjected).toBe(3);
    expect(plan.facts[0]).toEqual({
      category: "specification",
      content: "Jarvis memory injection should…",
    });
    expect(plan.rejected.some((item) => item.reason === "item_limit")).toBe(
      true,
    );
  });
});
