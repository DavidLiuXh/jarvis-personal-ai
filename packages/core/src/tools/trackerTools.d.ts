/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation } from './tools.js';
import type { TaskType } from '../services/trackerTypes.js';
import { TaskStatus } from '../services/trackerTypes.js';
interface CreateTaskParams {
    title: string;
    description: string;
    type: TaskType;
    parentId?: string;
    dependencies?: string[];
}
declare class TrackerCreateTaskInvocation extends BaseToolInvocation<CreateTaskParams, ToolResult> {
    private readonly config;
    constructor(config: Config, params: CreateTaskParams, messageBus: MessageBus, toolName: string);
    private get service();
    getDescription(): string;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
export declare class TrackerCreateTaskTool extends BaseDeclarativeTool<CreateTaskParams, ToolResult> {
    private config;
    static readonly Name = "tracker_create_task";
    constructor(config: Config, messageBus: MessageBus);
    protected createInvocation(params: CreateTaskParams, messageBus: MessageBus): TrackerCreateTaskInvocation;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
interface UpdateTaskParams {
    id: string;
    title?: string;
    description?: string;
    status?: TaskStatus;
    dependencies?: string[];
}
declare class TrackerUpdateTaskInvocation extends BaseToolInvocation<UpdateTaskParams, ToolResult> {
    private readonly config;
    constructor(config: Config, params: UpdateTaskParams, messageBus: MessageBus, toolName: string);
    private get service();
    getDescription(): string;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
export declare class TrackerUpdateTaskTool extends BaseDeclarativeTool<UpdateTaskParams, ToolResult> {
    private config;
    static readonly Name = "tracker_update_task";
    constructor(config: Config, messageBus: MessageBus);
    protected createInvocation(params: UpdateTaskParams, messageBus: MessageBus): TrackerUpdateTaskInvocation;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
interface GetTaskParams {
    id: string;
}
declare class TrackerGetTaskInvocation extends BaseToolInvocation<GetTaskParams, ToolResult> {
    private readonly config;
    constructor(config: Config, params: GetTaskParams, messageBus: MessageBus, toolName: string);
    private get service();
    getDescription(): string;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
export declare class TrackerGetTaskTool extends BaseDeclarativeTool<GetTaskParams, ToolResult> {
    private config;
    static readonly Name = "tracker_get_task";
    constructor(config: Config, messageBus: MessageBus);
    protected createInvocation(params: GetTaskParams, messageBus: MessageBus): TrackerGetTaskInvocation;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
interface ListTasksParams {
    status?: TaskStatus;
    type?: TaskType;
    parentId?: string;
}
declare class TrackerListTasksInvocation extends BaseToolInvocation<ListTasksParams, ToolResult> {
    private readonly config;
    constructor(config: Config, params: ListTasksParams, messageBus: MessageBus, toolName: string);
    private get service();
    getDescription(): string;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
export declare class TrackerListTasksTool extends BaseDeclarativeTool<ListTasksParams, ToolResult> {
    private config;
    static readonly Name = "tracker_list_tasks";
    constructor(config: Config, messageBus: MessageBus);
    protected createInvocation(params: ListTasksParams, messageBus: MessageBus): TrackerListTasksInvocation;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
interface AddDependencyParams {
    taskId: string;
    dependencyId: string;
}
declare class TrackerAddDependencyInvocation extends BaseToolInvocation<AddDependencyParams, ToolResult> {
    private readonly config;
    constructor(config: Config, params: AddDependencyParams, messageBus: MessageBus, toolName: string);
    private get service();
    getDescription(): string;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
export declare class TrackerAddDependencyTool extends BaseDeclarativeTool<AddDependencyParams, ToolResult> {
    private config;
    static readonly Name = "tracker_add_dependency";
    constructor(config: Config, messageBus: MessageBus);
    protected createInvocation(params: AddDependencyParams, messageBus: MessageBus): TrackerAddDependencyInvocation;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
declare class TrackerVisualizeInvocation extends BaseToolInvocation<Record<string, never>, ToolResult> {
    private readonly config;
    constructor(config: Config, params: Record<string, never>, messageBus: MessageBus, toolName: string);
    private get service();
    getDescription(): string;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
export declare class TrackerVisualizeTool extends BaseDeclarativeTool<Record<string, never>, ToolResult> {
    private config;
    static readonly Name = "tracker_visualize";
    constructor(config: Config, messageBus: MessageBus);
    protected createInvocation(params: Record<string, never>, messageBus: MessageBus): TrackerVisualizeInvocation;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
export {};
