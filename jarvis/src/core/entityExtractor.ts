/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionTextGenerationBackend,
  OllamaTextGenerationBackend,
  type TextGenerationBackend,
} from "./textGenerationBackend.js";

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

const DEFAULT_FACT_BATCH_SIZE = 4;

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
  private readonly backend: TextGenerationBackend;

  constructor(
    providerOrBackend: "ollama" | "gemini" | TextGenerationBackend,
    generateTextFn: GenerateTextFn | null,
    ollamaBaseUrl: string = "http://localhost:11434",
    ollamaModel: string = "",
    timeoutMs: number = 30_000,
    private factBatchSize: number = DEFAULT_FACT_BATCH_SIZE,
  ) {
    if (typeof providerOrBackend !== "string") {
      this.backend = providerOrBackend;
    } else if (providerOrBackend === "ollama") {
      if (!ollamaModel) {
        throw new Error("[EntityExtractor] ollamaModel is required");
      }
      this.backend = new OllamaTextGenerationBackend({
        model: ollamaModel,
        baseUrl: ollamaBaseUrl,
        timeoutMs,
        maxRetries: 2,
        numCtx: 8192,
      });
    } else {
      if (!generateTextFn) {
        throw new Error("generateTextFn not set for function text provider");
      }
      this.backend = new FunctionTextGenerationBackend(generateTextFn, {
        provider: "gemini-compatible-function",
      });
    }
  }

  async extract(
    facts: Array<{ category: string; content: string }>,
  ): Promise<EntityLink[]> {
    if (facts.length === 0) return [];

    const batchSize = Math.max(1, Math.floor(this.factBatchSize));
    const batches = chunkFacts(facts, batchSize);
    const allLinks: EntityLink[] = [];
    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await new Promise((resolve) => setImmediate(resolve));
      allLinks.push(...(await this.extractBatch(batches[i]!)));
    }
    return dedupeLinks(allLinks);
  }

  private async extractBatch(
    facts: Array<{ category: string; content: string }>,
  ): Promise<EntityLink[]> {
    if (facts.length === 0) return [];

    const factsText = facts
      .map((f) => `[${f.category}] ${f.content}`)
      .join("\n");

    const prompt = EXTRACTION_PROMPT(factsText);

    try {
      const data = await this.backend.generateJson<{
        found: boolean;
        links?: EntityLink[];
      }>({
        prompt,
        json: true,
        purpose: "entity-extraction",
      });

      if (!data.found || !data.links) return [];
      return data.links.filter((l) => l.subject && l.relation && l.object);
    } catch (e: any) {
      console.error(`⚠️ [EntityExtractor] extract failed: ${e.message}`);
      return [];
    }
  }
}

function chunkFacts<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function dedupeLinks(links: EntityLink[]): EntityLink[] {
  const seen = new Set<string>();
  const result: EntityLink[] = [];
  for (const link of links) {
    const key = [
      link.subject,
      link.subject_type,
      link.relation,
      link.object,
      link.object_type,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}
