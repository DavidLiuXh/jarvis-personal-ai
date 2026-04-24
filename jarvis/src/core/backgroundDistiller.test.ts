/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from "vitest";
import {
  BackgroundDistiller,
  getCategoryBaseScore,
  computeExplicitnessScore,
  computeFactImportance,
} from "./backgroundDistiller.js";

// ---------------------------------------------------------------------------
// Unit tests for multi-factor importance helpers
// ---------------------------------------------------------------------------

describe("getCategoryBaseScore", () => {
  it("returns correct base scores for all known categories", () => {
    expect(getCategoryBaseScore("identity")).toBe(9);
    expect(getCategoryBaseScore("specification")).toBe(8);
    expect(getCategoryBaseScore("preference")).toBe(7);
    expect(getCategoryBaseScore("behavior")).toBe(6);
  });

  it("returns 5 for unknown categories", () => {
    expect(getCategoryBaseScore("insight")).toBe(5);
    expect(getCategoryBaseScore("unknown")).toBe(5);
  });
});

describe("computeExplicitnessScore", () => {
  it("returns 3 for weak/uncertain expressions", () => {
    expect(computeExplicitnessScore("可能我更喜欢中文")).toBe(3);
    expect(computeExplicitnessScore("maybe I prefer tables")).toBe(3);
    expect(computeExplicitnessScore("暂时用这个方案")).toBe(3);
  });

  it("returns 9 for persistent intent expressions", () => {
    expect(computeExplicitnessScore("以后都用中文回答")).toBe(9);
    expect(computeExplicitnessScore("from now on always use tables")).toBe(9);
    expect(computeExplicitnessScore("每次都先给结论")).toBe(9);
  });

  it("returns 8 for identity assertions when category=identity", () => {
    expect(
      computeExplicitnessScore("我是一名软件工程师", undefined, "identity"),
    ).toBe(8);
    expect(
      computeExplicitnessScore("I am a data scientist", undefined, "identity"),
    ).toBe(8);
  });

  it("returns 7 for explicit preference statements", () => {
    expect(computeExplicitnessScore("I prefer concise answers")).toBe(7);
    expect(computeExplicitnessScore("我喜欢直接给结论")).toBe(7);
  });

  it("returns 6 for strong behavior evidence", () => {
    expect(computeExplicitnessScore("我经常先看整体架构")).toBe(6);
    expect(computeExplicitnessScore("I often start with the big picture")).toBe(
      6,
    );
  });

  it("returns 5 as default for neutral statements", () => {
    expect(computeExplicitnessScore("用TypeScript写的")).toBe(5);
    expect(computeExplicitnessScore("this project uses React")).toBe(5);
  });

  it("weak patterns override stronger patterns", () => {
    // "可能" should win over "我喜欢"
    expect(computeExplicitnessScore("我可能喜欢中文")).toBe(3);
  });

  it("uses factContent as auxiliary signal", () => {
    // userPrompt is neutral but factContent contains persistent intent
    expect(
      computeExplicitnessScore(
        "ok",
        "user always prefers Chinese",
        "preference",
      ),
    ).toBe(9);
  });
});

describe("computeFactImportance", () => {
  it("produces higher importance for identity facts with explicit assertion", () => {
    const imp = computeFactImportance({
      category: "identity",
      userPrompt: "我是一名软件工程师",
      factContent: "user is a software engineer",
      llmScore: 8,
    });
    // cat=9*0.35 + explicit=8*0.25 + llm=8*0.4 = 3.15+2.0+3.2 = 8.35 → 8
    expect(imp).toBe(8);
  });

  it("produces lower importance for weak behavior inference", () => {
    const imp = computeFactImportance({
      category: "behavior",
      userPrompt: "可能我有时跑步",
      factContent: "user occasionally runs",
      llmScore: 4,
    });
    // cat=6*0.35 + explicit=3*0.25 + llm=4*0.4 = 2.1+0.75+1.6 = 4.45 → 4
    expect(imp).toBe(4);
  });

  it("clamps result to [1, 10]", () => {
    const high = computeFactImportance({
      category: "identity",
      userPrompt: "以后都这样",
      factContent: "user is named David",
      llmScore: 10,
    });
    expect(high).toBeLessThanOrEqual(10);
    expect(high).toBeGreaterThanOrEqual(1);
  });

  it("falls back to llmScore=5 when LLM omits importance", () => {
    const imp = computeFactImportance({
      category: "preference",
      userPrompt: "I prefer tables",
      factContent: "user prefers table format",
      llmScore: undefined,
    });
    // cat=7*0.35 + explicit=7*0.25 + llm=5*0.4 = 2.45+1.75+2.0 = 6.2 → 6
    expect(imp).toBe(6);
  });
});

describe("BackgroundDistiller", () => {
  it("uses multi-factor formula — importance is not just LLM score", async () => {
    // LLM returns importance=8 for an identity fact from a neutral prompt.
    // Formula: cat=9*0.35 + explicit=5*0.25 + llm=8*0.4 = 3.15+1.25+3.2 = 7.6 → 8
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "identity", "content": "user prefers dark mode", "importance": 8}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("what theme do you prefer?", "I prefer dark mode");

    expect(fakeSaveFact).toHaveBeenCalledOnce();
    const [cat, content, imp] = fakeSaveFact.mock.calls[0];
    expect(cat).toBe("identity");
    expect(content).toBe("user prefers dark mode");
    // importance is formula-computed, must be in [1,10]
    expect(imp).toBeGreaterThanOrEqual(1);
    expect(imp).toBeLessThanOrEqual(10);
  });

  it("persistent intent raises importance above neutral LLM score", async () => {
    // "以后都" triggers explicitness=9
    // cat=7*0.35 + explicit=9*0.25 + llm=5*0.4 = 2.45+2.25+2.0 = 6.7 → 7
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "preference", "content": "user prefers Chinese", "importance": 5}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("以后都用中文回答我", "好的");

    const [, , imp] = fakeSaveFact.mock.calls[0];
    // With persistent intent, importance should be higher than the LLM's 5
    expect(imp).toBeGreaterThan(5);
  });

  it("weak expression lowers importance below neutral LLM score", async () => {
    // "可能" triggers explicitness=3
    // cat=6*0.35 + explicit=3*0.25 + llm=7*0.4 = 2.1+0.75+2.8 = 5.65 → 6
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "behavior", "content": "user maybe likes cycling", "importance": 7}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("可能我有时喜欢骑车", "好的");

    const [, , imp] = fakeSaveFact.mock.calls[0];
    // With weak expression, importance should be lower than the LLM's 7
    expect(imp).toBeLessThan(7);
  });

  it("falls back gracefully when LLM omits importance field", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "identity", "content": "user prefers dark mode"}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("what theme do you prefer?", "I prefer dark mode");

    const [, , imp] = fakeSaveFact.mock.calls[0];
    // llmScore defaults to 5; result must still be in [1,10]
    expect(imp).toBeGreaterThanOrEqual(1);
    expect(imp).toBeLessThanOrEqual(10);
  });

  it("importance is always clamped to [1, 10]", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "identity", "content": "A", "importance": 99}, {"category": "behavior", "content": "B", "importance": -5}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("hi", "hi");

    for (const call of fakeSaveFact.mock.calls) {
      expect(call[2]).toBeGreaterThanOrEqual(1);
      expect(call[2]).toBeLessThanOrEqual(10);
    }
  });

  it("calls no saveFact when LLM reports found: false", async () => {
    const generateText = vi.fn().mockResolvedValue('{"found": false}');
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("hello", "hello back");

    expect(fakeSaveFact).not.toHaveBeenCalled();
  });

  it("prompt includes importance scoring rubric", async () => {
    const generateText = vi.fn().mockResolvedValue('{"found": false}');
    const fakeSaveFact = vi.fn();
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("show me data", "here is a table");

    const calledPrompt = generateText.mock.calls[0][0] as string;
    // Prompt must include importance scoring guidance
    expect(calledPrompt).toContain("importance");
    expect(calledPrompt).toMatch(/9.?10|10/); // top tier mentioned
    // Output format must include importance field
    expect(calledPrompt).toContain('"importance"');
  });

  it("distill prompt includes all four categories, dedup rule, and preference clarification", async () => {
    const generateText = vi.fn().mockResolvedValue('{"found": false}');
    const fakeSaveFact = vi.fn();
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("show me data", "here is a table");

    const calledPrompt = generateText.mock.calls[0][0] as string;
    expect(calledPrompt).toContain("identity");
    expect(calledPrompt).toContain("behavior");
    expect(calledPrompt).toContain("preference");
    expect(calledPrompt).toContain("specification");
    expect(calledPrompt).toContain("exactly ONE category");
    expect(calledPrompt).toContain("FORMAT or STYLE");
    expect(calledPrompt.toLowerCase()).toMatch(/persistent|long.term/);
    expect(calledPrompt.toLowerCase()).toMatch(/one.time|temporary|test/);
  });

  it("saves preference facts with formula-computed importance", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "preference", "content": "user prefers table format for data", "importance": 7}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("show me the data", "here is a table...");

    expect(fakeSaveFact).toHaveBeenCalledOnce();
    const [cat, , imp] = fakeSaveFact.mock.calls[0];
    expect(cat).toBe("preference");
    expect(imp).toBeGreaterThanOrEqual(1);
    expect(imp).toBeLessThanOrEqual(10);
  });

  it("saves behavior facts with formula-computed importance", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "behavior", "content": "user always asks for background before details", "importance": 6}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("what is X?", "X is...");

    expect(fakeSaveFact).toHaveBeenCalledOnce();
    const [cat, , imp] = fakeSaveFact.mock.calls[0];
    expect(cat).toBe("behavior");
    expect(imp).toBeGreaterThanOrEqual(1);
    expect(imp).toBeLessThanOrEqual(10);
  });

  it("does not throw when LLM returns malformed JSON", async () => {
    const generateText = vi.fn().mockResolvedValue("not json at all");
    const fakeSaveFact = vi.fn();
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await expect(distiller.distill("hi", "hi")).resolves.not.toThrow();
    expect(fakeSaveFact).not.toHaveBeenCalled();
  });

  it("does not throw when generateText rejects, and logs the error", async () => {
    const apiError = Object.assign(
      new Error("models/gemini-1.5-flash is not found"),
      { status: 404 },
    );
    const generateText = vi.fn().mockRejectedValue(apiError);
    const fakeSaveFact = vi.fn();
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(distiller.distill("hi", "hi")).resolves.not.toThrow();
    expect(fakeSaveFact).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[BackgroundDistiller] distill failed:"),
      apiError,
    );

    consoleSpy.mockRestore();
  });

  it("prompt instructs to extract only from user input, not from assistant output", async () => {
    const generateText = vi.fn().mockResolvedValue('{"found": false}');
    const fakeSaveFact = vi.fn();
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill(
      "what are my hobbies?",
      "Your hobbies are: history, running, cooking.",
    );

    const calledPrompt = generateText.mock.calls[0][0] as string;
    expect(calledPrompt.toLowerCase()).toContain("user input");
    expect(calledPrompt).toContain("NOT from");
  });

  it("prompt classifies hobbies and interests as behavior, not identity", async () => {
    const generateText = vi.fn().mockResolvedValue('{"found": false}');
    const fakeSaveFact = vi.fn();
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("I like cycling", "Great hobby!");

    const calledPrompt = generateText.mock.calls[0][0] as string;
    const lines = calledPrompt.split("\n");
    const behaviorLine =
      lines.find((l) => l.trim().startsWith("- behavior:")) ?? "";
    const identityLine =
      lines.find((l) => l.trim().startsWith("- identity:")) ?? "";
    expect(behaviorLine.toLowerCase()).toContain("hobbies");
    expect(identityLine.toLowerCase()).not.toContain("hobbies");
    expect(calledPrompt).toContain("behavior, NOT identity");
  });
});
