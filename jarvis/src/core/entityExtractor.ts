/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaGenerateWithRetry } from "./ollamaClient.js";

export type EntityLink = {
  subject: string;
  subject_type:
    | "person"
    | "project"
    | "technology"
    | "concept"
    | "formatting_rule";
  relation:
    | "is_a"
    | "has_skill"
    | "works_on"
    | "uses"
    | "interested_in"
    | "has_behavior"
    | "is_part_of"
    | "prefers";
  object: string;
  object_type:
    | "person"
    | "project"
    | "technology"
    | "concept"
    | "formatting_rule";
};

export type GenerateTextFn = (prompt: string) => Promise<string>;

const EXTRACTION_PROMPT = (factsText: string) =>
  `
Extract entities and relations from the following FACTS ONLY.
Respond ONLY with raw valid JSON. DO NOT wrap in markdown code blocks (no \`\`\`json).

ENTITY TYPES (mutually exclusive):
- person: a human individual (e.g. "David", "User")
- project: a software project or system (e.g. "Jarvis", "jarvis-personal-ai")
- technology: a tool, language, framework, or service (e.g. "TypeScript", "Ollama", "bge-m3")
- concept: an abstract domain or topic (e.g. "investing", "running", "machine learning")
- formatting_rule: a response style or format preference (e.g. "table format", "Chinese language")

RELATION TYPES (Subject -> Relation -> Object):
- is_a: subject is an instance or type of object (e.g. David is_a software_engineer)
- has_skill: person possesses a skill (e.g. David has_skill TypeScript)
- works_on: person contributes to a project (e.g. David works_on jarvis-personal-ai)
- uses: person/project utilizes a technology (e.g. jarvis-personal-ai uses TypeScript)
- interested_in: person is curious about or focuses on a concept (e.g. David interested_in investing)
- has_behavior: person exhibits a recurring habit or action (e.g. David has_behavior running)
- is_part_of: subject is a component of object (e.g. API is_part_of Backend)
- prefers: person/project favors a technology or formatting_rule (e.g. User prefers table_format)

EXTRACTION RULES:
- GROUNDING: Only extract entities explicitly named or clearly implied in the facts. Do NOT hallucinate.
- NORMALIZATION: Standardize entity names to canonical forms (e.g. "ts" -> "TypeScript", "js" -> "JavaScript"). Use proper casing ("Python" not "python").
- USER: Normalize the user to their actual name if known; otherwise use "User" (capitalized).
- ATOMICITY: Each relation must have exactly one subject and one object.
- SPECIFICITY: Prefer specific names over generic ones ("jarvis-personal-ai" over "the project").
- If a fact yields no clear mapped relation, skip it.

Input facts:
${factsText}

If valid relations found: {"found": true, "links": [{"subject": "...", "subject_type": "person|project|technology|concept|formatting_rule", "relation": "is_a|has_skill|works_on|uses|interested_in|has_behavior|is_part_of|prefers", "object": "...", "object_type": "person|project|technology|concept|formatting_rule"}]}
If no relations found: {"found": false}
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
        responseText = await ollamaGenerateWithRetry(this.ollamaModel, prompt, {
          baseUrl: this.ollamaBaseUrl,
          timeoutMs: this.timeoutMs,
          maxRetries: 2,
          maxTimeoutMs: this.timeoutMs * 3,
          // Ollama defaults to num_ctx=2048 which is too small for structured
          // JSON extraction with long facts. Use 8192 to ensure the prompt +
          // output JSON fit without truncation.
          numCtx: 8192,
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

      // Apply repairs in order. Try each stage, stop at first successful parse.
      const tryParse = (s: string) => {
        try {
          return JSON.parse(s) as { found: boolean; links?: EntityLink[] };
        } catch {
          return null;
        }
      };

      // Stage 1: trailing commas only
      const stage1 = rawJson.replace(/,\s*]/g, "]").replace(/,\s*}/g, "}");

      // Stage 2: also collapse newlines (LLM unescaped newlines inside strings)
      const stage2 = stage1.replace(/\n/g, " ");

      // Stage 3: truncation repair — if output was cut mid-array, find the last
      // complete link object and close the JSON structure around it.
      // Looks for the last complete `}` inside the "links" array, then appends `]}`.
      const repairTruncated = (s: string): string => {
        const linksStart = s.indexOf('"links"');
        if (linksStart === -1) return s;
        const lastCompleteObj = s.lastIndexOf("}");
        if (lastCompleteObj === -1) return s;
        return s.substring(0, lastCompleteObj + 1) + "]}";
      };
      const stage3 = repairTruncated(stage2);

      const jsonText = tryParse(stage1)
        ? stage1
        : tryParse(stage2)
          ? stage2
          : stage3; // may or may not parse — handled below

      try {
        const data = tryParse(jsonText);
        if (!data) throw new SyntaxError("All repair stages failed");

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
