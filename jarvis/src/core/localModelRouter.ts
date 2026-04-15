/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const CLASSIFIER_SYSTEM_PROMPT = `
You are a specialized Task Routing AI. Your sole function is to analyze the user's request and assign a Complexity Score from 1 to 100.

# Complexity Rubric
1-20: Trivial / Direct
  - Simple questions, greetings, read-only lookups, single-step operations.

21-50: Standard / Routine
  - Single-topic analysis, simple summaries, standard Q&A with moderate context.

51-80: High Complexity / Analytical
  - Multi-topic reasoning, financial analysis, debugging unknown issues,
    feature implementation, understanding broader context.

81-100: Extreme / Strategic
  - Architecture design, deep reasoning across many facts, highly ambiguous
    requests, tasks requiring novel synthesis or strategic planning.

# Output Format
Respond ONLY with a JSON object (no markdown, no explanation):
{"complexity_reasoning": "<brief reason>", "complexity_score": <integer 1-100>}
`.trim();

export type RoutingResult = {
  model: string;
  score: number;
  reasoning: string;
  source: "local-router/ollama" | "local-router/fallback";
};

export class LocalModelRouter {
  constructor(
    private baseUrl: string = "http://localhost:11434",
    private classifierModel: string,
    private threshold: number = 70,
    private proModel: string = "gemini-2.5-pro",
    private flashModel: string = "gemini-2.5-flash",
    private timeoutMs: number = 30_000,
  ) {}

  async route(userPrompt: string): Promise<RoutingResult> {
    try {
      const score = await this.classify(userPrompt);
      const model = score >= this.threshold ? this.proModel : this.flashModel;
      return {
        model,
        score,
        reasoning:
          score >= this.threshold
            ? `Score ${score} >= threshold ${this.threshold} → ${this.proModel}`
            : `Score ${score} < threshold ${this.threshold} → ${this.flashModel}`,
        source: "local-router/ollama",
      };
    } catch (e: any) {
      // On any failure, fall back to proModel to avoid degraded quality
      return {
        model: this.proModel,
        score: -1,
        reasoning: `Classification failed (${e.message}), defaulting to ${this.proModel}`,
        source: "local-router/fallback",
      };
    }
  }

  private async classify(prompt: string): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const fullPrompt = `${CLASSIFIER_SYSTEM_PROMPT}\n\nUser request: ${prompt}`;
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
        complexity_reasoning?: string;
      };

      const score = Number(parsed.complexity_score);
      if (isNaN(score) || score < 1 || score > 100) {
        throw new Error(`Invalid score: ${parsed.complexity_score}`);
      }

      return score;
    } finally {
      clearTimeout(timeout);
    }
  }
}
