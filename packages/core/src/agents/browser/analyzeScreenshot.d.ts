/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @fileoverview Tool for visual identification via a single model call.
 *
 * The semantic browser agent uses this tool when it needs to identify
 * elements by visual attributes not present in the accessibility tree
 * (e.g., color, layout, precise coordinates).
 *
 * Unlike the semantic agent which works with the accessibility tree,
 * this tool sends a screenshot to a computer-use model for visual analysis.
 * It returns the model's analysis (coordinates, element descriptions) back
 * to the browser agent, which retains full control of subsequent actions.
 */
import { DeclarativeTool, type ToolResult, type ToolInvocation } from '../../tools/tools.js';
import type { MessageBus } from '../../confirmation-bus/message-bus.js';
import type { BrowserManager } from './browserManager.js';
import type { Config } from '../../config/config.js';
/**
 * DeclarativeTool for screenshot-based visual analysis.
 */
declare class AnalyzeScreenshotTool extends DeclarativeTool<Record<string, unknown>, ToolResult> {
    private readonly browserManager;
    private readonly config;
    constructor(browserManager: BrowserManager, config: Config, messageBus: MessageBus);
    build(params: Record<string, unknown>): ToolInvocation<Record<string, unknown>, ToolResult>;
}
/**
 * Creates the analyze_screenshot tool for the browser agent.
 */
export declare function createAnalyzeScreenshotTool(browserManager: BrowserManager, config: Config, messageBus: MessageBus): AnalyzeScreenshotTool;
export {};
