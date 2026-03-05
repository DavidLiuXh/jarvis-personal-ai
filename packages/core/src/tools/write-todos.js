/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, BaseToolInvocation, Kind, } from './tools.js';
import { WRITE_TODOS_TOOL_NAME } from './tool-names.js';
import { WRITE_TODOS_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
const TODO_STATUSES = [
    'pending',
    'in_progress',
    'completed',
    'cancelled',
];
class WriteTodosToolInvocation extends BaseToolInvocation {
    constructor(params, messageBus, _toolName, _toolDisplayName) {
        super(params, messageBus, _toolName, _toolDisplayName);
    }
    getDescription() {
        const count = this.params.todos?.length ?? 0;
        if (count === 0) {
            return 'Cleared todo list';
        }
        return `Set ${count} todo(s)`;
    }
    async execute(_signal, _updateOutput) {
        const todos = this.params.todos ?? [];
        const todoListString = todos
            .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.description}`)
            .join('\n');
        const llmContent = todos.length > 0
            ? `Successfully updated the todo list. The current list is now:\n${todoListString}`
            : 'Successfully cleared the todo list.';
        return {
            llmContent,
            returnDisplay: { todos },
        };
    }
}
export class WriteTodosTool extends BaseDeclarativeTool {
    static Name = WRITE_TODOS_TOOL_NAME;
    constructor(messageBus) {
        super(WriteTodosTool.Name, 'WriteTodos', WRITE_TODOS_DEFINITION.base.description, Kind.Other, WRITE_TODOS_DEFINITION.base.parametersJsonSchema, messageBus, true, // isOutputMarkdown
        false);
    }
    getSchema(modelId) {
        return resolveToolDeclaration(WRITE_TODOS_DEFINITION, modelId);
    }
    validateToolParamValues(params) {
        const todos = params?.todos;
        if (!params || !Array.isArray(todos)) {
            return '`todos` parameter must be an array';
        }
        for (const todo of todos) {
            if (typeof todo !== 'object' || todo === null) {
                return 'Each todo item must be an object';
            }
            if (typeof todo.description !== 'string' || !todo.description.trim()) {
                return 'Each todo must have a non-empty description string';
            }
            if (!TODO_STATUSES.includes(todo.status)) {
                return `Each todo must have a valid status (${TODO_STATUSES.join(', ')})`;
            }
        }
        const inProgressCount = todos.filter((todo) => todo.status === 'in_progress').length;
        if (inProgressCount > 1) {
            return 'Invalid parameters: Only one task can be "in_progress" at a time.';
        }
        return null;
    }
    createInvocation(params, messageBus, _toolName, _displayName) {
        return new WriteTodosToolInvocation(params, messageBus, _toolName, _displayName);
    }
}
//# sourceMappingURL=write-todos.js.map