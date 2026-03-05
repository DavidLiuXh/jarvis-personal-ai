/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { HookEventName, HookType, } from './types.js';
import { defaultHookTranslator } from './hookTranslator.js';
import { logHookCall } from '../telemetry/loggers.js';
import { HookCallEvent } from '../telemetry/types.js';
import { debugLogger } from '../utils/debugLogger.js';
import { coreEvents } from '../utils/events.js';
/**
 * Hook event bus that coordinates hook execution across the system
 */
export class HookEventHandler {
    config;
    hookPlanner;
    hookRunner;
    hookAggregator;
    /**
     * Track reported failures to suppress duplicate warnings during streaming.
     * Uses a WeakMap with the original request object as a key to ensure
     * failures are only reported once per logical model interaction.
     */
    reportedFailures = new WeakMap();
    constructor(config, hookPlanner, hookRunner, hookAggregator) {
        this.config = config;
        this.hookPlanner = hookPlanner;
        this.hookRunner = hookRunner;
        this.hookAggregator = hookAggregator;
    }
    /**
     * Fire a BeforeTool event
     * Called by handleHookExecutionRequest - executes hooks directly
     */
    async fireBeforeToolEvent(toolName, toolInput, mcpContext, originalRequestName) {
        const input = {
            ...this.createBaseInput(HookEventName.BeforeTool),
            tool_name: toolName,
            tool_input: toolInput,
            ...(mcpContext && { mcp_context: mcpContext }),
            ...(originalRequestName && {
                original_request_name: originalRequestName,
            }),
        };
        const context = { toolName };
        return this.executeHooks(HookEventName.BeforeTool, input, context);
    }
    /**
     * Fire an AfterTool event
     * Called by handleHookExecutionRequest - executes hooks directly
     */
    async fireAfterToolEvent(toolName, toolInput, toolResponse, mcpContext, originalRequestName) {
        const input = {
            ...this.createBaseInput(HookEventName.AfterTool),
            tool_name: toolName,
            tool_input: toolInput,
            tool_response: toolResponse,
            ...(mcpContext && { mcp_context: mcpContext }),
            ...(originalRequestName && {
                original_request_name: originalRequestName,
            }),
        };
        const context = { toolName };
        return this.executeHooks(HookEventName.AfterTool, input, context);
    }
    /**
     * Fire a BeforeAgent event
     * Called by handleHookExecutionRequest - executes hooks directly
     */
    async fireBeforeAgentEvent(prompt) {
        const input = {
            ...this.createBaseInput(HookEventName.BeforeAgent),
            prompt,
        };
        return this.executeHooks(HookEventName.BeforeAgent, input);
    }
    /**
     * Fire a Notification event
     */
    async fireNotificationEvent(type, message, details) {
        const input = {
            ...this.createBaseInput(HookEventName.Notification),
            notification_type: type,
            message,
            details,
        };
        return this.executeHooks(HookEventName.Notification, input);
    }
    /**
     * Fire an AfterAgent event
     * Called by handleHookExecutionRequest - executes hooks directly
     */
    async fireAfterAgentEvent(prompt, promptResponse, stopHookActive = false) {
        const input = {
            ...this.createBaseInput(HookEventName.AfterAgent),
            prompt,
            prompt_response: promptResponse,
            stop_hook_active: stopHookActive,
        };
        return this.executeHooks(HookEventName.AfterAgent, input);
    }
    /**
     * Fire a SessionStart event
     */
    async fireSessionStartEvent(source) {
        const input = {
            ...this.createBaseInput(HookEventName.SessionStart),
            source,
        };
        const context = { trigger: source };
        return this.executeHooks(HookEventName.SessionStart, input, context);
    }
    /**
     * Fire a SessionEnd event
     */
    async fireSessionEndEvent(reason) {
        const input = {
            ...this.createBaseInput(HookEventName.SessionEnd),
            reason,
        };
        const context = { trigger: reason };
        return this.executeHooks(HookEventName.SessionEnd, input, context);
    }
    /**
     * Fire a PreCompress event
     */
    async firePreCompressEvent(trigger) {
        const input = {
            ...this.createBaseInput(HookEventName.PreCompress),
            trigger,
        };
        const context = { trigger };
        return this.executeHooks(HookEventName.PreCompress, input, context);
    }
    /**
     * Fire a BeforeModel event
     * Called by handleHookExecutionRequest - executes hooks directly
     */
    async fireBeforeModelEvent(llmRequest) {
        const input = {
            ...this.createBaseInput(HookEventName.BeforeModel),
            llm_request: defaultHookTranslator.toHookLLMRequest(llmRequest),
        };
        return this.executeHooks(HookEventName.BeforeModel, input, undefined, llmRequest);
    }
    /**
     * Fire an AfterModel event
     * Called by handleHookExecutionRequest - executes hooks directly
     */
    async fireAfterModelEvent(llmRequest, llmResponse) {
        const input = {
            ...this.createBaseInput(HookEventName.AfterModel),
            llm_request: defaultHookTranslator.toHookLLMRequest(llmRequest),
            llm_response: defaultHookTranslator.toHookLLMResponse(llmResponse),
        };
        return this.executeHooks(HookEventName.AfterModel, input, undefined, llmRequest);
    }
    /**
     * Fire a BeforeToolSelection event
     * Called by handleHookExecutionRequest - executes hooks directly
     */
    async fireBeforeToolSelectionEvent(llmRequest) {
        const input = {
            ...this.createBaseInput(HookEventName.BeforeToolSelection),
            llm_request: defaultHookTranslator.toHookLLMRequest(llmRequest),
        };
        return this.executeHooks(HookEventName.BeforeToolSelection, input, undefined, llmRequest);
    }
    /**
     * Execute hooks for a specific event (direct execution without MessageBus)
     * Used as fallback when MessageBus is not available
     */
    async executeHooks(eventName, input, context, requestContext) {
        try {
            // Create execution plan
            const plan = this.hookPlanner.createExecutionPlan(eventName, context);
            if (!plan || plan.hookConfigs.length === 0) {
                return {
                    success: true,
                    allOutputs: [],
                    errors: [],
                    totalDuration: 0,
                };
            }
            const onHookStart = (config, index) => {
                coreEvents.emitHookStart({
                    hookName: this.getHookName(config),
                    eventName,
                    hookIndex: index + 1,
                    totalHooks: plan.hookConfigs.length,
                });
            };
            const onHookEnd = (config, result) => {
                coreEvents.emitHookEnd({
                    hookName: this.getHookName(config),
                    eventName,
                    success: result.success,
                });
            };
            // Execute hooks according to the plan's strategy
            const results = plan.sequential
                ? await this.hookRunner.executeHooksSequential(plan.hookConfigs, eventName, input, onHookStart, onHookEnd)
                : await this.hookRunner.executeHooksParallel(plan.hookConfigs, eventName, input, onHookStart, onHookEnd);
            // Aggregate results
            const aggregated = this.hookAggregator.aggregateResults(results, eventName);
            // Process common hook output fields centrally
            this.processCommonHookOutputFields(aggregated);
            // Log hook execution
            this.logHookExecution(eventName, input, results, aggregated, requestContext);
            return aggregated;
        }
        catch (error) {
            debugLogger.error(`Hook event bus error for ${eventName}: ${error}`);
            return {
                success: false,
                allOutputs: [],
                errors: [error instanceof Error ? error : new Error(String(error))],
                totalDuration: 0,
            };
        }
    }
    /**
     * Create base hook input with common fields
     */
    createBaseInput(eventName) {
        // Get the transcript path from the ChatRecordingService if available
        const transcriptPath = this.config
            .getGeminiClient()
            ?.getChatRecordingService()
            ?.getConversationFilePath() ?? '';
        return {
            session_id: this.config.getSessionId(),
            transcript_path: transcriptPath,
            cwd: this.config.getWorkingDir(),
            hook_event_name: eventName,
            timestamp: new Date().toISOString(),
        };
    }
    /**
     * Log hook execution for observability
     */
    logHookExecution(eventName, input, results, aggregated, requestContext) {
        const failedHooks = results.filter((r) => !r.success);
        const successCount = results.length - failedHooks.length;
        const errorCount = failedHooks.length;
        if (errorCount > 0) {
            const failedNames = failedHooks
                .map((r) => this.getHookNameFromResult(r))
                .join(', ');
            let shouldEmit = true;
            if (requestContext) {
                let reportedSet = this.reportedFailures.get(requestContext);
                if (!reportedSet) {
                    reportedSet = new Set();
                    this.reportedFailures.set(requestContext, reportedSet);
                }
                const failureKey = `${eventName}:${failedNames}`;
                if (reportedSet.has(failureKey)) {
                    shouldEmit = false;
                }
                else {
                    reportedSet.add(failureKey);
                }
            }
            debugLogger.warn(`Hook execution for ${eventName}: ${successCount} succeeded, ${errorCount} failed (${failedNames}), ` +
                `total duration: ${aggregated.totalDuration}ms`);
            if (shouldEmit) {
                coreEvents.emitFeedback('warning', `Hook(s) [${failedNames}] failed for event ${eventName}. Press F12 to see the debug drawer for more details.\n`);
            }
        }
        else {
            debugLogger.debug(`Hook execution for ${eventName}: ${successCount} hooks executed successfully, ` +
                `total duration: ${aggregated.totalDuration}ms`);
        }
        // Log individual hook calls to telemetry
        for (const result of results) {
            // Determine hook name and type for telemetry
            const hookName = this.getHookNameFromResult(result);
            const hookType = this.getHookTypeFromResult(result);
            const hookCallEvent = new HookCallEvent(eventName, hookType, hookName, { ...input }, result.duration, result.success, result.output ? { ...result.output } : undefined, result.exitCode, result.stdout, result.stderr, result.error?.message);
            logHookCall(this.config, hookCallEvent);
        }
        // Log individual errors
        for (const error of aggregated.errors) {
            debugLogger.warn(`Hook execution error: ${error.message}`);
        }
    }
    /**
     * Process common hook output fields centrally
     */
    processCommonHookOutputFields(aggregated) {
        if (!aggregated.finalOutput) {
            return;
        }
        // Handle systemMessage - show to user in transcript mode (not to agent)
        const systemMessage = aggregated.finalOutput.systemMessage;
        if (systemMessage && !aggregated.finalOutput.suppressOutput) {
            debugLogger.warn(`Hook system message: ${systemMessage}`);
        }
        // Handle suppressOutput - already handled by not logging above when true
        // Handle continue=false - this should stop the entire agent execution
        if (aggregated.finalOutput.shouldStopExecution()) {
            const stopReason = aggregated.finalOutput.getEffectiveReason();
            debugLogger.log(`Hook requested to stop execution: ${stopReason}`);
            // Note: The actual stopping of execution must be handled by integration points
            // as they need to interpret this signal in the context of their specific workflow
            // This is just logging the request centrally
        }
        // Other common fields like decision/reason are handled by specific hook output classes
    }
    /**
     * Get hook name from config for display or telemetry
     */
    getHookName(config) {
        if (config.type === HookType.Command) {
            return config.name || config.command || 'unknown-command';
        }
        return config.name || 'unknown-hook';
    }
    /**
     * Get hook name from execution result for telemetry
     */
    getHookNameFromResult(result) {
        return this.getHookName(result.hookConfig);
    }
    /**
     * Get hook type from execution result for telemetry
     */
    getHookTypeFromResult(result) {
        return result.hookConfig.type;
    }
}
//# sourceMappingURL=hookEventHandler.js.map