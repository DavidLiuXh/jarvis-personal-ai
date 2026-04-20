/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaGenerate } from "./ollamaClient.js";

export type EntityLink = {
  subject: string;
  subject_type: "person" | "project" | "technology" | "concept";
  relation:
    | "is_a"
    | "has_skill"
    | "works_on"
    | "uses"
    | "interested_in"
    | "has_habit"
    | "part_of";
  object: string;
  object_type: "person" | "project" | "technology" | "concept";
};

export type GenerateTextFn = (prompt: string) => Promise<string>;

const EXTRACTION_PROMPT = (factsText: string) =>
  `
Extract entities and relations from the following FACTS ONLY.

ENTITY TYPES (mutually exclusive):
- person: a human individual (e.g. "David", "the user")
- project: a software project or system (e.g. "Jarvis", "jarvis-personal-ai")
- technology: a tool, language, framework, or service (e.g. "TypeScript", "Ollama", "bge-m3")
- concept: an abstract domain or topic (e.g. "investing", "running", "machine learning")

RELATION TYPES:
- is_a: subject is an instance of object (e.g. David is_a software_engineer)
- has_skill: person has a skill (e.g. David has_skill embedding_debugging)
- works_on: person works on a project (e.g. David works_on jarvis-personal-ai)
- uses: project/person uses a technology (e.g. jarvis-personal-ai uses TypeScript)
- interested_in: person is interested in a concept (e.g. David interested_in investing)
- has_habit: person has a recurring behavior (e.g. David has_habit running)
- part_of: object is a component of subject (e.g. DNI part_of jarvis-personal-ai)

RULES:
- Only extract entities that are explicitly named or clearly implied in the facts.
- The user should always be normalized to their actual name if known, otherwise use "user".
- Do NOT invent entities or relations not grounded in the facts.
- Each relation must have exactly one subject and one object.
- If a fact yields no clear entity relation, skip it.
- Prefer specific entity names over generic ones ("jarvis-personal-ai" over "the project").

Input facts:
${factsText}

Respond ONLY with JSON:
{"found": true, "links": [{"subject": "...", "subject_type": "person|project|technology|concept", "relation": "is_a|has_skill|works_on|uses|interested_in|has_habit|part_of", "object": "...", "object_type": "person|project|technology|concept"}]}
If no entity relations can be extracted, respond: {"found": false}
`.trim();

export class EntityExtractor {
  constructor(
    private provider: "ollama" | "gemini",
    private generateTextFn: GenerateTextFn | null,
    private ollamaBaseUrl: string = "http://localhost:11434",
    private ollamaModel: string = "",
    private timeoutMs: number = 30_000,
  ) {}

  async extract(
    facts: Array<{ category: string; content: string }>,
  ): Promise<EntityLink[]> {
    if (facts.length === 0) return [];

    const factsText = facts
      .map((f) => `[${f.category}] ${f.content}`)
      .join("\n");

    const prompt = EXTRACTION_PROMPT(factsText);

    try {
      let responseText: string;
      if (this.provider === "ollama") {
        if (!this.ollamaModel)
          throw new Error("[EntityExtractor] ollamaModel is required");
        responseText = await ollamaGenerate(this.ollamaModel, prompt, {
          baseUrl: this.ollamaBaseUrl,
          timeoutMs: this.timeoutMs,
        });
      } else {
        if (!this.generateTextFn)
          throw new Error("generateTextFn not set for gemini provider");
        responseText = await this.generateTextFn(prompt);
      }

      // 1. More robust JSON extraction: find the first { and the last }
      const start = responseText.indexOf("{");
      const end = responseText.lastIndexOf("}");
      if (start === -1 || end === -1 || end < start) {
        console.error(
          `⚠️ [EntityExtractor] No JSON object found in response. Length: ${responseText.length}`,
        );
        return [];
      }

      const rawJson = responseText.substring(start, end + 1);

      // Apply repairs only when needed. Try direct parse first to avoid
      // corrupting multi-line string values with the newline replacement.
      const repaired = rawJson
        .replace(/,\s*]/g, "]") // Fix trailing commas in arrays
        .replace(/,\s*}/g, "}"); // Fix trailing commas in objects

      // If repaired JSON still fails to parse, fall back to collapsing
      // bare newlines (LLM sometimes emits unescaped newlines inside strings).
      const jsonText = (() => {
        try {
          JSON.parse(repaired);
          return repaired;
        } catch {
          // Only replace newlines that appear outside of quoted strings
          // by collapsing runs of whitespace between tokens.
          return repaired.replace(/\n/g, " ");
        }
      })();

      try {
        const data = JSON.parse(jsonText) as {
          found: boolean;
          links?: EntityLink[];
        };

        if (!data.found || !data.links) return [];
        return data.links.filter((l) => l.subject && l.relation && l.object);
      } catch (parseError: any) {
        console.error(
          `❌ [EntityExtractor] JSON parse failed: ${parseError.message}`,
        );
        // Log a snippet around the error position if available
        const pos = parseError.message.match(/position (\d+)/)?.[1];
        if (pos) {
          const p = parseInt(pos);
          console.error(
            `Context: ...${jsonText.substring(Math.max(0, p - 40), Math.min(jsonText.length, p + 40))}...`,
          );
        } else {
          console.error(`Raw JSON text: ${jsonText.substring(0, 200)}...`);
        }
        return [];
      }
    } catch (e: any) {
      console.error(`⚠️ [EntityExtractor] extract failed: ${e.message}`);
      return [];
    }
  }
}
