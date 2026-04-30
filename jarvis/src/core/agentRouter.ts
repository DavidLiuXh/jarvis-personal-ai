/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentCard } from "./externalAgent.js";

/**
 * Result of a routing decision.
 * matched=false  → let Jarvis handle this normally via LLM
 * matched=true   → dispatch to the named agent with extracted input
 */
export type AgentRouteResult =
  | { matched: false }
  | {
      matched: true;
      agentId: string;
      agentName: string;
      input: Record<string, unknown>;
      /** Confirmation message to show the user immediately */
      confirmationMessage: string;
    };

// ── Ticker extraction ─────────────────────────────────────────────────────────

/**
 * Common US stock tickers to recognize. Only include tickers ≥3 chars
 * that are unambiguous as standalone words. Single/two-char tickers like
 * V (Visa), MA (Mastercard), LI (Li Auto), JD are excluded — they match
 * too broadly ("MA thesis", "V neck", "LI is my friend", "JD is here").
 */
const WELL_KNOWN_TICKERS = new Set([
  "NVDA",
  "AAPL",
  "MSFT",
  "GOOGL",
  "GOOG",
  "AMZN",
  "META",
  "TSLA",
  "BRK",
  "JPM",
  "UNH",
  "XOM",
  "JNJ",
  "WMT",
  "PG",
  "HD",
  "CVX",
  "MRK",
  "ABBV",
  "PEP",
  "LLY",
  "AVGO",
  "COST",
  "AMD",
  "INTC",
  "QCOM",
  "AMAT",
  "ASML",
  "TSM",
  "NFLX",
  "DIS",
  "UBER",
  "LYFT",
  "SNOW",
  "CRM",
  "NOW",
  "PLTR",
  "COIN",
  "BABA",
  "PDD",
  "NIO",
  "XPEV",
  "BTC",
  "ETH",
]);

/**
 * Extracts a stock ticker from the user prompt.
 * Returns the ticker in uppercase, or null if not found.
 */
function extractTicker(prompt: string): string | null {
  // 1. Explicit well-known tickers (word boundary match)
  for (const ticker of WELL_KNOWN_TICKERS) {
    const re = new RegExp(`\\b${ticker}\\b`, "i");
    if (re.test(prompt)) return ticker;
  }

  // 2. Pattern: 1-5 uppercase letters that look like a ticker
  //    (preceded by space/start, followed by space/end/punctuation)
  const m = prompt.match(/(?:^|[\s(（])([A-Z]{1,5})(?=$|[\s)）.,，。!！?？])/);
  if (m) return m[1];

  return null;
}

// ── Per-agent input extractors ────────────────────────────────────────────────

type InputExtractor = (prompt: string) => Record<string, unknown> | null;

const INVESTMENT_EXTRACTOR: InputExtractor = (prompt) => {
  const ticker = extractTicker(prompt);
  if (!ticker) return null;
  return { ticker };
};

const EXTRACTORS: Record<string, InputExtractor> = {
  "investment-analysis": INVESTMENT_EXTRACTOR,
};

// ── Trigger matching ──────────────────────────────────────────────────────────

/**
 * Returns a score [0,1] indicating how strongly the prompt matches
 * the given agent card's triggers.
 * Score > 0 means at least one trigger matched.
 */
function scoreTriggers(prompt: string, card: AgentCard): number {
  const lower = prompt.toLowerCase();
  let hits = 0;
  for (const trigger of card.triggers) {
    if (lower.includes(trigger.toLowerCase())) {
      hits++;
    }
  }
  // Normalize: at least 1 hit AND at least 1 trigger required
  if (card.triggers.length === 0 || hits === 0) return 0;
  return Math.min(hits / 2, 1); // 2 hits = max score, avoids over-fitting
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Decides whether the user's message should be routed to an external ADK agent.
 *
 * Routing criteria (both must be satisfied):
 *   1. At least one trigger keyword matches (scoreTriggers > 0)
 *   2. The agent-specific input extractor returns a valid input object
 *      (e.g., investment-analysis requires a recognizable ticker)
 *
 * This dual-gate prevents false positives: a message like "讨论一下宏观" would
 * match investment triggers but fail to extract a ticker, so it stays in Jarvis.
 */
export function routeToAgent(
  userPrompt: string,
  registry: AgentCard[],
): AgentRouteResult {
  if (registry.length === 0) return { matched: false };

  // Find the best-matching agent
  let bestCard: AgentCard | null = null;
  let bestScore = 0;

  for (const card of registry) {
    const score = scoreTriggers(userPrompt, card);
    if (score > bestScore) {
      bestScore = score;
      bestCard = card;
    }
  }

  // Require at least 2 trigger hits (score >= 1) to avoid false positives
  // from single-keyword matches (e.g., "analyze my MA thesis" matching only
  // "analyze" → score=0.5). The extractor provides the second gate for input
  // validity, but trigger confidence must already be high.
  if (!bestCard || bestScore < 1) return { matched: false };

  // Validate that we can extract a meaningful input for this agent
  const extractor = EXTRACTORS[bestCard.agentId];
  if (!extractor) {
    // No extractor registered — use trigger match alone (lower confidence)
    // Only dispatch if score is high enough (2+ triggers matched)
    if (bestScore < 1) return { matched: false };
    return {
      matched: true,
      agentId: bestCard.agentId,
      agentName: bestCard.name,
      input: { query: userPrompt },
      confirmationMessage: buildConfirmation(bestCard, {}),
    };
  }

  const input = extractor(userPrompt);
  if (!input) return { matched: false };

  return {
    matched: true,
    agentId: bestCard.agentId,
    agentName: bestCard.name,
    input,
    confirmationMessage: buildConfirmation(bestCard, input),
  };
}

// ── Confirmation message builder ──────────────────────────────────────────────

function buildConfirmation(
  card: AgentCard,
  input: Record<string, unknown>,
): string {
  const ticker = input.ticker as string | undefined;
  const subject = ticker ? `**${ticker}**` : "您的请求";

  return (
    `🤖 已启动 **${card.name}**，正在分析 ${subject}。\n\n` +
    `预计耗时：${card.estimatedDuration}。分析结果将在任务面板实时更新，` +
    `您可以继续与我对话。`
  );
}
