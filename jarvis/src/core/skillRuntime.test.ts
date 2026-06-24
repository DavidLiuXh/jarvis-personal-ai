/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatActivatedSkill,
  JarvisNativeSkillRuntime,
} from "./skillRuntime.js";

describe("JarvisNativeSkillRuntime", () => {
  it("discovers and activates directory SKILL.md skills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jarvis-skills-"));
    try {
      const skillDir = path.join(root, "dmii");
      await mkdir(path.join(skillDir, "references"), { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: dmii",
          "description: DMII framework",
          "---",
          "# DMII",
          "Use decomposition, modeling, integration, and iteration.",
        ].join("\n"),
      );
      await writeFile(
        path.join(skillDir, "references", "template.md"),
        "# Template\n",
      );

      const runtime = new JarvisNativeSkillRuntime({
        cwd: root,
        roots: [root],
      });

      await expect(runtime.listSkills()).resolves.toEqual([
        { name: "dmii", description: "DMII framework" },
      ]);
      const skill = await runtime.activateSkill("dmii");
      expect(skill.path).toBe(path.join(skillDir, "SKILL.md"));
      expect(skill.instructions).toContain("# DMII");
      expect(skill.resources).toContain(
        path.join(skillDir, "references", "template.md"),
      );
      expect(formatActivatedSkill(skill)).toContain(
        '<activated_skill name="dmii">',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers and activates single-file markdown skills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jarvis-skills-"));
    try {
      await writeFile(
        path.join(root, "writer.md"),
        [
          "---",
          "name: writer",
          "description: Writing assistant",
          "---",
          "# Writer",
          "Produce concise drafts.",
        ].join("\n"),
      );

      const runtime = new JarvisNativeSkillRuntime({
        cwd: root,
        roots: [root],
      });

      await expect(runtime.listSkills()).resolves.toEqual([
        { name: "writer", description: "Writing assistant" },
      ]);
      const skill = await runtime.activateSkill("writer");
      expect(skill.path).toBe(path.join(root, "writer.md"));
      expect(skill.resources).toEqual([path.join(root, "writer.md")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports available skills when activation misses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jarvis-skills-"));
    try {
      await writeFile(
        path.join(root, "writer.md"),
        [
          "---",
          "name: writer",
          "description: Writing assistant",
          "---",
          "# Writer",
        ].join("\n"),
      );
      const runtime = new JarvisNativeSkillRuntime({
        cwd: root,
        roots: [root],
      });

      await expect(runtime.activateSkill("dmii")).rejects.toThrow(
        'Skill "dmii" not found. Available skills: writer',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
