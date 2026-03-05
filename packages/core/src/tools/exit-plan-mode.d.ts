/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, BaseToolInvocation, type ToolResult, type ToolExitPlanModeConfirmationDetails } from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Config } from '../config/config.js';
export interface ExitPlanModeParams {
    plan_path: string;
}
export declare class ExitPlanModeTool extends BaseDeclarativeTool<ExitPlanModeParams, ToolResult> {
    private config;
    static readonly Name = "exit_plan_mode";
    constructor(config: Config, messageBus: MessageBus);
    protected validateToolParamValues(params: ExitPlanModeParams): string | null;
    protected createInvocation(params: ExitPlanModeParams, messageBus: MessageBus, toolName: string, toolDisplayName: string): ExitPlanModeInvocation;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
export declare class ExitPlanModeInvocation extends BaseToolInvocation<ExitPlanModeParams, ToolResult> {
    private config;
    private confirmationOutcome;
    private approvalPayload;
    private planValidationError;
    constructor(params: ExitPlanModeParams, messageBus: MessageBus, toolName: string, toolDisplayName: string, config: Config);
    shouldConfirmExecute(abortSignal: AbortSignal): Promise<ToolExitPlanModeConfirmationDetails | false>;
    getDescription(): string;
    /**
     * Returns the resolved plan path.
     * Note: Validation is done in validateToolParamValues, so this assumes the path is valid.
     */
    private getResolvedPlanPath;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
