/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { EventEmitter } from 'node:events';
import type { AgentDefinition } from '../agents/types.js';
import type { McpClient } from '../tools/mcp-client.js';
import type { ExtensionEvents } from './extensionLoader.js';
import type { EditorType } from './editor.js';
import type { TokenStorageInitializationEvent, KeychainAvailabilityEvent } from '../telemetry/types.js';
/**
 * Defines the severity level for user-facing feedback.
 * This maps loosely to UI `MessageType`
 */
export type FeedbackSeverity = 'info' | 'warning' | 'error';
/**
 * Payload for the 'user-feedback' event.
 */
export interface UserFeedbackPayload {
    /**
     * The severity level determines how the message is rendered in the UI
     * (e.g. colored text, specific icon).
     */
    severity: FeedbackSeverity;
    /**
     * The main message to display to the user in the chat history or stdout.
     */
    message: string;
    /**
     * The original error object, if applicable.
     * Listeners can use this to extract stack traces for debug logging
     * or verbose output, while keeping the 'message' field clean for end users.
     */
    error?: unknown;
}
/**
 * Payload for the 'model-changed' event.
 */
export interface ModelChangedPayload {
    /**
     * The new model that was set.
     */
    model: string;
}
/**
 * Payload for the 'console-log' event.
 */
export interface ConsoleLogPayload {
    type: 'log' | 'warn' | 'error' | 'debug' | 'info';
    content: string;
}
/**
 * Payload for the 'output' event.
 */
export interface OutputPayload {
    isStderr: boolean;
    chunk: Uint8Array | string;
    encoding?: BufferEncoding;
}
/**
 * Payload for the 'memory-changed' event.
 */
export interface MemoryChangedPayload {
    fileCount: number;
}
/**
 * Base payload for hook-related events.
 */
export interface HookPayload {
    hookName: string;
    eventName: string;
}
/**
 * Payload for the 'hook-start' event.
 */
export interface HookStartPayload extends HookPayload {
    /**
     * The 1-based index of the current hook in the execution sequence.
     * Used for progress indication (e.g. "Hook 1/3").
     */
    hookIndex?: number;
    /**
     * The total number of hooks in the current execution sequence.
     */
    totalHooks?: number;
}
/**
 * Payload for the 'hook-end' event.
 */
export interface HookEndPayload extends HookPayload {
    success: boolean;
}
/**
 * Payload for the 'retry-attempt' event.
 */
export interface RetryAttemptPayload {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error?: string;
    model: string;
}
/**
 * Payload for the 'consent-request' event.
 */
export interface ConsentRequestPayload {
    prompt: string;
    onConfirm: (confirmed: boolean) => void;
}
/**
 * Payload for the 'mcp-progress' event.
 */
export interface McpProgressPayload {
    serverName: string;
    callId: string;
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
}
/**
 * Payload for the 'agents-discovered' event.
 */
export interface AgentsDiscoveredPayload {
    agents: AgentDefinition[];
}
export interface SlashCommandConflict {
    name: string;
    renamedTo: string;
    loserExtensionName?: string;
    winnerExtensionName?: string;
}
export interface SlashCommandConflictsPayload {
    conflicts: SlashCommandConflict[];
}
/**
 * Payload for the 'quota-changed' event.
 */
export interface QuotaChangedPayload {
    remaining: number | undefined;
    limit: number | undefined;
    resetTime?: string;
}
export declare enum CoreEvent {
    UserFeedback = "user-feedback",
    ModelChanged = "model-changed",
    ConsoleLog = "console-log",
    Output = "output",
    MemoryChanged = "memory-changed",
    ExternalEditorClosed = "external-editor-closed",
    McpClientUpdate = "mcp-client-update",
    OauthDisplayMessage = "oauth-display-message",
    SettingsChanged = "settings-changed",
    HookStart = "hook-start",
    HookEnd = "hook-end",
    AgentsRefreshed = "agents-refreshed",
    AdminSettingsChanged = "admin-settings-changed",
    RetryAttempt = "retry-attempt",
    ConsentRequest = "consent-request",
    McpProgress = "mcp-progress",
    AgentsDiscovered = "agents-discovered",
    RequestEditorSelection = "request-editor-selection",
    EditorSelected = "editor-selected",
    SlashCommandConflicts = "slash-command-conflicts",
    QuotaChanged = "quota-changed",
    TelemetryKeychainAvailability = "telemetry-keychain-availability",
    TelemetryTokenStorageType = "telemetry-token-storage-type"
}
/**
 * Payload for the 'editor-selected' event.
 */
export interface EditorSelectedPayload {
    editor?: EditorType;
}
export interface CoreEvents extends ExtensionEvents {
    [CoreEvent.UserFeedback]: [UserFeedbackPayload];
    [CoreEvent.ModelChanged]: [ModelChangedPayload];
    [CoreEvent.ConsoleLog]: [ConsoleLogPayload];
    [CoreEvent.Output]: [OutputPayload];
    [CoreEvent.MemoryChanged]: [MemoryChangedPayload];
    [CoreEvent.QuotaChanged]: [QuotaChangedPayload];
    [CoreEvent.ExternalEditorClosed]: never[];
    [CoreEvent.McpClientUpdate]: Array<Map<string, McpClient> | never>;
    [CoreEvent.OauthDisplayMessage]: string[];
    [CoreEvent.SettingsChanged]: never[];
    [CoreEvent.HookStart]: [HookStartPayload];
    [CoreEvent.HookEnd]: [HookEndPayload];
    [CoreEvent.AgentsRefreshed]: never[];
    [CoreEvent.AdminSettingsChanged]: never[];
    [CoreEvent.RetryAttempt]: [RetryAttemptPayload];
    [CoreEvent.ConsentRequest]: [ConsentRequestPayload];
    [CoreEvent.McpProgress]: [McpProgressPayload];
    [CoreEvent.AgentsDiscovered]: [AgentsDiscoveredPayload];
    [CoreEvent.RequestEditorSelection]: never[];
    [CoreEvent.EditorSelected]: [EditorSelectedPayload];
    [CoreEvent.SlashCommandConflicts]: [SlashCommandConflictsPayload];
    [CoreEvent.TelemetryKeychainAvailability]: [KeychainAvailabilityEvent];
    [CoreEvent.TelemetryTokenStorageType]: [TokenStorageInitializationEvent];
}
export declare class CoreEventEmitter extends EventEmitter<CoreEvents> {
    private _eventBacklog;
    private static readonly MAX_BACKLOG_SIZE;
    constructor();
    private _emitOrQueue;
    /**
     * Sends actionable feedback to the user.
     * Buffers automatically if the UI hasn't subscribed yet.
     */
    emitFeedback(severity: FeedbackSeverity, message: string, error?: unknown): void;
    /**
     * Broadcasts a console log message.
     */
    emitConsoleLog(type: 'log' | 'warn' | 'error' | 'debug' | 'info', content: string): void;
    /**
     * Broadcasts stdout/stderr output.
     */
    emitOutput(isStderr: boolean, chunk: Uint8Array | string, encoding?: BufferEncoding): void;
    /**
     * Notifies subscribers that the model has changed.
     */
    emitModelChanged(model: string): void;
    /**
     * Notifies subscribers that settings have been modified.
     */
    emitSettingsChanged(): void;
    /**
     * Notifies subscribers that a hook execution has started.
     */
    emitHookStart(payload: HookStartPayload): void;
    /**
     * Notifies subscribers that a hook execution has ended.
     */
    emitHookEnd(payload: HookEndPayload): void;
    /**
     * Notifies subscribers that agents have been refreshed.
     */
    emitAgentsRefreshed(): void;
    /**
     * Notifies subscribers that admin settings have changed.
     */
    emitAdminSettingsChanged(): void;
    /**
     * Notifies subscribers that a retry attempt is happening.
     */
    emitRetryAttempt(payload: RetryAttemptPayload): void;
    /**
     * Requests consent from the user via the UI.
     */
    emitConsentRequest(payload: ConsentRequestPayload): void;
    /**
     * Notifies subscribers that progress has been made on an MCP tool call.
     */
    emitMcpProgress(payload: McpProgressPayload): void;
    /**
     * Notifies subscribers that new unacknowledged agents have been discovered.
     */
    emitAgentsDiscovered(agents: AgentDefinition[]): void;
    emitSlashCommandConflicts(conflicts: SlashCommandConflict[]): void;
    /**
     * Notifies subscribers that the quota has changed.
     */
    emitQuotaChanged(remaining: number | undefined, limit: number | undefined, resetTime?: string): void;
    /**
     * Flushes buffered messages. Call this immediately after primary UI listener
     * subscribes.
     */
    drainBacklogs(): void;
    emitTelemetryKeychainAvailability(event: KeychainAvailabilityEvent): void;
    emitTelemetryTokenStorageType(event: TokenStorageInitializationEvent): void;
}
export declare const coreEvents: CoreEventEmitter;
