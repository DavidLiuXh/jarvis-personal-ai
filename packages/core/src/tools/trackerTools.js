/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { TRACKER_ADD_DEPENDENCY_DEFINITION, TRACKER_CREATE_TASK_DEFINITION, TRACKER_GET_TASK_DEFINITION, TRACKER_LIST_TASKS_DEFINITION, TRACKER_UPDATE_TASK_DEFINITION, TRACKER_VISUALIZE_DEFINITION, } from './definitions/trackerTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import { TRACKER_ADD_DEPENDENCY_TOOL_NAME, TRACKER_CREATE_TASK_TOOL_NAME, TRACKER_GET_TASK_TOOL_NAME, TRACKER_LIST_TASKS_TOOL_NAME, TRACKER_UPDATE_TASK_TOOL_NAME, TRACKER_VISUALIZE_TOOL_NAME, } from './tool-names.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { TaskStatus } from '../services/trackerTypes.js';
class TrackerCreateTaskInvocation extends BaseToolInvocation {
    config;
    constructor(config, params, messageBus, toolName) {
        super(params, messageBus, toolName);
        this.config = config;
    }
    get service() {
        return this.config.getTrackerService();
    }
    getDescription() {
        return `Creating task: ${this.params.title}`;
    }
    async execute(_signal) {
        try {
            const task = await this.service.createTask({
                title: this.params.title,
                description: this.params.description,
                type: this.params.type,
                status: TaskStatus.OPEN,
                parentId: this.params.parentId,
                dependencies: this.params.dependencies ?? [],
            });
            return {
                llmContent: `Created task ${task.id}: ${task.title}`,
                returnDisplay: `Created task ${task.id}.`,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                llmContent: `Error creating task: ${errorMessage}`,
                returnDisplay: 'Failed to create task.',
                error: {
                    message: errorMessage,
                    type: ToolErrorType.EXECUTION_FAILED,
                },
            };
        }
    }
}
export class TrackerCreateTaskTool extends BaseDeclarativeTool {
    config;
    static Name = TRACKER_CREATE_TASK_TOOL_NAME;
    constructor(config, messageBus) {
        super(TrackerCreateTaskTool.Name, 'Create Task', TRACKER_CREATE_TASK_DEFINITION.base.description, Kind.Edit, TRACKER_CREATE_TASK_DEFINITION.base.parametersJsonSchema, messageBus);
        this.config = config;
    }
    createInvocation(params, messageBus) {
        return new TrackerCreateTaskInvocation(this.config, params, messageBus, this.name);
    }
    getSchema(modelId) {
        return resolveToolDeclaration(TRACKER_CREATE_TASK_DEFINITION, modelId);
    }
}
class TrackerUpdateTaskInvocation extends BaseToolInvocation {
    config;
    constructor(config, params, messageBus, toolName) {
        super(params, messageBus, toolName);
        this.config = config;
    }
    get service() {
        return this.config.getTrackerService();
    }
    getDescription() {
        return `Updating task ${this.params.id}`;
    }
    async execute(_signal) {
        const { id, ...updates } = this.params;
        try {
            const task = await this.service.updateTask(id, updates);
            return {
                llmContent: `Updated task ${task.id}. Status: ${task.status}`,
                returnDisplay: `Updated task ${task.id}.`,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                llmContent: `Error updating task: ${errorMessage}`,
                returnDisplay: 'Failed to update task.',
                error: {
                    message: errorMessage,
                    type: ToolErrorType.EXECUTION_FAILED,
                },
            };
        }
    }
}
export class TrackerUpdateTaskTool extends BaseDeclarativeTool {
    config;
    static Name = TRACKER_UPDATE_TASK_TOOL_NAME;
    constructor(config, messageBus) {
        super(TrackerUpdateTaskTool.Name, 'Update Task', TRACKER_UPDATE_TASK_DEFINITION.base.description, Kind.Edit, TRACKER_UPDATE_TASK_DEFINITION.base.parametersJsonSchema, messageBus);
        this.config = config;
    }
    createInvocation(params, messageBus) {
        return new TrackerUpdateTaskInvocation(this.config, params, messageBus, this.name);
    }
    getSchema(modelId) {
        return resolveToolDeclaration(TRACKER_UPDATE_TASK_DEFINITION, modelId);
    }
}
class TrackerGetTaskInvocation extends BaseToolInvocation {
    config;
    constructor(config, params, messageBus, toolName) {
        super(params, messageBus, toolName);
        this.config = config;
    }
    get service() {
        return this.config.getTrackerService();
    }
    getDescription() {
        return `Retrieving task ${this.params.id}`;
    }
    async execute(_signal) {
        const task = await this.service.getTask(this.params.id);
        if (!task) {
            return {
                llmContent: `Task ${this.params.id} not found.`,
                returnDisplay: 'Task not found.',
            };
        }
        return {
            llmContent: JSON.stringify(task, null, 2),
            returnDisplay: `Retrieved task ${task.id}.`,
        };
    }
}
export class TrackerGetTaskTool extends BaseDeclarativeTool {
    config;
    static Name = TRACKER_GET_TASK_TOOL_NAME;
    constructor(config, messageBus) {
        super(TrackerGetTaskTool.Name, 'Get Task', TRACKER_GET_TASK_DEFINITION.base.description, Kind.Read, TRACKER_GET_TASK_DEFINITION.base.parametersJsonSchema, messageBus);
        this.config = config;
    }
    createInvocation(params, messageBus) {
        return new TrackerGetTaskInvocation(this.config, params, messageBus, this.name);
    }
    getSchema(modelId) {
        return resolveToolDeclaration(TRACKER_GET_TASK_DEFINITION, modelId);
    }
}
class TrackerListTasksInvocation extends BaseToolInvocation {
    config;
    constructor(config, params, messageBus, toolName) {
        super(params, messageBus, toolName);
        this.config = config;
    }
    get service() {
        return this.config.getTrackerService();
    }
    getDescription() {
        return 'Listing tasks.';
    }
    async execute(_signal) {
        let tasks = await this.service.listTasks();
        if (this.params.status) {
            tasks = tasks.filter((t) => t.status === this.params.status);
        }
        if (this.params.type) {
            tasks = tasks.filter((t) => t.type === this.params.type);
        }
        if (this.params.parentId) {
            tasks = tasks.filter((t) => t.parentId === this.params.parentId);
        }
        if (tasks.length === 0) {
            return {
                llmContent: 'No tasks found matching the criteria.',
                returnDisplay: 'No matching tasks.',
            };
        }
        const content = tasks
            .map((t) => `- [${t.id}] ${t.title} (${t.status})`)
            .join('\n');
        return {
            llmContent: content,
            returnDisplay: `Listed ${tasks.length} tasks.`,
        };
    }
}
export class TrackerListTasksTool extends BaseDeclarativeTool {
    config;
    static Name = TRACKER_LIST_TASKS_TOOL_NAME;
    constructor(config, messageBus) {
        super(TrackerListTasksTool.Name, 'List Tasks', TRACKER_LIST_TASKS_DEFINITION.base.description, Kind.Search, TRACKER_LIST_TASKS_DEFINITION.base.parametersJsonSchema, messageBus);
        this.config = config;
    }
    createInvocation(params, messageBus) {
        return new TrackerListTasksInvocation(this.config, params, messageBus, this.name);
    }
    getSchema(modelId) {
        return resolveToolDeclaration(TRACKER_LIST_TASKS_DEFINITION, modelId);
    }
}
class TrackerAddDependencyInvocation extends BaseToolInvocation {
    config;
    constructor(config, params, messageBus, toolName) {
        super(params, messageBus, toolName);
        this.config = config;
    }
    get service() {
        return this.config.getTrackerService();
    }
    getDescription() {
        return `Adding dependency: ${this.params.taskId} depends on ${this.params.dependencyId}`;
    }
    async execute(_signal) {
        if (this.params.taskId === this.params.dependencyId) {
            return {
                llmContent: `Error: Task ${this.params.taskId} cannot depend on itself.`,
                returnDisplay: 'Self-referential dependency rejected.',
                error: {
                    message: 'Task cannot depend on itself',
                    type: ToolErrorType.EXECUTION_FAILED,
                },
            };
        }
        const [task, dep] = await Promise.all([
            this.service.getTask(this.params.taskId),
            this.service.getTask(this.params.dependencyId),
        ]);
        if (!task) {
            return {
                llmContent: `Task ${this.params.taskId} not found.`,
                returnDisplay: 'Task not found.',
            };
        }
        if (!dep) {
            return {
                llmContent: `Dependency task ${this.params.dependencyId} not found.`,
                returnDisplay: 'Dependency not found.',
            };
        }
        const newDeps = Array.from(new Set([...task.dependencies, this.params.dependencyId]));
        try {
            await this.service.updateTask(task.id, { dependencies: newDeps });
            return {
                llmContent: `Linked ${task.id} -> ${dep.id}.`,
                returnDisplay: 'Dependency added.',
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                llmContent: `Error adding dependency: ${errorMessage}`,
                returnDisplay: 'Failed to add dependency.',
                error: {
                    message: errorMessage,
                    type: ToolErrorType.EXECUTION_FAILED,
                },
            };
        }
    }
}
export class TrackerAddDependencyTool extends BaseDeclarativeTool {
    config;
    static Name = TRACKER_ADD_DEPENDENCY_TOOL_NAME;
    constructor(config, messageBus) {
        super(TrackerAddDependencyTool.Name, 'Add Dependency', TRACKER_ADD_DEPENDENCY_DEFINITION.base.description, Kind.Edit, TRACKER_ADD_DEPENDENCY_DEFINITION.base.parametersJsonSchema, messageBus);
        this.config = config;
    }
    createInvocation(params, messageBus) {
        return new TrackerAddDependencyInvocation(this.config, params, messageBus, this.name);
    }
    getSchema(modelId) {
        return resolveToolDeclaration(TRACKER_ADD_DEPENDENCY_DEFINITION, modelId);
    }
}
// --- tracker_visualize ---
class TrackerVisualizeInvocation extends BaseToolInvocation {
    config;
    constructor(config, params, messageBus, toolName) {
        super(params, messageBus, toolName);
        this.config = config;
    }
    get service() {
        return this.config.getTrackerService();
    }
    getDescription() {
        return 'Visualizing the task graph.';
    }
    async execute(_signal) {
        const tasks = await this.service.listTasks();
        if (tasks.length === 0) {
            return {
                llmContent: 'No tasks to visualize.',
                returnDisplay: 'Empty tracker.',
            };
        }
        const statusEmojis = {
            open: '⭕',
            in_progress: '🚧',
            blocked: '🚫',
            closed: '✅',
        };
        const typeLabels = {
            epic: '[EPIC]',
            task: '[TASK]',
            bug: '[BUG]',
        };
        const childrenMap = new Map();
        const roots = [];
        for (const task of tasks) {
            if (task.parentId) {
                if (!childrenMap.has(task.parentId)) {
                    childrenMap.set(task.parentId, []);
                }
                childrenMap.get(task.parentId).push(task);
            }
            else {
                roots.push(task);
            }
        }
        let output = 'Task Tracker Graph:\n';
        const renderTask = (task, depth, visited) => {
            if (visited.has(task.id)) {
                output += `${'  '.repeat(depth)}[CYCLE DETECTED: ${task.id}]\n`;
                return;
            }
            visited.add(task.id);
            const indent = '  '.repeat(depth);
            output += `${indent}${statusEmojis[task.status]} ${task.id} ${typeLabels[task.type]} ${task.title}\n`;
            if (task.dependencies.length > 0) {
                output += `${indent}  └─ Depends on: ${task.dependencies.join(', ')}\n`;
            }
            const children = childrenMap.get(task.id) ?? [];
            for (const child of children) {
                renderTask(child, depth + 1, new Set(visited));
            }
        };
        for (const root of roots) {
            renderTask(root, 0, new Set());
        }
        return {
            llmContent: output,
            returnDisplay: 'Graph rendered.',
        };
    }
}
export class TrackerVisualizeTool extends BaseDeclarativeTool {
    config;
    static Name = TRACKER_VISUALIZE_TOOL_NAME;
    constructor(config, messageBus) {
        super(TrackerVisualizeTool.Name, 'Visualize Tracker', TRACKER_VISUALIZE_DEFINITION.base.description, Kind.Read, TRACKER_VISUALIZE_DEFINITION.base.parametersJsonSchema, messageBus);
        this.config = config;
    }
    createInvocation(params, messageBus) {
        return new TrackerVisualizeInvocation(this.config, params, messageBus, this.name);
    }
    getSchema(modelId) {
        return resolveToolDeclaration(TRACKER_VISUALIZE_DEFINITION, modelId);
    }
}
//# sourceMappingURL=trackerTools.js.map