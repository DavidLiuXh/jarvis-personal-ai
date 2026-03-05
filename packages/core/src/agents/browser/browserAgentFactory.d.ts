/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @fileoverview Factory for creating browser agent definitions with configured tools.
 *
 * This factory is called when the browser agent is invoked via delegate_to_agent.
 * It creates a BrowserManager, connects the isolated MCP client, wraps tools,
 * and returns a fully configured LocalAgentDefinition.
 *
 * IMPORTANT: The MCP tools are ONLY available to the browser agent's isolated
 * registry. They are NOT registered in the main agent's ToolRegistry.
 */
import type { Config } from '../../config/config.js';
import type { LocalAgentDefinition } from '../types.js';
import type { MessageBus } from '../../confirmation-bus/message-bus.js';
import { BrowserManager } from './browserManager.js';
import { type BrowserTaskResultSchema } from './browserAgentDefinition.js';
/**
 * Creates a browser agent definition with MCP tools configured.
 *
 * This is called when the browser agent is invoked via delegate_to_agent.
 * The MCP client is created fresh and tools are wrapped for the agent's
 * isolated registry - NOT registered with the main agent.
 *
 * @param config Runtime configuration
 * @param messageBus Message bus for tool invocations
 * @param printOutput Optional callback for progress messages
 * @returns Fully configured LocalAgentDefinition with MCP tools
 */
export declare function createBrowserAgentDefinition(config: Config, messageBus: MessageBus, printOutput?: (msg: string) => void): Promise<{
    definition: LocalAgentDefinition<typeof BrowserTaskResultSchema>;
    browserManager: BrowserManager;
}>;
/**
 * Cleans up browser resources after agent execution.
 *
 * @param browserManager The browser manager to clean up
 */
export declare function cleanupBrowserAgent(browserManager: BrowserManager): Promise<void>;
