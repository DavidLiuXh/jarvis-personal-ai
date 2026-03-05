/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @fileoverview Manages browser lifecycle for the Browser Agent.
 *
 * Handles:
 * - Browser management via chrome-devtools-mcp with --isolated mode
 * - CDP connection via raw MCP SDK Client (NOT registered in main registry)
 * - Visual tools via --experimental-vision flag
 *
 * IMPORTANT: The MCP client here is ISOLATED from the main agent's tool registry.
 * Tools discovered from chrome-devtools-mcp are NOT registered in the main registry.
 * They are wrapped as DeclarativeTools and passed directly to the browser agent.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../../config/config.js';
/**
 * Content item from an MCP tool call response.
 * Can be text or image (for take_screenshot).
 */
export interface McpContentItem {
    type: 'text' | 'image';
    text?: string;
    /** Base64-encoded image data (for type='image') */
    data?: string;
    /** MIME type of the image (e.g., 'image/png') */
    mimeType?: string;
}
/**
 * Result from an MCP tool call.
 */
export interface McpToolCallResult {
    content?: McpContentItem[];
    isError?: boolean;
}
/**
 * Manages browser lifecycle and ISOLATED MCP client for the Browser Agent.
 *
 * The browser is launched and managed by chrome-devtools-mcp in --isolated mode.
 * Visual tools (click_at, etc.) are enabled via --experimental-vision flag.
 *
 * Key isolation property: The MCP client here does NOT register tools
 * in the main ToolRegistry. Tools are kept local to the browser agent.
 */
export declare class BrowserManager {
    private config;
    private rawMcpClient;
    private mcpTransport;
    private discoveredTools;
    constructor(config: Config);
    /**
     * Gets the raw MCP SDK Client for direct tool calls.
     * This client is ISOLATED from the main tool registry.
     */
    getRawMcpClient(): Promise<Client>;
    /**
     * Gets the tool definitions discovered from the MCP server.
     * These are dynamically fetched from chrome-devtools-mcp.
     */
    getDiscoveredTools(): Promise<McpTool[]>;
    /**
     * Calls a tool on the MCP server.
     *
     * @param toolName The name of the tool to call
     * @param args Arguments to pass to the tool
     * @param signal Optional AbortSignal to cancel the call
     * @returns The result from the MCP server
     */
    callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>;
    /**
     * Safely maps a raw MCP SDK callTool response to our typed McpToolCallResult
     * without using unsafe type assertions.
     */
    private toResult;
    /**
     * Ensures browser and MCP client are connected.
     */
    ensureConnection(): Promise<void>;
    /**
     * Closes browser and cleans up connections.
     * The browser process is managed by chrome-devtools-mcp, so closing
     * the transport will terminate the browser.
     */
    close(): Promise<void>;
    /**
     * Connects to chrome-devtools-mcp which manages the browser process.
     *
     * Spawns npx chrome-devtools-mcp with:
     * - --isolated: Manages its own browser instance
     * - --experimental-vision: Enables visual tools (click_at, etc.)
     *
     * IMPORTANT: This does NOT use McpClientManager and does NOT register
     * tools in the main ToolRegistry. The connection is isolated to this
     * BrowserManager instance.
     */
    private connectMcp;
    /**
     * Creates an Error with context-specific remediation based on the actual
     * error message and the current sessionMode.
     */
    private createConnectionError;
    /**
     * Discovers tools from the connected MCP server.
     */
    private discoverTools;
}
