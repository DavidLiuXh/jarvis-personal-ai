/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type PolicyRule, type SafetyCheckerRule } from './types.js';
/**
 * Types of errors that can occur while loading policy files.
 */
export type PolicyFileErrorType = 'file_read' | 'toml_parse' | 'schema_validation' | 'rule_validation' | 'regex_compilation' | 'tool_name_warning';
/**
 * Detailed error information for policy file loading failures.
 */
export interface PolicyFileError {
    filePath: string;
    fileName: string;
    tier: 'default' | 'extension' | 'user' | 'workspace' | 'admin';
    ruleIndex?: number;
    errorType: PolicyFileErrorType;
    message: string;
    details?: string;
    suggestion?: string;
    severity?: 'error' | 'warning';
}
/**
 * Result of loading policies from TOML files.
 */
export interface PolicyLoadResult {
    rules: PolicyRule[];
    checkers: SafetyCheckerRule[];
    errors: PolicyFileError[];
}
export interface PolicyFile {
    path: string;
    content: string;
}
/**
 * Reads policy files from a directory or a single file.
 *
 * @param policyPath Path to a directory or a .toml file.
 * @returns Array of PolicyFile objects.
 */
export declare function readPolicyFiles(policyPath: string): Promise<PolicyFile[]>;
/**
 * Loads and parses policies from TOML files in the specified paths (directories or individual files).
 *
 * This function:
 * 1. Scans paths for .toml files (if directory) or processes individual files
 * 2. Parses and validates each file
 * 3. Transforms rules (commandPrefix, arrays, mcpName, priorities)
 * 4. Collects detailed error information for any failures
 *
 * @param policyPaths Array of paths (directories or files) to scan for policy files
 * @param getPolicyTier Function to determine tier (1-4) for a path
 * @returns Object containing successfully parsed rules and any errors encountered
 */
export declare function loadPoliciesFromToml(policyPaths: string[], getPolicyTier: (path: string) => number): Promise<PolicyLoadResult>;
/**
 * Validates MCP tool names in policy rules against actually discovered MCP tools.
 * Called after an MCP server connects and its tools are discovered.
 *
 * For each policy rule that references the given MCP server, checks if the
 * tool name matches any discovered tool. Emits warnings for likely typos
 * using Levenshtein distance.
 *
 * @param serverName The MCP server name (e.g., "google-workspace")
 * @param discoveredToolNames The tool names discovered from this server (simple names, not fully qualified)
 * @param policyRules The current set of policy rules to validate against
 * @returns Array of warning messages for unrecognized MCP tool names
 */
export declare function validateMcpPolicyToolNames(serverName: string, discoveredToolNames: string[], policyRules: ReadonlyArray<{
    toolName?: string;
    source?: string;
}>): string[];
