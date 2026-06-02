/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import { EntityExtractor } from "./entityExtractor.js";

describe("EntityExtractor", () => {
  it("extracts facts in bounded batches and deduplicates links", async () => {
    const prompts: string[] = [];
    const generateText = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      const userLinks = [
        {
          subject: "User",
          subject_type: "person",
          relation: "prefers",
          object: "Python-based backend architecture",
          object_type: "concept",
        },
      ];
      return JSON.stringify({
        found: true,
        links: [
          ...userLinks,
          {
            subject: `FactBatch${prompts.length}`,
            subject_type: "concept",
            relation: "is_part_of",
            object: "Entity extraction test",
            object_type: "concept",
          },
        ],
      });
    });

    const extractor = new EntityExtractor(
      "gemini",
      generateText,
      "http://localhost:11434",
      "",
      30_000,
      4,
    );

    const links = await extractor.extract(
      Array.from({ length: 9 }, (_, index) => ({
        category: "behavior",
        content: `Fact ${index + 1}`,
      })),
    );

    expect(generateText).toHaveBeenCalledTimes(3);
    expect(prompts[0]).toContain("Fact 1");
    expect(prompts[0]).toContain("Fact 4");
    expect(prompts[0]).not.toContain("Fact 5");
    expect(prompts[1]).toContain("Fact 5");
    expect(prompts[1]).toContain("Fact 8");
    expect(prompts[2]).toContain("Fact 9");
    expect(links).toHaveLength(4);
    expect(
      links.filter(
        (link) => link.subject === "User" && link.relation === "prefers",
      ),
    ).toHaveLength(1);
  });
});
