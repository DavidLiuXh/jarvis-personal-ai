/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import { HookRegistry, type HookRegistryEntry } from './hookRegistry.js';
import { type AggregatedHookResult } from './hookAggregator.js';
import { HookEventHandler } from './hookEventHandler.js';
import { type SessionStartSource, type SessionEndReason, type PreCompressTrigger, type DefaultHookOutput, type McpToolContext, type HookConfig, type HookEventName, type ConfigSource } from './types.js';
import type { GenerateContentParameters, GenerateContentResponse, GenerateContentConfig, ContentListUnion, ToolConfig, ToolListUnion } from '@google/genai';
import type { ToolCallConfirmationDetails } from '../tools/tools.js';
/**
 * Main hook system that coordinates all hook-related functionality
 */
export interface BeforeModelHookResult {
    /** Whether the model call was blocked */
    blocked: boolean;
    /** Whether the execution should be stopped entirely */
    stopped?: boolean;
    /** Reason for blocking (if blocked) */
    reason?: string;
    /** Synthetic response to return instead of calling the model (if blocked) */
    syntheticResponse?: GenerateContentResponse;
    /** Modified config (if not blocked) */
    modifiedConfig?: GenerateContentConfig;
    /** Modified contents (if not blocked) */
    modifiedContents?: ContentListUnion;
}
/**
 * Result from firing the BeforeToolSelection hook.
 */
export interface BeforeToolSelectionHookResult {
    /** Modified tool config */
    toolConfig?: ToolConfig;
    /** Modified tools */
    tools?: ToolListUnion;
}
/**
 * Result from firing the AfterModel hook.
 * Contains either a modified response or indicates to use the original chunk.
 */
export interface AfterModelHookResult {
    /** The response to yield (either modified or original) */
    response: GenerateContentResponse;
    /** Whether the execution should be stopped entirely */
    stopped?: boolean;
    /** Whether the model call was blocked */
    blocked?: boolean;
    /** Reason for blocking or stopping */
    reason?: string;
}
export declare class HookSystem {
    private readonly hookRegistry;
    private readonly hookRunner;
    private readonly hookAggregator;
    private readonly hookPlanner;
    private readonly hookEventHandler;
    constructor(config: Config);
    /**
     * Initialize the hook system
     */
    initialize(): Promise<void>;
    /**
     * Get the hook event bus for firing events
     */
    getEventHandler(): HookEventHandler;
    /**
     * Get hook registry for management operations
     */
    getRegistry(): HookRegistry;
    /**
     * Enable or disable a hook
     */
    setHookEnabled(hookName: string, enabled: boolean): void;
    /**
     * Get all registered hooks for display/management
     */
    getAllHooks(): HookRegistryEntry[];
    /**
     * Register a new hook programmatically
     */
    registerHook(config: HookConfig, eventName: HookEventName, options?: {
        matcher?: string;
        sequential?: boolean;
        source?: ConfigSource;
    }): void;
    /**
     * Fire hook events directly
     */
    fireSessionStartEvent(source: SessionStartSource): Promise<DefaultHookOutput | undefined>;
    fireSessionEndEvent(reason: SessionEndReason): Promise<AggregatedHookResult | undefined>;
    firePreCompressEvent(trigger: PreCompressTrigger): Promise<AggregatedHookResult | undefined>;
    fireBeforeAgentEvent(prompt: string): Promise<DefaultHookOutput | undefined>;
    fireAfterAgentEvent(prompt: string, response: string, stopHookActive?: boolean): Promise<DefaultHookOutput | undefined>;
    fireBeforeModelEvent(llmRequest: GenerateContentParameters): Promise<BeforeModelHookResult>;
    fireAfterModelEvent(originalRequest: GenerateContentParameters, chunk: GenerateContentResponse): Promise<AfterModelHookResult>;
    fireBeforeToolSelectionEvent(llmRequest: GenerateContentParameters): Promise<BeforeToolSelectionHookResult>;
    fireBeforeToolEvent(toolName: string, toolInput: Record<string, unknown>, mcpContext?: McpToolContext, originalRequestName?: string): Promise<DefaultHookOutput | undefined>;
    fireAfterToolEvent(toolName: string, toolInput: Record<string, unknown>, toolResponse: {
        llmContent: unknown;
        returnDisplay: unknown;
        error: unknown;
    }, mcpContext?: McpToolContext, originalRequestName?: string): Promise<DefaultHookOutput | undefined>;
    fireToolNotificationEvent(confirmationDetails: ToolCallConfirmationDetails): Promise<void>;
}
