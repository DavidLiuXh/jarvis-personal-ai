/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { CoreToolCallStatus, ROOT_SCHEDULER_ID, } from './types.js';
import { MessageBusType, } from '../confirmation-bus/types.js';
import { isToolCallResponseInfo } from '../utils/tool-utils.js';
/**
 * Manages the state of tool calls.
 * Publishes state changes to the MessageBus via TOOL_CALLS_UPDATE events.
 */
export class SchedulerStateManager {
    messageBus;
    schedulerId;
    onTerminalCall;
    activeCalls = new Map();
    queue = [];
    _completedBatch = [];
    constructor(messageBus, schedulerId = ROOT_SCHEDULER_ID, onTerminalCall) {
        this.messageBus = messageBus;
        this.schedulerId = schedulerId;
        this.onTerminalCall = onTerminalCall;
    }
    addToolCalls(calls) {
        this.enqueue(calls);
    }
    getToolCall(callId) {
        return (this.activeCalls.get(callId) ||
            this.queue.find((c) => c.request.callId === callId) ||
            this._completedBatch.find((c) => c.request.callId === callId));
    }
    enqueue(calls) {
        this.queue.push(...calls);
        this.emitUpdate();
    }
    dequeue() {
        const next = this.queue.shift();
        if (next) {
            this.activeCalls.set(next.request.callId, next);
            this.emitUpdate();
        }
        return next;
    }
    peekQueue() {
        return this.queue[0];
    }
    get isActive() {
        return this.activeCalls.size > 0;
    }
    get allActiveCalls() {
        return Array.from(this.activeCalls.values());
    }
    get activeCallCount() {
        return this.activeCalls.size;
    }
    get queueLength() {
        return this.queue.length;
    }
    get firstActiveCall() {
        return this.activeCalls.values().next().value;
    }
    updateStatus(callId, status, auxiliaryData) {
        const call = this.activeCalls.get(callId);
        if (!call)
            return;
        const updatedCall = this.transitionCall(call, status, auxiliaryData);
        this.activeCalls.set(callId, updatedCall);
        this.emitUpdate();
    }
    finalizeCall(callId) {
        const call = this.activeCalls.get(callId);
        if (!call)
            return;
        if (this.isTerminalCall(call)) {
            this._completedBatch.push(call);
            this.activeCalls.delete(callId);
            this.onTerminalCall?.(call);
            this.emitUpdate();
        }
    }
    updateArgs(callId, newArgs, newInvocation) {
        const call = this.activeCalls.get(callId);
        if (!call || call.status === CoreToolCallStatus.Error)
            return;
        this.activeCalls.set(callId, this.patchCall(call, {
            request: { ...call.request, args: newArgs },
            invocation: newInvocation,
        }));
        this.emitUpdate();
    }
    setOutcome(callId, outcome) {
        const call = this.activeCalls.get(callId);
        if (!call)
            return;
        this.activeCalls.set(callId, this.patchCall(call, { outcome }));
        this.emitUpdate();
    }
    /**
     * Replaces the currently active call with a new call, placing the new call
     * at the front of the queue to be processed immediately in the next tick.
     * Used for Tail Calls to chain execution without finalizing the original call.
     */
    replaceActiveCallWithTailCall(callId, nextCall) {
        if (this.activeCalls.has(callId)) {
            this.activeCalls.delete(callId);
            this.queue.unshift(nextCall);
            this.emitUpdate();
        }
    }
    cancelAllQueued(reason) {
        if (this.queue.length === 0) {
            return;
        }
        while (this.queue.length > 0) {
            const queuedCall = this.queue.shift();
            if (queuedCall.status === CoreToolCallStatus.Error) {
                this._completedBatch.push(queuedCall);
                this.onTerminalCall?.(queuedCall);
                continue;
            }
            const cancelledCall = this.toCancelled(queuedCall, reason);
            this._completedBatch.push(cancelledCall);
            this.onTerminalCall?.(cancelledCall);
        }
        this.emitUpdate();
    }
    getSnapshot() {
        return [
            ...this._completedBatch,
            ...Array.from(this.activeCalls.values()),
            ...this.queue,
        ];
    }
    clearBatch() {
        if (this._completedBatch.length === 0)
            return;
        this._completedBatch = [];
        this.emitUpdate();
    }
    get completedBatch() {
        return [...this._completedBatch];
    }
    emitUpdate() {
        const snapshot = this.getSnapshot();
        // Fire and forget - The message bus handles the publish and error handling.
        void this.messageBus.publish({
            type: MessageBusType.TOOL_CALLS_UPDATE,
            toolCalls: snapshot,
            schedulerId: this.schedulerId,
        });
    }
    isTerminalCall(call) {
        const { status } = call;
        return (status === CoreToolCallStatus.Success ||
            status === CoreToolCallStatus.Error ||
            status === CoreToolCallStatus.Cancelled);
    }
    transitionCall(call, newStatus, auxiliaryData) {
        switch (newStatus) {
            case CoreToolCallStatus.Success: {
                if (!isToolCallResponseInfo(auxiliaryData)) {
                    throw new Error(`Invalid data for 'success' transition (callId: ${call.request.callId})`);
                }
                return this.toSuccess(call, auxiliaryData);
            }
            case CoreToolCallStatus.Error: {
                if (!isToolCallResponseInfo(auxiliaryData)) {
                    throw new Error(`Invalid data for 'error' transition (callId: ${call.request.callId})`);
                }
                return this.toError(call, auxiliaryData);
            }
            case CoreToolCallStatus.AwaitingApproval: {
                if (!auxiliaryData) {
                    throw new Error(`Missing data for 'awaiting_approval' transition (callId: ${call.request.callId})`);
                }
                return this.toAwaitingApproval(call, auxiliaryData);
            }
            case CoreToolCallStatus.Scheduled:
                return this.toScheduled(call);
            case CoreToolCallStatus.Cancelled: {
                if (typeof auxiliaryData !== 'string' &&
                    !isToolCallResponseInfo(auxiliaryData)) {
                    throw new Error(`Invalid reason (string) or response for 'cancelled' transition (callId: ${call.request.callId})`);
                }
                return this.toCancelled(call, auxiliaryData);
            }
            case CoreToolCallStatus.Validating:
                return this.toValidating(call);
            case CoreToolCallStatus.Executing: {
                if (auxiliaryData !== undefined &&
                    !this.isExecutingToolCallPatch(auxiliaryData)) {
                    throw new Error(`Invalid patch for 'executing' transition (callId: ${call.request.callId})`);
                }
                return this.toExecuting(call, auxiliaryData);
            }
            default: {
                const exhaustiveCheck = newStatus;
                return exhaustiveCheck;
            }
        }
    }
    isExecutingToolCallPatch(data) {
        // A partial can be an empty object, but it must be a non-null object.
        return typeof data === 'object' && data !== null;
    }
    // --- Transition Helpers ---
    /**
     * Ensures the tool call has an associated tool and invocation before
     * transitioning to states that require them.
     */
    validateHasToolAndInvocation(call, targetStatus) {
        if (!('tool' in call && call.tool && 'invocation' in call && call.invocation)) {
            throw new Error(`Invalid state transition: cannot transition to ${targetStatus} without tool/invocation (callId: ${call.request.callId})`);
        }
    }
    toSuccess(call, response) {
        this.validateHasToolAndInvocation(call, CoreToolCallStatus.Success);
        const startTime = 'startTime' in call ? call.startTime : undefined;
        return {
            request: call.request,
            tool: call.tool,
            invocation: call.invocation,
            status: CoreToolCallStatus.Success,
            response,
            durationMs: startTime ? Date.now() - startTime : undefined,
            outcome: call.outcome,
            schedulerId: call.schedulerId,
            approvalMode: call.approvalMode,
        };
    }
    toError(call, response) {
        const startTime = 'startTime' in call ? call.startTime : undefined;
        return {
            request: call.request,
            status: CoreToolCallStatus.Error,
            tool: 'tool' in call ? call.tool : undefined,
            response,
            durationMs: startTime ? Date.now() - startTime : undefined,
            outcome: call.outcome,
            schedulerId: call.schedulerId,
            approvalMode: call.approvalMode,
        };
    }
    toAwaitingApproval(call, data) {
        this.validateHasToolAndInvocation(call, CoreToolCallStatus.AwaitingApproval);
        let confirmationDetails;
        let correlationId;
        if (this.isEventDrivenApprovalData(data)) {
            correlationId = data.correlationId;
            confirmationDetails = data.confirmationDetails;
        }
        else {
            // TODO: Remove legacy callback shape once event-driven migration is complete
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            confirmationDetails = data;
        }
        return {
            request: call.request,
            tool: call.tool,
            status: CoreToolCallStatus.AwaitingApproval,
            correlationId,
            confirmationDetails,
            startTime: 'startTime' in call ? call.startTime : undefined,
            outcome: call.outcome,
            invocation: call.invocation,
            schedulerId: call.schedulerId,
            approvalMode: call.approvalMode,
        };
    }
    isEventDrivenApprovalData(data) {
        return (typeof data === 'object' &&
            data !== null &&
            'correlationId' in data &&
            'confirmationDetails' in data);
    }
    toScheduled(call) {
        this.validateHasToolAndInvocation(call, CoreToolCallStatus.Scheduled);
        return {
            request: call.request,
            tool: call.tool,
            status: CoreToolCallStatus.Scheduled,
            startTime: 'startTime' in call ? call.startTime : undefined,
            outcome: call.outcome,
            invocation: call.invocation,
            schedulerId: call.schedulerId,
            approvalMode: call.approvalMode,
        };
    }
    toCancelled(call, reason) {
        this.validateHasToolAndInvocation(call, CoreToolCallStatus.Cancelled);
        const startTime = 'startTime' in call ? call.startTime : undefined;
        // TODO: Refactor this tool-specific logic into the confirmation details payload.
        // See: https://github.com/google-gemini/gemini-cli/issues/16716
        let resultDisplay = undefined;
        if (this.isWaitingToolCall(call)) {
            const details = call.confirmationDetails;
            if (details.type === 'edit' &&
                'fileDiff' in details &&
                'fileName' in details &&
                'filePath' in details &&
                'originalContent' in details &&
                'newContent' in details) {
                resultDisplay = {
                    fileDiff: details.fileDiff,
                    fileName: details.fileName,
                    filePath: details.filePath,
                    originalContent: details.originalContent,
                    newContent: details.newContent,
                };
            }
        }
        if (isToolCallResponseInfo(reason)) {
            return {
                request: call.request,
                tool: call.tool,
                invocation: call.invocation,
                status: CoreToolCallStatus.Cancelled,
                response: reason,
                durationMs: startTime ? Date.now() - startTime : undefined,
                outcome: call.outcome,
                schedulerId: call.schedulerId,
                approvalMode: call.approvalMode,
            };
        }
        const errorMessage = `[Operation Cancelled] Reason: ${reason}`;
        return {
            request: call.request,
            tool: call.tool,
            invocation: call.invocation,
            status: CoreToolCallStatus.Cancelled,
            response: {
                callId: call.request.callId,
                responseParts: [
                    {
                        functionResponse: {
                            id: call.request.callId,
                            name: call.request.name,
                            response: { error: errorMessage },
                        },
                    },
                ],
                resultDisplay,
                error: undefined,
                errorType: undefined,
                contentLength: errorMessage.length,
            },
            durationMs: startTime ? Date.now() - startTime : undefined,
            outcome: call.outcome,
            schedulerId: call.schedulerId,
            approvalMode: call.approvalMode,
        };
    }
    isWaitingToolCall(call) {
        return call.status === CoreToolCallStatus.AwaitingApproval;
    }
    patchCall(call, patch) {
        return { ...call, ...patch };
    }
    toValidating(call) {
        this.validateHasToolAndInvocation(call, CoreToolCallStatus.Validating);
        return {
            request: call.request,
            tool: call.tool,
            status: CoreToolCallStatus.Validating,
            startTime: 'startTime' in call ? call.startTime : undefined,
            outcome: call.outcome,
            invocation: call.invocation,
            schedulerId: call.schedulerId,
            approvalMode: call.approvalMode,
        };
    }
    toExecuting(call, data) {
        this.validateHasToolAndInvocation(call, CoreToolCallStatus.Executing);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const execData = data;
        const liveOutput = execData?.liveOutput ??
            ('liveOutput' in call ? call.liveOutput : undefined);
        const pid = execData?.pid ?? ('pid' in call ? call.pid : undefined);
        const progressMessage = execData?.progressMessage ??
            ('progressMessage' in call ? call.progressMessage : undefined);
        const progressPercent = execData?.progressPercent ??
            ('progressPercent' in call ? call.progressPercent : undefined);
        const progress = execData?.progress ?? ('progress' in call ? call.progress : undefined);
        const progressTotal = execData?.progressTotal ??
            ('progressTotal' in call ? call.progressTotal : undefined);
        return {
            request: call.request,
            tool: call.tool,
            status: CoreToolCallStatus.Executing,
            startTime: 'startTime' in call ? call.startTime : undefined,
            outcome: call.outcome,
            invocation: call.invocation,
            liveOutput,
            pid,
            progressMessage,
            progressPercent,
            progress,
            progressTotal,
            schedulerId: call.schedulerId,
            approvalMode: call.approvalMode,
        };
    }
}
//# sourceMappingURL=state-manager.js.map