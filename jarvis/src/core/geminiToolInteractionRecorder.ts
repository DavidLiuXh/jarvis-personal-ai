/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { recordToolCallInteractions } from "../../../gemini-cli/packages/core/src/index.js";
import type { ToolInteractionRecorder } from "./toolRouter.js";

export function createGeminiToolInteractionRecorder(): ToolInteractionRecorder {
  return {
    async record(config: unknown, completedCalls: unknown[]): Promise<void> {
      await recordToolCallInteractions(
        config as Parameters<typeof recordToolCallInteractions>[0],
        completedCalls as Parameters<typeof recordToolCallInteractions>[1],
      );
    },
  };
}
