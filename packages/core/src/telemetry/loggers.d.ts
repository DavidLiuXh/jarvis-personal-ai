/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import { type ApiErrorEvent, type ApiRequestEvent, type ApiResponseEvent, type FileOperationEvent, type IdeConnectionEvent, type StartSessionEvent, type ToolCallEvent, type UserPromptEvent, type FlashFallbackEvent, type NextSpeakerCheckEvent, type LoopDetectedEvent, type LoopDetectionDisabledEvent, type SlashCommandEvent, type RewindEvent, type ConversationFinishedEvent, type ChatCompressionEvent, type MalformedJsonResponseEvent, type InvalidChunkEvent, type ContentRetryEvent, type ContentRetryFailureEvent, type RipgrepFallbackEvent, type ToolOutputTruncatedEvent, type ModelRoutingEvent, type ExtensionDisableEvent, type ExtensionEnableEvent, type ExtensionUninstallEvent, type ExtensionInstallEvent, type ModelSlashCommandEvent, type EditStrategyEvent, type EditCorrectionEvent, type AgentStartEvent, type AgentFinishEvent, type RecoveryAttemptEvent, type WebFetchFallbackAttemptEvent, type ExtensionUpdateEvent, type ApprovalModeSwitchEvent, type ApprovalModeDurationEvent, type HookCallEvent, type StartupStatsEvent, type LlmLoopCheckEvent, type PlanExecutionEvent, type ToolOutputMaskingEvent, type KeychainAvailabilityEvent, type TokenStorageInitializationEvent } from './types.js';
import type { BillingTelemetryEvent } from './billingEvents.js';
export declare function logCliConfiguration(config: Config, event: StartSessionEvent): void;
export declare function logUserPrompt(config: Config, event: UserPromptEvent): void;
export declare function logToolCall(config: Config, event: ToolCallEvent): void;
export declare function logToolOutputTruncated(config: Config, event: ToolOutputTruncatedEvent): void;
export declare function logToolOutputMasking(config: Config, event: ToolOutputMaskingEvent): void;
export declare function logFileOperation(config: Config, event: FileOperationEvent): void;
export declare function logApiRequest(config: Config, event: ApiRequestEvent): void;
export declare function logFlashFallback(config: Config, event: FlashFallbackEvent): void;
export declare function logRipgrepFallback(config: Config, event: RipgrepFallbackEvent): void;
export declare function logApiError(config: Config, event: ApiErrorEvent): void;
export declare function logApiResponse(config: Config, event: ApiResponseEvent): void;
export declare function logLoopDetected(config: Config, event: LoopDetectedEvent): void;
export declare function logLoopDetectionDisabled(config: Config, event: LoopDetectionDisabledEvent): void;
export declare function logNextSpeakerCheck(config: Config, event: NextSpeakerCheckEvent): void;
export declare function logSlashCommand(config: Config, event: SlashCommandEvent): void;
export declare function logRewind(config: Config, event: RewindEvent): void;
export declare function logIdeConnection(config: Config, event: IdeConnectionEvent): void;
export declare function logConversationFinishedEvent(config: Config, event: ConversationFinishedEvent): void;
export declare function logChatCompression(config: Config, event: ChatCompressionEvent): void;
export declare function logMalformedJsonResponse(config: Config, event: MalformedJsonResponseEvent): void;
export declare function logInvalidChunk(config: Config, event: InvalidChunkEvent): void;
export declare function logContentRetry(config: Config, event: ContentRetryEvent): void;
export declare function logContentRetryFailure(config: Config, event: ContentRetryFailureEvent): void;
export declare function logModelRouting(config: Config, event: ModelRoutingEvent): void;
export declare function logModelSlashCommand(config: Config, event: ModelSlashCommandEvent): void;
export declare function logExtensionInstallEvent(config: Config, event: ExtensionInstallEvent): Promise<void>;
export declare function logExtensionUninstall(config: Config, event: ExtensionUninstallEvent): Promise<void>;
export declare function logExtensionUpdateEvent(config: Config, event: ExtensionUpdateEvent): Promise<void>;
export declare function logExtensionEnable(config: Config, event: ExtensionEnableEvent): Promise<void>;
export declare function logExtensionDisable(config: Config, event: ExtensionDisableEvent): Promise<void>;
export declare function logEditStrategy(config: Config, event: EditStrategyEvent): void;
export declare function logEditCorrectionEvent(config: Config, event: EditCorrectionEvent): void;
export declare function logAgentStart(config: Config, event: AgentStartEvent): void;
export declare function logAgentFinish(config: Config, event: AgentFinishEvent): void;
export declare function logRecoveryAttempt(config: Config, event: RecoveryAttemptEvent): void;
export declare function logWebFetchFallbackAttempt(config: Config, event: WebFetchFallbackAttemptEvent): void;
export declare function logLlmLoopCheck(config: Config, event: LlmLoopCheckEvent): void;
export declare function logApprovalModeSwitch(config: Config, event: ApprovalModeSwitchEvent): void;
export declare function logApprovalModeDuration(config: Config, event: ApprovalModeDurationEvent): void;
export declare function logPlanExecution(config: Config, event: PlanExecutionEvent): void;
export declare function logHookCall(config: Config, event: HookCallEvent): void;
export declare function logStartupStats(config: Config, event: StartupStatsEvent): void;
export declare function logKeychainAvailability(config: Config, event: KeychainAvailabilityEvent): void;
export declare function logTokenStorageInitialization(config: Config, event: TokenStorageInitializationEvent): void;
export declare function logBillingEvent(config: Config, event: BillingTelemetryEvent): void;
