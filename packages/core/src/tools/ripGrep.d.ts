/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { BaseDeclarativeTool, type ToolInvocation, type ToolResult } from './tools.js';
import type { Config } from '../config/config.js';
/**
 * Checks if `rg` exists, if not then attempt to download it.
 */
export declare function canUseRipgrep(): Promise<boolean>;
/**
 * Ensures `rg` is downloaded, or throws.
 */
export declare function ensureRgPath(): Promise<string>;
/**
 * Parameters for the GrepTool
 */
export interface RipGrepToolParams {
    /**
     * The regular expression pattern to search for in file contents
     */
    pattern: string;
    /**
     * The directory to search in (optional, defaults to current directory relative to root)
     */
    dir_path?: string;
    /**
     * File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")
     */
    include_pattern?: string;
    /**
     * Optional: A regular expression pattern to exclude from the search results.
     */
    exclude_pattern?: string;
    /**
     * Optional: If true, only the file paths of the matches will be returned.
     */
    names_only?: boolean;
    /**
     * If true, searches case-sensitively. Defaults to false.
     */
    case_sensitive?: boolean;
    /**
     * If true, treats pattern as a literal string. Defaults to false.
     */
    fixed_strings?: boolean;
    /**
     * Show num lines of context around each match.
     */
    context?: number;
    /**
     * Show num lines after each match.
     */
    after?: number;
    /**
     * Show num lines before each match.
     */
    before?: number;
    /**
     * If true, does not respect .gitignore or default ignores (like build/dist).
     */
    no_ignore?: boolean;
    /**
     * Optional: Maximum number of matches to return per file. Use this to prevent being overwhelmed by repetitive matches in large files.
     */
    max_matches_per_file?: number;
    /**
     * Optional: Maximum number of total matches to return. Use this to limit the overall size of the response. Defaults to 100 if omitted.
     */
    total_max_matches?: number;
}
/**
 * Implementation of the Grep tool logic (moved from CLI)
 */
export declare class RipGrepTool extends BaseDeclarativeTool<RipGrepToolParams, ToolResult> {
    private readonly config;
    static readonly Name = "grep_search";
    private readonly fileDiscoveryService;
    constructor(config: Config, messageBus: MessageBus);
    /**
     * Validates the parameters for the tool
     * @param params Parameters to validate
     * @returns An error message string if invalid, null otherwise
     */
    protected validateToolParamValues(params: RipGrepToolParams): string | null;
    protected createInvocation(params: RipGrepToolParams, messageBus: MessageBus, _toolName?: string, _toolDisplayName?: string): ToolInvocation<RipGrepToolParams, ToolResult>;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
