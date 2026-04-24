/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from "vitest";
import { BackgroundDistiller } from "./backgroundDistiller.js";

describe("BackgroundDistiller", () => {
  it("uses LLM-assigned importance when provided", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "identity", "content": "user prefers dark mode", "importance": 8}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("what theme do you prefer?", "I prefer dark mode");

    expect(fakeSaveFact).toHaveBeenCalledOnce();
    expect(fakeSaveFact).toHaveBeenCalledWith(
      "identity",
      "user prefers dark mode",
      8,
    );
  });

  it("falls back to importance=5 when LLM omits importance field", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "identity", "content": "user prefers dark mode"}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("what theme do you prefer?", "I prefer dark mode");

    expect(fakeSaveFact).toHaveBeenCalledWith(
      "identity",
      "user prefers dark mode",
      5,
    );
  });

  it("clamps importance to [1, 10]", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "identity", "content": "A", "importance": 99}, {"category": "behavior", "content": "B", "importance": -5}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("hi", "hi");

    expect(fakeSaveFact).toHaveBeenCalledWith("identity", "A", 10);
    expect(fakeSaveFact).toHaveBeenCalledWith("behavior", "B", 1);
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

  it("saves preference facts with LLM-assigned importance", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "preference", "content": "user prefers table format for data", "importance": 7}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("show me the data", "here is a table...");

    expect(fakeSaveFact).toHaveBeenCalledWith(
      "preference",
      "user prefers table format for data",
      7,
    );
  });

  it("saves behavior facts with LLM-assigned importance", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(
        '{"found": true, "facts": [{"category": "behavior", "content": "user always asks for background before details", "importance": 6}]}',
      );
    const fakeSaveFact = vi.fn().mockResolvedValue(undefined);
    const distiller = new BackgroundDistiller(generateText, fakeSaveFact);

    await distiller.distill("what is X?", "X is...");

    expect(fakeSaveFact).toHaveBeenCalledWith(
      "behavior",
      "user always asks for background before details",
      6,
    );
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
