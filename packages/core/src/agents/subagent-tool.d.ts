/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, type ToolInvocation, type ToolResult } from '../tools/tools.js';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { AgentDefinition, AgentInputs } from './types.js';
export declare class SubagentTool extends BaseDeclarativeTool<AgentInputs, ToolResult> {
    private readonly definition;
    private readonly config;
    constructor(definition: AgentDefinition, config: Config, messageBus: MessageBus);
    private _memoizedIsReadOnly;
    get isReadOnly(): boolean;
    private static checkIsReadOnly;
    protected createInvocation(params: AgentInputs, messageBus: MessageBus, _toolName?: string, _toolDisplayName?: string): ToolInvocation<AgentInputs, ToolResult>;
}
