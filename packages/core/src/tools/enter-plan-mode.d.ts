/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, BaseToolInvocation, type ToolResult, type ToolInfoConfirmationDetails } from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Config } from '../config/config.js';
export interface EnterPlanModeParams {
    reason?: string;
}
export declare class EnterPlanModeTool extends BaseDeclarativeTool<EnterPlanModeParams, ToolResult> {
    private config;
    static readonly Name = "enter_plan_mode";
    constructor(config: Config, messageBus: MessageBus);
    protected createInvocation(params: EnterPlanModeParams, messageBus: MessageBus, toolName: string, toolDisplayName: string): EnterPlanModeInvocation;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
export declare class EnterPlanModeInvocation extends BaseToolInvocation<EnterPlanModeParams, ToolResult> {
    private config;
    private confirmationOutcome;
    constructor(params: EnterPlanModeParams, messageBus: MessageBus, toolName: string, toolDisplayName: string, config: Config);
    getDescription(): string;
    shouldConfirmExecute(abortSignal: AbortSignal): Promise<ToolInfoConfirmationDetails | false>;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
