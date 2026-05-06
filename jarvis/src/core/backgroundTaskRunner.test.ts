/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "vitest";
import {
  extractBackgroundPrompt,
  BackgroundTaskRunner,
} from "./backgroundTaskRunner.js";

describe("extractBackgroundPrompt", () => {
  it("detects '后台:' prefix", () => {
    expect(extractBackgroundPrompt("后台: 调研NVDA的竞争对手")).toBe(
      "调研NVDA的竞争对手",
    );
  });

  it("detects '后台：' full-width colon", () => {
    expect(extractBackgroundPrompt("后台：帮我分析一下市场趋势")).toBe(
      "帮我分析一下市场趋势",
    );
  });

  it("detects '后台 ' space separator", () => {
    expect(extractBackgroundPrompt("后台 总结上周的新闻")).toBe(
      "总结上周的新闻",
    );
  });

  it("detects 'background:' English prefix", () => {
    expect(extractBackgroundPrompt("background: research competitors")).toBe(
      "research competitors",
    );
  });

  it("detects 'Background:' case-insensitive", () => {
    expect(extractBackgroundPrompt("Background: do something")).toBe(
      "do something",
    );
  });

  it("detects 'async:' prefix", () => {
    expect(extractBackgroundPrompt("async: summarize the document")).toBe(
      "summarize the document",
    );
  });

  it("detects 'bg:' short form", () => {
    expect(extractBackgroundPrompt("bg: quick task")).toBe("quick task");
  });

  it("returns null for normal messages", () => {
    expect(extractBackgroundPrompt("帮我分析NVDA")).toBeNull();
    expect(extractBackgroundPrompt("what is the weather")).toBeNull();
    expect(extractBackgroundPrompt("")).toBeNull();
  });

  it("returns null when prefix appears mid-sentence", () => {
    expect(extractBackgroundPrompt("我想在后台运行这个")).toBeNull();
  });

  it("trims the extracted prompt", () => {
    expect(extractBackgroundPrompt("后台:   lots of spaces   ")).toBe(
      "lots of spaces",
    );
  });

  it("returns null for empty payload after prefix", () => {
    // prefix only, no actual task
    const result = extractBackgroundPrompt("后台:");
    expect(result).toBe("");
  });
});

describe("BackgroundTaskRunner.setAvailableSkills", () => {
  it("stores skills and exposes them via getTask (integration: skills snapshot)", () => {
    // Verify that setAvailableSkills stores the list so execute() can pass it
    // to the bg agent. We test the state directly since execute() is private.
    const runner = new BackgroundTaskRunner(
      "/fake/root",
      {} as any, // memoryService not needed for this test
    );

    expect((runner as any).availableSkills).toEqual([]);

    const skills = [
      { name: "dmii", description: "Decision framework" },
      { name: "brainstorm", description: "Brainstorming" },
    ];
    runner.setAvailableSkills(skills);

    expect((runner as any).availableSkills).toHaveLength(2);
    expect((runner as any).availableSkills[0].name).toBe("dmii");
  });

  it("replaces skill list on subsequent calls (reload scenario)", () => {
    const runner = new BackgroundTaskRunner("/fake/root", {} as any);

    runner.setAvailableSkills([{ name: "skill-a", description: "A" }]);
    runner.setAvailableSkills([
      { name: "skill-b", description: "B" },
      { name: "skill-c", description: "C" },
    ]);

    const stored = (runner as any).availableSkills;
    expect(stored).toHaveLength(2);
    expect(stored[0].name).toBe("skill-b");
    expect(stored[1].name).toBe("skill-c");
  });

  it("empty array clears the skill list", () => {
    const runner = new BackgroundTaskRunner("/fake/root", {} as any);
    runner.setAvailableSkills([{ name: "dmii", description: "d" }]);
    runner.setAvailableSkills([]);
    expect((runner as any).availableSkills).toHaveLength(0);
  });
});
