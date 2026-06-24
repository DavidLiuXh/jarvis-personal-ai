/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SkillInfo = {
  name: string;
  description: string;
};

export type ActivatedSkill = SkillInfo & {
  path: string;
  instructions: string;
  resources: string[];
};

export interface SkillRuntime {
  listSkills(): Promise<SkillInfo[]>;
  activateSkill(name: string): Promise<ActivatedSkill>;
}

type SkillRecord = SkillInfo & {
  filePath: string;
  rootPath: string;
};

function defaultSkillRoots(cwd: string): string[] {
  const jarvisHome = path.join(os.homedir(), ".gemini-jarvis");
  return [
    path.join(os.homedir(), ".gemini", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(jarvisHome, "skills"),
    path.join(jarvisHome, ".gemini", "skills"),
    path.join(jarvisHome, ".agents", "skills"),
    path.join(cwd, ".gemini", "skills"),
  ];
}

function parseFrontmatterField(content: string, field: string): string {
  const match = content.match(
    new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, "m"),
  );
  return match?.[1]?.trim() ?? "";
}

function normalizeSkillKey(value: string): string {
  return value.trim().toLowerCase();
}

function safeReadText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function listResourcePaths(skillPath: string, limit = 200): string[] {
  const stat = fs.statSync(skillPath);
  const root = stat.isDirectory() ? skillPath : path.dirname(skillPath);
  const resources: string[] = [];
  const walk = (dir: string) => {
    if (resources.length >= limit) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (resources.length >= limit) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      resources.push(fullPath);
      if (entry.isDirectory()) walk(fullPath);
    }
  };
  if (stat.isDirectory()) {
    walk(root);
  } else {
    resources.push(skillPath);
  }
  return resources;
}

function discoverSkillRecords(roots: string[]): SkillRecord[] {
  const records = new Map<string, SkillRecord>();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const filePath = entry.isDirectory()
        ? path.join(root, entry.name, "SKILL.md")
        : entry.isFile() && entry.name.endsWith(".md")
          ? path.join(root, entry.name)
          : "";
      if (!filePath || !fs.existsSync(filePath)) continue;

      const content = safeReadText(filePath);
      if (!content) continue;
      const name =
        parseFrontmatterField(content, "name") ||
        (entry.isDirectory()
          ? entry.name
          : path.basename(entry.name, path.extname(entry.name)));
      const description = parseFrontmatterField(content, "description");
      if (!name || !description) continue;

      const key = normalizeSkillKey(name);
      if (records.has(key)) continue;
      records.set(key, {
        name,
        description,
        filePath,
        rootPath: entry.isDirectory() ? path.join(root, entry.name) : filePath,
      });
    }
  }
  return Array.from(records.values());
}

export class JarvisNativeSkillRuntime implements SkillRuntime {
  private readonly roots: string[];

  constructor(options: { cwd: string; roots?: string[] }) {
    this.roots = options.roots ?? defaultSkillRoots(options.cwd);
  }

  async listSkills(): Promise<SkillInfo[]> {
    return discoverSkillRecords(this.roots).map(({ name, description }) => ({
      name,
      description,
    }));
  }

  async activateSkill(name: string): Promise<ActivatedSkill> {
    const requested = normalizeSkillKey(name);
    if (!requested) throw new Error("Skill name is required.");

    const skills = discoverSkillRecords(this.roots);
    const skill = skills.find(
      (record) =>
        normalizeSkillKey(record.name) === requested ||
        normalizeSkillKey(path.basename(path.dirname(record.filePath))) ===
          requested ||
        normalizeSkillKey(
          path.basename(record.filePath, path.extname(record.filePath)),
        ) === requested,
    );
    if (!skill) {
      const available = skills.map((item) => item.name).sort();
      throw new Error(
        `Skill "${name}" not found. Available skills: ${available.join(", ") || "(none)"}`,
      );
    }

    const instructions = safeReadText(skill.filePath);
    if (!instructions) {
      throw new Error(`Skill "${skill.name}" is not readable.`);
    }

    return {
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      instructions,
      resources: listResourcePaths(skill.rootPath),
    };
  }
}

export function formatActivatedSkill(skill: ActivatedSkill): string {
  const resources = skill.resources
    .slice(0, 200)
    .map((resource) => resource)
    .join("\n");
  const escapedName = skill.name
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return [
    `<activated_skill name="${escapedName}">`,
    "  <instructions>",
    skill.instructions,
    "  </instructions>",
    "",
    "  <available_resources>",
    resources || "(No resources)",
    "  </available_resources>",
    "</activated_skill>",
  ].join("\n");
}
