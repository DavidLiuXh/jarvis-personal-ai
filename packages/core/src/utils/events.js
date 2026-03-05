/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { EventEmitter } from 'node:events';
import { debugLogger } from './debugLogger.js';
export var CoreEvent;
(function (CoreEvent) {
    CoreEvent["UserFeedback"] = "user-feedback";
    CoreEvent["ModelChanged"] = "model-changed";
    CoreEvent["ConsoleLog"] = "console-log";
    CoreEvent["Output"] = "output";
    CoreEvent["MemoryChanged"] = "memory-changed";
    CoreEvent["ExternalEditorClosed"] = "external-editor-closed";
    CoreEvent["McpClientUpdate"] = "mcp-client-update";
    CoreEvent["OauthDisplayMessage"] = "oauth-display-message";
    CoreEvent["SettingsChanged"] = "settings-changed";
    CoreEvent["HookStart"] = "hook-start";
    CoreEvent["HookEnd"] = "hook-end";
    CoreEvent["AgentsRefreshed"] = "agents-refreshed";
    CoreEvent["AdminSettingsChanged"] = "admin-settings-changed";
    CoreEvent["RetryAttempt"] = "retry-attempt";
    CoreEvent["ConsentRequest"] = "consent-request";
    CoreEvent["McpProgress"] = "mcp-progress";
    CoreEvent["AgentsDiscovered"] = "agents-discovered";
    CoreEvent["RequestEditorSelection"] = "request-editor-selection";
    CoreEvent["EditorSelected"] = "editor-selected";
    CoreEvent["SlashCommandConflicts"] = "slash-command-conflicts";
    CoreEvent["QuotaChanged"] = "quota-changed";
    CoreEvent["TelemetryKeychainAvailability"] = "telemetry-keychain-availability";
    CoreEvent["TelemetryTokenStorageType"] = "telemetry-token-storage-type";
})(CoreEvent || (CoreEvent = {}));
export class CoreEventEmitter extends EventEmitter {
    _eventBacklog = [];
    static MAX_BACKLOG_SIZE = 10000;
    constructor() {
        super();
    }
    _emitOrQueue(event, ...args) {
        if (this.listenerCount(event) === 0) {
            if (this._eventBacklog.length >= CoreEventEmitter.MAX_BACKLOG_SIZE) {
                this._eventBacklog.shift();
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            this._eventBacklog.push({ event, args });
        }
        else {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            this.emit(event, ...args);
        }
    }
    /**
     * Sends actionable feedback to the user.
     * Buffers automatically if the UI hasn't subscribed yet.
     */
    emitFeedback(severity, message, error) {
        const payload = { severity, message, error };
        this._emitOrQueue(CoreEvent.UserFeedback, payload);
    }
    /**
     * Broadcasts a console log message.
     */
    emitConsoleLog(type, content) {
        const payload = { type, content };
        this._emitOrQueue(CoreEvent.ConsoleLog, payload);
    }
    /**
     * Broadcasts stdout/stderr output.
     */
    emitOutput(isStderr, chunk, encoding) {
        const payload = { isStderr, chunk, encoding };
        this._emitOrQueue(CoreEvent.Output, payload);
    }
    /**
     * Notifies subscribers that the model has changed.
     */
    emitModelChanged(model) {
        const payload = { model };
        this.emit(CoreEvent.ModelChanged, payload);
    }
    /**
     * Notifies subscribers that settings have been modified.
     */
    emitSettingsChanged() {
        this.emit(CoreEvent.SettingsChanged);
    }
    /**
     * Notifies subscribers that a hook execution has started.
     */
    emitHookStart(payload) {
        this.emit(CoreEvent.HookStart, payload);
    }
    /**
     * Notifies subscribers that a hook execution has ended.
     */
    emitHookEnd(payload) {
        this.emit(CoreEvent.HookEnd, payload);
    }
    /**
     * Notifies subscribers that agents have been refreshed.
     */
    emitAgentsRefreshed() {
        this.emit(CoreEvent.AgentsRefreshed);
    }
    /**
     * Notifies subscribers that admin settings have changed.
     */
    emitAdminSettingsChanged() {
        this.emit(CoreEvent.AdminSettingsChanged);
    }
    /**
     * Notifies subscribers that a retry attempt is happening.
     */
    emitRetryAttempt(payload) {
        this.emit(CoreEvent.RetryAttempt, payload);
    }
    /**
     * Requests consent from the user via the UI.
     */
    emitConsentRequest(payload) {
        this._emitOrQueue(CoreEvent.ConsentRequest, payload);
    }
    /**
     * Notifies subscribers that progress has been made on an MCP tool call.
     */
    emitMcpProgress(payload) {
        if (!Number.isFinite(payload.progress) || payload.progress < 0) {
            debugLogger.log(`Invalid progress value: ${payload.progress}`);
            return;
        }
        this.emit(CoreEvent.McpProgress, payload);
    }
    /**
     * Notifies subscribers that new unacknowledged agents have been discovered.
     */
    emitAgentsDiscovered(agents) {
        const payload = { agents };
        this._emitOrQueue(CoreEvent.AgentsDiscovered, payload);
    }
    emitSlashCommandConflicts(conflicts) {
        const payload = { conflicts };
        this._emitOrQueue(CoreEvent.SlashCommandConflicts, payload);
    }
    /**
     * Notifies subscribers that the quota has changed.
     */
    emitQuotaChanged(remaining, limit, resetTime) {
        const payload = { remaining, limit, resetTime };
        this.emit(CoreEvent.QuotaChanged, payload);
    }
    /**
     * Flushes buffered messages. Call this immediately after primary UI listener
     * subscribes.
     */
    drainBacklogs() {
        const backlog = [...this._eventBacklog];
        this._eventBacklog.length = 0; // Clear in-place
        for (const item of backlog) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            this.emit(item.event, ...item.args);
        }
    }
    emitTelemetryKeychainAvailability(event) {
        this._emitOrQueue(CoreEvent.TelemetryKeychainAvailability, event);
    }
    emitTelemetryTokenStorageType(event) {
        this._emitOrQueue(CoreEvent.TelemetryTokenStorageType, event);
    }
}
export const coreEvents = new CoreEventEmitter();
//# sourceMappingURL=events.js.map