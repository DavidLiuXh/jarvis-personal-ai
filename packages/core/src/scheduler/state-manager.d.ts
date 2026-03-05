/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { CoreToolCallStatus, type ToolCall, type CompletedToolCall, type ExecutingToolCall, type ToolCallResponseInfo } from './types.js';
import type { ToolConfirmationOutcome, AnyToolInvocation, ToolCallConfirmationDetails } from '../tools/tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { type SerializableConfirmationDetails } from '../confirmation-bus/types.js';
/**
 * Handler for terminal tool calls.
 */
export type TerminalCallHandler = (call: CompletedToolCall) => void;
/**
 * Manages the state of tool calls.
 * Publishes state changes to the MessageBus via TOOL_CALLS_UPDATE events.
 */
export declare class SchedulerStateManager {
    private readonly messageBus;
    private readonly schedulerId;
    private readonly onTerminalCall?;
    private readonly activeCalls;
    private readonly queue;
    private _completedBatch;
    constructor(messageBus: MessageBus, schedulerId?: string, onTerminalCall?: TerminalCallHandler | undefined);
    addToolCalls(calls: ToolCall[]): void;
    getToolCall(callId: string): ToolCall | undefined;
    enqueue(calls: ToolCall[]): void;
    dequeue(): ToolCall | undefined;
    peekQueue(): ToolCall | undefined;
    get isActive(): boolean;
    get allActiveCalls(): ToolCall[];
    get activeCallCount(): number;
    get queueLength(): number;
    get firstActiveCall(): ToolCall | undefined;
    /**
     * Updates the status of a tool call with specific auxiliary data required for certain states.
     */
    updateStatus(callId: string, status: CoreToolCallStatus.Success, data: ToolCallResponseInfo): void;
    updateStatus(callId: string, status: CoreToolCallStatus.Error, data: ToolCallResponseInfo): void;
    updateStatus(callId: string, status: CoreToolCallStatus.AwaitingApproval, data: ToolCallConfirmationDetails | {
        correlationId: string;
        confirmationDetails: SerializableConfirmationDetails;
    }): void;
    updateStatus(callId: string, status: CoreToolCallStatus.Cancelled, data: string | ToolCallResponseInfo): void;
    updateStatus(callId: string, status: CoreToolCallStatus.Executing, data?: Partial<ExecutingToolCall>): void;
    updateStatus(callId: string, status: CoreToolCallStatus.Scheduled | CoreToolCallStatus.Validating): void;
    finalizeCall(callId: string): void;
    updateArgs(callId: string, newArgs: Record<string, unknown>, newInvocation: AnyToolInvocation): void;
    setOutcome(callId: string, outcome: ToolConfirmationOutcome): void;
    /**
     * Replaces the currently active call with a new call, placing the new call
     * at the front of the queue to be processed immediately in the next tick.
     * Used for Tail Calls to chain execution without finalizing the original call.
     */
    replaceActiveCallWithTailCall(callId: string, nextCall: ToolCall): void;
    cancelAllQueued(reason: string): void;
    getSnapshot(): ToolCall[];
    clearBatch(): void;
    get completedBatch(): CompletedToolCall[];
    private emitUpdate;
    private isTerminalCall;
    private transitionCall;
    private isExecutingToolCallPatch;
    /**
     * Ensures the tool call has an associated tool and invocation before
     * transitioning to states that require them.
     */
    private validateHasToolAndInvocation;
    private toSuccess;
    private toError;
    private toAwaitingApproval;
    private isEventDrivenApprovalData;
    private toScheduled;
    private toCancelled;
    private isWaitingToolCall;
    private patchCall;
    private toValidating;
    private toExecuting;
}
