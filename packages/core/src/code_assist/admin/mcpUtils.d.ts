/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { MCPServerConfig } from '../../config/config.js';
/**
 * Applies the admin allowlist to the local MCP servers.
 *
 * If an admin allowlist is provided and not empty, this function filters the
 * local servers to only those present in the allowlist. It also overrides
 * connection details (url, type, trust) with the admin configuration and
 * removes local execution details (command, args, env, cwd).
 *
 * @param localMcpServers The locally configured MCP servers.
 * @param adminAllowlist The admin allowlist configuration.
 * @returns The filtered and merged MCP servers.
 */
export declare function applyAdminAllowlist(localMcpServers: Record<string, MCPServerConfig>, adminAllowlist: Record<string, MCPServerConfig> | undefined): {
    mcpServers: Record<string, MCPServerConfig>;
    blockedServerNames: string[];
};
