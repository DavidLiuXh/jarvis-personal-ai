/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type AnyDeclarativeTool, type AnyToolInvocation } from '../index.js';
import { ApprovalMode } from '../policy/types.js';
import { CoreToolCallStatus, type ToolCallResponseInfo } from '../scheduler/types.js';
/**
 * Validates if an object is a ToolCallResponseInfo.
 */
export declare function isToolCallResponseInfo(data: unknown): data is ToolCallResponseInfo;
/**
 * Options for determining if a tool call should be hidden in the CLI history.
 */
export interface ShouldHideToolCallParams {
    /** The display name of the tool. */
    displayName: string;
    /** The current status of the tool call. */
    status: CoreToolCallStatus;
    /** The approval mode active when the tool was called. */
    approvalMode?: ApprovalMode;
    /** Whether the tool has produced a result for display. */
    hasResultDisplay: boolean;
    /** The ID of the parent tool call, if any. */
    parentCallId?: string;
}
/**
 * Determines if a tool call should be hidden from the standard tool history UI.
 *
 * We hide tools in several cases:
 * 1. Tool calls that have a parent, as they are "internal" to another tool (e.g. subagent).
 * 2. Ask User tools that are in progress, displayed via specialized UI.
 * 3. Ask User tools that errored without result display, typically param
 *    validation errors that the agent automatically recovers from.
 * 4. WriteFile and Edit tools when in Plan Mode, redundant because the
 *    resulting plans are displayed separately upon exiting plan mode.
 */
export declare function shouldHideToolCall(params: ShouldHideToolCallParams): boolean;
/**
 * Generates a suggestion string for a tool name that was not found in the registry.
 * It finds the closest matches based on Levenshtein distance.
 * @param unknownToolName The tool name that was not found.
 * @param allToolNames The list of all available tool names.
 * @param topN The number of suggestions to return. Defaults to 3.
 * @returns A suggestion string like " Did you mean 'tool'?" or " Did you mean one of: 'tool1', 'tool2'?", or an empty string if no suggestions are found.
 */
export declare function getToolSuggestion(unknownToolName: string, allToolNames: string[], topN?: number): string;
/**
 * Checks if a tool invocation matches any of a list of patterns.
 *
 * @param toolOrToolName The tool object or the name of the tool being invoked.
 * @param invocation The invocation object for the tool or the command invoked.
 * @param patterns A list of patterns to match against.
 *   Patterns can be:
 *   - A tool name (e.g., "ReadFileTool") to match any invocation of that tool.
 *   - A tool name with a prefix (e.g., "ShellTool(git status)") to match
 *     invocations where the arguments start with that prefix.
 * @returns True if the invocation matches any pattern, false otherwise.
 */
export declare function doesToolInvocationMatch(toolOrToolName: AnyDeclarativeTool | string, invocation: AnyToolInvocation | string, patterns: string[]): boolean;
