/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "vitest";
import { extractBackgroundPrompt } from "./backgroundTaskRunner.js";

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
