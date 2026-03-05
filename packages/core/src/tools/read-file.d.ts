/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { BaseDeclarativeTool, type ToolInvocation, type ToolResult } from './tools.js';
import type { Config } from '../config/config.js';
/**
 * Parameters for the ReadFile tool
 */
export interface ReadFileToolParams {
    /**
     * The path to the file to read
     */
    file_path: string;
    /**
     * The line number to start reading from (optional, 1-based)
     */
    start_line?: number;
    /**
     * The line number to end reading at (optional, 1-based, inclusive)
     */
    end_line?: number;
}
/**
 * Implementation of the ReadFile tool logic
 */
export declare class ReadFileTool extends BaseDeclarativeTool<ReadFileToolParams, ToolResult> {
    private config;
    static readonly Name = "read_file";
    private readonly fileDiscoveryService;
    constructor(config: Config, messageBus: MessageBus);
    protected validateToolParamValues(params: ReadFileToolParams): string | null;
    protected createInvocation(params: ReadFileToolParams, messageBus: MessageBus, _toolName?: string, _toolDisplayName?: string): ToolInvocation<ReadFileToolParams, ToolResult>;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
