/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import type { HierarchicalMemory } from '../config/memory.js';
/**
 * Orchestrates prompt generation by gathering context and building options.
 */
export declare class PromptProvider {
    /**
     * Generates the core system prompt.
     */
    getCoreSystemPrompt(config: Config, userMemory?: string | HierarchicalMemory, interactiveOverride?: boolean): string;
    getCompressionPrompt(config: Config): string;
    private withSection;
    private maybeWriteSystemMd;
}
