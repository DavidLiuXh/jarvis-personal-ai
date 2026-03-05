/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, BaseToolInvocation, type ToolResult, type ToolAskUserConfirmationDetails } from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { type Question } from '../confirmation-bus/types.js';
export interface AskUserParams {
    questions: Question[];
}
export declare class AskUserTool extends BaseDeclarativeTool<AskUserParams, ToolResult> {
    static readonly Name = "ask_user";
    constructor(messageBus: MessageBus);
    protected validateToolParamValues(params: AskUserParams): string | null;
    protected createInvocation(params: AskUserParams, messageBus: MessageBus, toolName: string, toolDisplayName: string): AskUserInvocation;
    validateBuildAndExecute(params: AskUserParams, abortSignal: AbortSignal): Promise<ToolResult>;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
}
export declare class AskUserInvocation extends BaseToolInvocation<AskUserParams, ToolResult> {
    private confirmationOutcome;
    private userAnswers;
    shouldConfirmExecute(_abortSignal: AbortSignal): Promise<ToolAskUserConfirmationDetails | false>;
    getDescription(): string;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
/**
 * Returns true if the tool name and status correspond to a completed 'Ask User' tool call.
 */
export declare function isCompletedAskUserTool(name: string, status: string): boolean;
