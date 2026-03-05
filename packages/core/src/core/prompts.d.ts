/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import type { HierarchicalMemory } from '../config/memory.js';
/**
 * Resolves a path or switch value from an environment variable.
 * @deprecated Use resolvePathFromEnv from @google/gemini-cli-core/prompts/utils instead.
 */
export declare function resolvePathFromEnv(envVar?: string): import("../prompts/utils.js").ResolvedPath;
/**
 * Returns the core system prompt for the agent.
 */
export declare function getCoreSystemPrompt(config: Config, userMemory?: string | HierarchicalMemory, interactiveOverride?: boolean): string;
/**
 * Provides the system prompt for the history compression process.
 */
export declare function getCompressionPrompt(config: Config): string;
