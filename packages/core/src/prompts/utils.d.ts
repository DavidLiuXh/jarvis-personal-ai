/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
export type ResolvedPath = {
    isSwitch: boolean;
    value: string | null;
    isDisabled: boolean;
};
/**
 * Resolves a path or switch value from an environment variable.
 */
export declare function resolvePathFromEnv(envVar?: string): ResolvedPath;
/**
 * Applies template substitutions to a prompt string.
 */
export declare function applySubstitutions(prompt: string, config: Config, skillsPrompt: string, isGemini3?: boolean): string;
/**
 * Checks if a specific prompt section is enabled via environment variables.
 */
export declare function isSectionEnabled(key: string): boolean;
