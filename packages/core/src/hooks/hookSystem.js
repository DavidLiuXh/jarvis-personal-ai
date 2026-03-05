/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { HookRegistry } from './hookRegistry.js';
import { HookRunner } from './hookRunner.js';
import { HookAggregator } from './hookAggregator.js';
import { HookPlanner } from './hookPlanner.js';
import { HookEventHandler } from './hookEventHandler.js';
import { debugLogger } from '../utils/debugLogger.js';
import { NotificationType, } from './types.js';
/**
 * Converts ToolCallConfirmationDetails to a serializable format for hooks.
 * Excludes function properties (onConfirm, ideConfirmation) that can't be serialized.
 */
function toSerializableDetails(details) {
    const base = {
        type: details.type,
        title: details.title,
    };
    switch (details.type) {
        case 'edit':
            return {
                ...base,
                fileName: details.fileName,
                filePath: details.filePath,
                fileDiff: details.fileDiff,
                originalContent: details.originalContent,
                newContent: details.newContent,
                isModifying: details.isModifying,
            };
        case 'exec':
            return {
                ...base,
                command: details.command,
                rootCommand: details.rootCommand,
            };
        case 'mcp':
            return {
                ...base,
                serverName: details.serverName,
                toolName: details.toolName,
                toolDisplayName: details.toolDisplayName,
            };
        case 'info':
            return {
                ...base,
                prompt: details.prompt,
                urls: details.urls,
            };
        default:
            return base;
    }
}
/**
 * Gets the message to display in the notification hook for tool confirmation.
 */
function getNotificationMessage(confirmationDetails) {
    switch (confirmationDetails.type) {
        case 'edit':
            return `Tool ${confirmationDetails.title} requires editing`;
        case 'exec':
            return `Tool ${confirmationDetails.title} requires execution`;
        case 'mcp':
            return `Tool ${confirmationDetails.title} requires MCP`;
        case 'info':
            return `Tool ${confirmationDetails.title} requires information`;
        default:
            return `Tool requires confirmation`;
    }
}
export class HookSystem {
    hookRegistry;
    hookRunner;
    hookAggregator;
    hookPlanner;
    hookEventHandler;
    constructor(config) {
        // Initialize components
        this.hookRegistry = new HookRegistry(config);
        this.hookRunner = new HookRunner(config);
        this.hookAggregator = new HookAggregator();
        this.hookPlanner = new HookPlanner(this.hookRegistry);
        this.hookEventHandler = new HookEventHandler(config, this.hookPlanner, this.hookRunner, this.hookAggregator);
    }
    /**
     * Initialize the hook system
     */
    async initialize() {
        await this.hookRegistry.initialize();
        debugLogger.debug('Hook system initialized successfully');
    }
    /**
     * Get the hook event bus for firing events
     */
    getEventHandler() {
        return this.hookEventHandler;
    }
    /**
     * Get hook registry for management operations
     */
    getRegistry() {
        return this.hookRegistry;
    }
    /**
     * Enable or disable a hook
     */
    setHookEnabled(hookName, enabled) {
        this.hookRegistry.setHookEnabled(hookName, enabled);
    }
    /**
     * Get all registered hooks for display/management
     */
    getAllHooks() {
        return this.hookRegistry.getAllHooks();
    }
    /**
     * Register a new hook programmatically
     */
    registerHook(config, eventName, options) {
        this.hookRegistry.registerHook(config, eventName, options);
    }
    /**
     * Fire hook events directly
     */
    async fireSessionStartEvent(source) {
        const result = await this.hookEventHandler.fireSessionStartEvent(source);
        return result.finalOutput;
    }
    async fireSessionEndEvent(reason) {
        return this.hookEventHandler.fireSessionEndEvent(reason);
    }
    async firePreCompressEvent(trigger) {
        return this.hookEventHandler.firePreCompressEvent(trigger);
    }
    async fireBeforeAgentEvent(prompt) {
        const result = await this.hookEventHandler.fireBeforeAgentEvent(prompt);
        return result.finalOutput;
    }
    async fireAfterAgentEvent(prompt, response, stopHookActive = false) {
        const result = await this.hookEventHandler.fireAfterAgentEvent(prompt, response, stopHookActive);
        return result.finalOutput;
    }
    async fireBeforeModelEvent(llmRequest) {
        try {
            const result = await this.hookEventHandler.fireBeforeModelEvent(llmRequest);
            const hookOutput = result.finalOutput;
            if (hookOutput?.shouldStopExecution()) {
                return {
                    blocked: true,
                    stopped: true,
                    reason: hookOutput.getEffectiveReason(),
                };
            }
            const blockingError = hookOutput?.getBlockingError();
            if (blockingError?.blocked) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const beforeModelOutput = hookOutput;
                const syntheticResponse = beforeModelOutput.getSyntheticResponse();
                return {
                    blocked: true,
                    reason: hookOutput?.getEffectiveReason() || 'Model call blocked by hook',
                    syntheticResponse,
                };
            }
            if (hookOutput) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const beforeModelOutput = hookOutput;
                const modifiedRequest = beforeModelOutput.applyLLMRequestModifications(llmRequest);
                return {
                    blocked: false,
                    modifiedConfig: modifiedRequest?.config,
                    modifiedContents: modifiedRequest?.contents,
                };
            }
            return { blocked: false };
        }
        catch (error) {
            debugLogger.debug(`BeforeModelHookEvent failed:`, error);
            return { blocked: false };
        }
    }
    async fireAfterModelEvent(originalRequest, chunk) {
        try {
            const result = await this.hookEventHandler.fireAfterModelEvent(originalRequest, chunk);
            const hookOutput = result.finalOutput;
            if (hookOutput?.shouldStopExecution()) {
                return {
                    response: chunk,
                    stopped: true,
                    reason: hookOutput.getEffectiveReason(),
                };
            }
            const blockingError = hookOutput?.getBlockingError();
            if (blockingError?.blocked) {
                return {
                    response: chunk,
                    blocked: true,
                    reason: hookOutput?.getEffectiveReason(),
                };
            }
            if (hookOutput) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const afterModelOutput = hookOutput;
                const modifiedResponse = afterModelOutput.getModifiedResponse();
                if (modifiedResponse) {
                    return { response: modifiedResponse };
                }
            }
            return { response: chunk };
        }
        catch (error) {
            debugLogger.debug(`AfterModelHookEvent failed:`, error);
            return { response: chunk };
        }
    }
    async fireBeforeToolSelectionEvent(llmRequest) {
        try {
            const result = await this.hookEventHandler.fireBeforeToolSelectionEvent(llmRequest);
            const hookOutput = result.finalOutput;
            if (hookOutput) {
                const toolSelectionOutput = hookOutput;
                const modifiedConfig = toolSelectionOutput.applyToolConfigModifications({
                    toolConfig: llmRequest.config?.toolConfig,
                    tools: llmRequest.config?.tools,
                });
                return {
                    toolConfig: modifiedConfig.toolConfig,
                    tools: modifiedConfig.tools,
                };
            }
            return {};
        }
        catch (error) {
            debugLogger.debug(`BeforeToolSelectionEvent failed:`, error);
            return {};
        }
    }
    async fireBeforeToolEvent(toolName, toolInput, mcpContext, originalRequestName) {
        try {
            const result = await this.hookEventHandler.fireBeforeToolEvent(toolName, toolInput, mcpContext, originalRequestName);
            return result.finalOutput;
        }
        catch (error) {
            debugLogger.debug(`BeforeToolEvent failed for ${toolName}:`, error);
            return undefined;
        }
    }
    async fireAfterToolEvent(toolName, toolInput, toolResponse, mcpContext, originalRequestName) {
        try {
            const result = await this.hookEventHandler.fireAfterToolEvent(toolName, toolInput, toolResponse, mcpContext, originalRequestName);
            return result.finalOutput;
        }
        catch (error) {
            debugLogger.debug(`AfterToolEvent failed for ${toolName}:`, error);
            return undefined;
        }
    }
    async fireToolNotificationEvent(confirmationDetails) {
        try {
            const message = getNotificationMessage(confirmationDetails);
            const serializedDetails = toSerializableDetails(confirmationDetails);
            await this.hookEventHandler.fireNotificationEvent(NotificationType.ToolPermission, message, serializedDetails);
        }
        catch (error) {
            debugLogger.debug(`NotificationEvent failed for ${confirmationDetails.title}:`, error);
        }
    }
}
//# sourceMappingURL=hookSystem.js.map