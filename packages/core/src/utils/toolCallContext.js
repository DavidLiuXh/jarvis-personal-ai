/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { AsyncLocalStorage } from 'node:async_hooks';
/**
 * AsyncLocalStorage instance for tool call context.
 */
const toolCallContext = new AsyncLocalStorage();
/**
 * Runs a function within a tool call context.
 *
 * @param context The context to set.
 * @param fn The function to run.
 * @returns The result of the function.
 */
export function runWithToolCallContext(context, fn) {
    return toolCallContext.run(context, fn);
}
/**
 * Retrieves the current tool call context.
 *
 * @returns The current ToolCallContext, or undefined if not in a context.
 */
export function getToolCallContext() {
    return toolCallContext.getStore();
}
//# sourceMappingURL=toolCallContext.js.map