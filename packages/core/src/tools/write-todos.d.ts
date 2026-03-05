/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, type ToolInvocation, type Todo, type ToolResult } from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
export interface WriteTodosToolParams {
    /**
     * The full list of todos. This will overwrite any existing list.
     */
    todos: Todo[];
}
export declare class WriteTodosTool extends BaseDeclarativeTool<WriteTodosToolParams, ToolResult> {
    static readonly Name = "write_todos";
    constructor(messageBus: MessageBus);
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
    protected validateToolParamValues(params: WriteTodosToolParams): string | null;
    protected createInvocation(params: WriteTodosToolParams, messageBus: MessageBus, _toolName?: string, _displayName?: string): ToolInvocation<WriteTodosToolParams, ToolResult>;
}
