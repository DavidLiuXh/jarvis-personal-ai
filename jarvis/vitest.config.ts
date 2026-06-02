/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@jarvis\/memory-runtime\/(.+)$/,
        replacement: path.resolve(
          __dirname,
          "../packages/memory-runtime/src/$1.ts",
        ),
      },
      {
        find: "@jarvis/memory-runtime",
        replacement: path.resolve(
          __dirname,
          "../packages/memory-runtime/src/index.ts",
        ),
      },
      {
        find: /^@jarvis\/intent-runtime\/(.+)$/,
        replacement: path.resolve(
          __dirname,
          "../packages/intent-runtime/src/$1.ts",
        ),
      },
      {
        find: "@jarvis/intent-runtime",
        replacement: path.resolve(
          __dirname,
          "../packages/intent-runtime/src/index.ts",
        ),
      },
      {
        find: /^@jarvis\/agent-runtime\/(.+)$/,
        replacement: path.resolve(
          __dirname,
          "../packages/agent-runtime/src/$1.ts",
        ),
      },
      {
        find: "@jarvis/agent-runtime",
        replacement: path.resolve(
          __dirname,
          "../packages/agent-runtime/src/index.ts",
        ),
      },
    ],
  },
  test: {
    testTimeout: 30000,
    pool: "forks",
  },
});
