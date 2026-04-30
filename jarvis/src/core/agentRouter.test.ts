/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "vitest";
import { routeToAgent } from "./agentRouter.js";
import type { AgentCard } from "./externalAgent.js";

const investmentCard: AgentCard = {
  agentId: "investment-analysis",
  name: "投资分析 Agent",
  description: "三维分析美股",
  entrypoint: "/fake/main.py",
  inputSchema: {},
  estimatedDuration: "2-4 分钟",
  triggers: [
    "分析",
    "analyze",
    "投资",
    "买入",
    "卖出",
    "持有",
    "NVDA",
    "AAPL",
    "GOOGL",
    "MSFT",
    "AMZN",
    "TSLA",
    "stock",
    "股票",
    "基本面",
    "宏观",
    "情绪",
  ],
};

const registry = [investmentCard];

describe("routeToAgent", () => {
  it("matches well-known ticker + trigger keyword", () => {
    const r = routeToAgent("帮我分析NVDA的投资价值", registry);
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect(r.agentId).toBe("investment-analysis");
    expect(r.input).toEqual({ ticker: "NVDA" });
  });

  it("matches English analyze + ticker", () => {
    const r = routeToAgent("analyze AAPL for me", registry);
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect((r.input as any).ticker).toBe("AAPL");
  });

  it("matches Chinese stock query", () => {
    const r = routeToAgent("TSLA值得买入吗", registry);
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect((r.input as any).ticker).toBe("TSLA");
  });

  it("no match when trigger present but no ticker extractable", () => {
    // "宏观分析" matches triggers but no ticker → should NOT dispatch
    const r = routeToAgent("现在宏观流动性怎么样", registry);
    expect(r.matched).toBe(false);
  });

  it("no match when empty registry", () => {
    const r = routeToAgent("分析NVDA", []);
    expect(r.matched).toBe(false);
  });

  it("no match for pure general question", () => {
    const r = routeToAgent("今天天气怎么样", registry);
    expect(r.matched).toBe(false);
  });

  it("confirmation message contains ticker and agent name", () => {
    // "分析 MSFT" hits two triggers: "分析" + "MSFT" → score=1
    const r = routeToAgent("分析MSFT的投资价值", registry);
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect(r.confirmationMessage).toContain("MSFT");
    expect(r.confirmationMessage).toContain("投资分析 Agent");
  });

  it("matches uppercase ticker in mixed-case sentence", () => {
    const r = routeToAgent("帮我看看GOOGL基本面", registry);
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect((r.input as any).ticker).toBe("GOOGL");
  });

  it("does NOT match single-trigger prompt (score < 1 = 2 hits required)", () => {
    // "analyze" alone is only 1 trigger hit → score=0.5 → no match
    const r = routeToAgent("analyze my MA thesis", registry);
    expect(r.matched).toBe(false);
  });

  it("matches prompt with 2+ trigger hits", () => {
    // "分析" + "NVDA" both in triggers → score=1 → match
    const r = routeToAgent("分析一下NVDA", registry);
    expect(r.matched).toBe(true);
  });
});
