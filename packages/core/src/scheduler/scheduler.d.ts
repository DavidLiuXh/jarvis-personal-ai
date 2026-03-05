/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { type ToolCallRequestInfo, type CompletedToolCall } from './types.js';
import type { EditorType } from '../utils/editor.js';
export interface SchedulerOptions {
    config: Config;
    messageBus: MessageBus;
    getPreferredEditor: () => EditorType | undefined;
    schedulerId: string;
    parentCallId?: string;
    onWaitingForConfirmation?: (waiting: boolean) => void;
}
/**
 * Event-Driven Orchestrator for Tool Execution.
 * Coordinates execution via state updates and event listening.
 */
export declare class Scheduler {
    private static subscribedMessageBuses;
    private readonly state;
    private readonly executor;
    private readonly modifier;
    private readonly config;
    private readonly messageBus;
    private readonly getPreferredEditor;
    private readonly schedulerId;
    private readonly parentCallId?;
    private readonly onWaitingForConfirmation?;
    private isProcessing;
    private isCancelling;
    private readonly requestQueue;
    constructor(options: SchedulerOptions);
    dispose(): void;
    private readonly handleMcpProgress;
    private setupMessageBusListener;
    /**
     * Schedules a batch of tool calls.
     * @returns A promise that resolves with the results of the completed batch.
     */
    schedule(request: ToolCallRequestInfo | ToolCallRequestInfo[], signal: AbortSignal): Promise<CompletedToolCall[]>;
    private _enqueueRequest;
    cancelAll(): void;
    get completedCalls(): CompletedToolCall[];
    private isTerminal;
    private _startBatch;
    private _createToolNotFoundErroredToolCall;
    private _validateAndCreateToolCall;
    private _processQueue;
    /**
     * Processes the next item in the queue.
     * @returns true if the loop should continue, false if it should terminate.
     */
    private _processNextItem;
    private _isParallelizable;
    private _processValidatingCall;
    private _processToolCall;
    /**
     * Executes the tool and records the result. Returns true if a new tool call was added.
     */
    private _execute;
    private _processNextInRequestQueue;
}
