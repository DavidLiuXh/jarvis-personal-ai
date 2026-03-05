/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config, GeminiCLIExtension, MCPServerConfig } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import { McpClient, MCPDiscoveryState } from './mcp-client.js';
import type { EventEmitter } from 'node:events';
/**
 * Manages the lifecycle of multiple MCP clients, including local child processes.
 * This class is responsible for starting, stopping, and discovering tools from
 * a collection of MCP servers defined in the configuration.
 */
export declare class McpClientManager {
    private clients;
    private allServerConfigs;
    private readonly clientVersion;
    private readonly toolRegistry;
    private readonly cliConfig;
    private discoveryPromise;
    private discoveryState;
    private readonly eventEmitter?;
    private pendingRefreshPromise;
    private readonly blockedMcpServers;
    /**
     * Track whether the user has explicitly interacted with MCP in this session
     * (e.g. by running an /mcp command).
     */
    private userInteractedWithMcp;
    /**
     * Track which MCP diagnostics have already been shown to the user this session
     * and at what verbosity level.
     */
    private shownDiagnostics;
    /**
     * Track whether the MCP "hint" has been shown.
     */
    private hintShown;
    /**
     * Track the last error message for each server.
     */
    private lastErrors;
    constructor(clientVersion: string, toolRegistry: ToolRegistry, cliConfig: Config, eventEmitter?: EventEmitter);
    setUserInteractedWithMcp(): void;
    getLastError(serverName: string): string | undefined;
    /**
     * Emit an MCP diagnostic message, adhering to the user's intent and
     * deduplication rules.
     */
    emitDiagnostic(severity: 'info' | 'warning' | 'error', message: string, error?: unknown, serverName?: string): void;
    getBlockedMcpServers(): {
        name: string;
        extensionName: string;
    }[];
    getClient(serverName: string): McpClient | undefined;
    /**
     * For all the MCP servers associated with this extension:
     *
     *    - Removes all its MCP servers from the global configuration object.
     *    - Disconnects all MCP clients from their servers.
     *    - Updates the Gemini chat configuration to load the new tools.
     */
    stopExtension(extension: GeminiCLIExtension): Promise<void>;
    /**
     * For all the MCP servers associated with this extension:
     *
     *    - Adds all its MCP servers to the global configuration object.
     *    - Connects MCP clients to each server and discovers their tools.
     *    - Updates the Gemini chat configuration to load the new tools.
     */
    startExtension(extension: GeminiCLIExtension): Promise<void>;
    /**
     * Check if server is blocked by admin settings (allowlist/excludelist).
     * Returns true if blocked, false if allowed.
     */
    private isBlockedBySettings;
    /**
     * Check if server is disabled by user (session or file-based).
     */
    private isDisabledByUser;
    private disconnectClient;
    maybeDiscoverMcpServer(name: string, config: MCPServerConfig): Promise<void>;
    /**
     * Initiates the tool discovery process for all configured MCP servers (via
     * gemini settings or command line arguments).
     *
     * It connects to each server, discovers its available tools, and registers
     * them with the `ToolRegistry`.
     *
     * For any server which is already connected, it will first be disconnected.
     *
     * This does NOT load extension MCP servers - this happens when the
     * ExtensionLoader explicitly calls `loadExtension`.
     */
    startConfiguredMcpServers(): Promise<void>;
    /**
     * Restarts all MCP servers (including newly enabled ones).
     */
    restart(): Promise<void>;
    /**
     * Restart a single MCP server by name.
     */
    restartServer(name: string): Promise<void>;
    /**
     * Stops all running local MCP servers and closes all client connections.
     * This is the cleanup method to be called on application exit.
     */
    stop(): Promise<void>;
    getDiscoveryState(): MCPDiscoveryState;
    /**
     * All of the MCP server configurations (including disabled ones).
     */
    getMcpServers(): Record<string, MCPServerConfig>;
    getMcpInstructions(): string;
    private isRefreshingMcpContext;
    private pendingMcpContextRefresh;
    private scheduleMcpContextRefresh;
    getMcpServerCount(): number;
}
