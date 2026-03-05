/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Contextual information for a tool call execution.
 */
export interface ToolCallContext {
    /** The unique ID of the tool call. */
    callId: string;
    /** The ID of the scheduler managing the execution. */
    schedulerId: string;
    /** The ID of the parent tool call, if this is a nested execution (e.g., in a subagent). */
    parentCallId?: string;
}
/**
 * Runs a function within a tool call context.
 *
 * @param context The context to set.
 * @param fn The function to run.
 * @returns The result of the function.
 */
export declare function runWithToolCallContext<T>(context: ToolCallContext, fn: () => T): T;
/**
 * Retrieves the current tool call context.
 *
 * @returns The current ToolCallContext, or undefined if not in a context.
 */
export declare function getToolCallContext(): ToolCallContext | undefined;
