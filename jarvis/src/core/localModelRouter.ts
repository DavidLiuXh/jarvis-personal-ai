/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const CLASSIFIER_SYSTEM_PROMPT = `
You are a task complexity analyst. Evaluate the user's request on two dimensions, then compute a weighted final score.

# Dimension 1: Knowledge Depth (1-100)
How much theoretical knowledge, domain expertise, or abstract reasoning is required?

1-25 (Low): Basic fact retrieval, simple summaries, applying known formulas.
26-50 (Medium): Integrating multiple concepts, simple logical reasoning, standard workflows.
51-75 (High): Deep domain expertise, cross-disciplinary analysis, creative problem-solving.
76-100 (Very High): Cross-domain knowledge fusion, highly abstract thinking, innovative system design.

# Dimension 2: Operational Difficulty (1-100)
How complex are the actual steps, tool usage, or execution required?

1-25 (Low): Reading, copying, simple input — no multi-step execution needed.
26-50 (Medium): Multi-step operations, using standard tools, following a defined process.
51-75 (High): Skilled tool usage, process design, coordinating multiple components.
76-100 (Very High): Algorithm design, system debugging, complex data processing, architectural decisions.

# Final Score
complexity_score = knowledge_score * 0.6 + operation_score * 0.4
Round to the nearest integer.

# Output Format
Respond ONLY with a JSON object (no markdown, no extra text):
{"knowledge_score": <1-100>, "operation_score": <1-100>, "complexity_score": <1-100>, "complexity_reasoning": "<brief reason>"}
`.trim();

export type RoutingResult = {
  model: string;
  score: number;
  classifierReason: string; // why the classifier assigned this score
  decision: string; // score vs threshold conclusion
  source: "local-router/ollama" | "local-router/fallback";
};

type ClassifyResult = {
  score: number;
  reason: string;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export class LocalModelRouter {
  constructor(
    private baseUrl: string = "http://localhost:11434",
    private classifierModel: string,
    private threshold: number = 70,
    private proModel: string = "gemini-2.5-pro",
    private flashModel: string = "gemini-2.5-flash",
    private timeoutMs: number = 30_000,
    private historyTurns: number = 5,
  ) {}

  async route(
    userPrompt: string,
    history: ConversationTurn[] = [],
  ): Promise<RoutingResult> {
    try {
      const { score, reason } = await this.classify(userPrompt, history);
      const model = score >= this.threshold ? this.proModel : this.flashModel;
      return {
        model,
        score,
        classifierReason: reason,
        decision:
          score >= this.threshold
            ? `Score ${score} >= threshold ${this.threshold} → ${this.proModel}`
            : `Score ${score} < threshold ${this.threshold} → ${this.flashModel}`,
        source: "local-router/ollama",
      };
    } catch (e: any) {
      return {
        model: this.proModel,
        score: -1,
        classifierReason: e.message,
        decision: `Classification failed, defaulting to ${this.proModel}`,
        source: "local-router/fallback",
      };
    }
  }

  private async classify(
    prompt: string,
    history: ConversationTurn[],
  ): Promise<ClassifyResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Include recent history for context-aware classification
      const recentTurns = history.slice(-this.historyTurns * 2); // each turn = user + assistant
      const historySection =
        recentTurns.length > 0
          ? `\n# Recent Conversation Context\n${recentTurns
              .map(
                (t) =>
                  `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 200)}`,
              )
              .join("\n")}\n`
          : "";

      const fullPrompt = `${CLASSIFIER_SYSTEM_PROMPT}${historySection}\nUser request: ${prompt}`;
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.classifierModel,
          prompt: fullPrompt,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama classify failed: ${response.status}`);
      }

      const data = (await response.json()) as { response: string };
      const raw = data.response;

      // Extract JSON — model may wrap in markdown
      const match = raw.match(/\{[\s\S]*?\}/);
      if (!match) throw new Error("No JSON in classifier response");

      const parsed = JSON.parse(match[0]) as {
        complexity_score?: number;
        knowledge_score?: number;
        operation_score?: number;
        complexity_reasoning?: string;
      };

      const score = Number(parsed.complexity_score);
      if (isNaN(score) || score < 1 || score > 100) {
        throw new Error(`Invalid score: ${parsed.complexity_score}`);
      }

      const knowledgeScore = parsed.knowledge_score ?? null;
      const operationScore = parsed.operation_score ?? null;
      const breakdown =
        knowledgeScore !== null && operationScore !== null
          ? ` [knowledge=${knowledgeScore}, operation=${operationScore}]`
          : "";

      return {
        score,
        reason: `${parsed.complexity_reasoning ?? "(no reason)"}${breakdown}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
