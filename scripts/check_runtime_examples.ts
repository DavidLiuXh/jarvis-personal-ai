/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const examplesDir = path.join(repoRoot, "examples", "runtime");
const forbiddenPatterns = [
  {
    pattern: /from\s+["'].*jarvis\/src\//,
    reason: "runtime examples must not import Jarvis core",
  },
  {
    pattern:
      /from\s+["'].*packages\/(?:memory-runtime|intent-runtime|agent-runtime)\/src\//,
    reason: "runtime examples must use package public exports",
  },
];

async function listExampleFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listExampleFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await listExampleFiles(examplesDir);
const failures: string[] = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const { pattern, reason } of forbiddenPatterns) {
    if (pattern.test(text)) {
      failures.push(`${path.relative(repoRoot, file)}: ${reason}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Runtime example boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Runtime example boundary check passed (${files.length} files).`);
