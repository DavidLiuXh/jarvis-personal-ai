#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type Boundary = {
  name: string;
  root: string;
  forbidden: RegExp[];
};

const boundaries: Boundary[] = [
  {
    name: "memory-runtime",
    root: path.join(repoRoot, "packages/memory-runtime/src"),
    forbidden: [
      /from\s+["'].*jarvis\/src\/core\//,
      /import\(["'].*jarvis\/src\/core\//,
      /from\s+["'].*intent-runtime\//,
      /import\(["'].*intent-runtime\//,
    ],
  },
  {
    name: "intent-runtime",
    root: path.join(repoRoot, "packages/intent-runtime/src"),
    forbidden: [
      /from\s+["'].*jarvis\/src\/core\//,
      /import\(["'].*jarvis\/src\/core\//,
    ],
  },
];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

const violations: string[] = [];

for (const boundary of boundaries) {
  for (const file of walk(boundary.root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of boundary.forbidden) {
      if (pattern.test(text)) {
        violations.push(
          `${boundary.name}: ${path.relative(repoRoot, file)} imports from jarvis/src/core`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Runtime boundary check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Runtime boundary check passed.");
