/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import type { ToolResult, AnyDeclarativeTool, AnyToolInvocation, ToolLiveOutput } from '../tools/tools.js';
import type { ShellExecutionConfig } from '../index.js';
import { ShellToolInvocation } from '../tools/shell.js';
/**
 * Execute a tool with BeforeTool and AfterTool hooks.
 *
 * @param invocation The tool invocation to execute
 * @param toolName The name of the tool
 * @param signal Abort signal for cancellation
 * @param liveOutputCallback Optional callback for live output updates
 * @param shellExecutionConfig Optional shell execution config
 * @param setPidCallback Optional callback to set the PID for shell invocations
 * @param config Config to look up MCP server details for hook context
 * @returns The tool result
 */
export declare function executeToolWithHooks(invocation: ShellToolInvocation | AnyToolInvocation, toolName: string, signal: AbortSignal, tool: AnyDeclarativeTool, liveOutputCallback?: (outputChunk: ToolLiveOutput) => void, shellExecutionConfig?: ShellExecutionConfig, setPidCallback?: (pid: number) => void, config?: Config, originalRequestName?: string): Promise<ToolResult>;
