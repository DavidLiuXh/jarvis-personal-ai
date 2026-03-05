/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @fileoverview Browser Agent definition following the LocalAgentDefinition pattern.
 *
 * This agent uses LocalAgentExecutor for its reAct loop, like CodebaseInvestigatorAgent.
 * It is available ONLY via delegate_to_agent, NOT as a direct tool.
 *
 * Tools are configured dynamically at invocation time via browserAgentFactory.
 */
import type { LocalAgentDefinition } from '../types.js';
import type { Config } from '../../config/config.js';
import { z } from 'zod';
/** Canonical agent name — used for routing and configuration lookup. */
export declare const BROWSER_AGENT_NAME = "browser_agent";
/**
 * Output schema for browser agent results.
 */
export declare const BrowserTaskResultSchema: z.ZodObject<{
    success: z.ZodBoolean;
    summary: z.ZodString;
    data: z.ZodOptional<z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    success: boolean;
    summary: string;
    data?: unknown;
}, {
    success: boolean;
    summary: string;
    data?: unknown;
}>;
/**
 * System prompt for the semantic browser agent.
 * Extracted from prototype (computer_use_subagent_cdt branch).
 *
 * @param visionEnabled Whether visual tools (analyze_screenshot, click_at) are available.
 */
export declare function buildBrowserSystemPrompt(visionEnabled: boolean): string;
/**
 * Browser Agent Definition Factory.
 *
 * Following the CodebaseInvestigatorAgent pattern:
 * - Returns a factory function that takes Config for dynamic model selection
 * - kind: 'local' for LocalAgentExecutor
 * - toolConfig is set dynamically by browserAgentFactory
 */
export declare const BrowserAgentDefinition: (config: Config, visionEnabled?: boolean) => LocalAgentDefinition<typeof BrowserTaskResultSchema>;
