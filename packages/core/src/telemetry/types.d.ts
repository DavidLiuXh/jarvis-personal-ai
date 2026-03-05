/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Candidate, Content, GenerateContentConfig, GenerateContentResponseUsageMetadata } from '@google/genai';
import type { Config } from '../config/config.js';
import type { ApprovalMode } from '../policy/types.js';
import type { CompletedToolCall } from '../core/coreToolScheduler.js';
import { CoreToolCallStatus } from '../scheduler/types.js';
import type { LogAttributes, LogRecord } from '@opentelemetry/api-logs';
import { ToolCallDecision } from './tool-call-decision.js';
import { type FileOperation } from './metrics.js';
export { ToolCallDecision };
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { OutputFormat } from '../output/types.js';
import type { AgentTerminateMode } from '../agents/types.js';
import { type OTelFinishReason } from './semantic.js';
import { LlmRole } from './llmRole.js';
export { LlmRole };
import type { HookType } from '../hooks/types.js';
export interface BaseTelemetryEvent {
    'event.name': string;
    /** Current timestamp in ISO 8601 format */
    'event.timestamp': string;
}
type CommonFields = keyof BaseTelemetryEvent;
export declare const EVENT_CLI_CONFIG = "gemini_cli.config";
export declare class StartSessionEvent implements BaseTelemetryEvent {
    'event.name': 'cli_config';
    'event.timestamp': string;
    model: string;
    embedding_model: string;
    sandbox_enabled: boolean;
    core_tools_enabled: string;
    approval_mode: string;
    api_key_enabled: boolean;
    vertex_ai_enabled: boolean;
    debug_enabled: boolean;
    mcp_servers: string;
    telemetry_enabled: boolean;
    telemetry_log_user_prompts_enabled: boolean;
    file_filtering_respect_git_ignore: boolean;
    mcp_servers_count: number;
    mcp_tools_count?: number;
    mcp_tools?: string;
    output_format: OutputFormat;
    extensions_count: number;
    extensions: string;
    extension_ids: string;
    auth_type?: string;
    constructor(config: Config, toolRegistry?: ToolRegistry);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare class EndSessionEvent implements BaseTelemetryEvent {
    'event.name': 'end_session';
    'event.timestamp': string;
    session_id?: string;
    constructor(config?: Config);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_USER_PROMPT = "gemini_cli.user_prompt";
export declare class UserPromptEvent implements BaseTelemetryEvent {
    'event.name': 'user_prompt';
    'event.timestamp': string;
    prompt_length: number;
    prompt_id: string;
    auth_type?: string;
    prompt?: string;
    constructor(prompt_length: number, prompt_Id: string, auth_type?: string, prompt?: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_TOOL_CALL = "gemini_cli.tool_call";
export declare class ToolCallEvent implements BaseTelemetryEvent {
    'event.name': 'tool_call';
    'event.timestamp': string;
    function_name: string;
    function_args: Record<string, unknown>;
    duration_ms: number;
    success: boolean;
    decision?: ToolCallDecision;
    error?: string;
    error_type?: string;
    prompt_id: string;
    tool_type: 'native' | 'mcp';
    content_length?: number;
    mcp_server_name?: string;
    extension_name?: string;
    extension_id?: string;
    start_time?: number;
    end_time?: number;
    metadata?: {
        [key: string]: any;
    };
    constructor(call: CompletedToolCall);
    constructor(call: undefined, function_name: string, function_args: Record<string, unknown>, duration_ms: number, success: boolean, prompt_id: string, tool_type: 'native' | 'mcp', error?: string, start_time?: number, end_time?: number);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_API_REQUEST = "gemini_cli.api_request";
export declare class ApiRequestEvent implements BaseTelemetryEvent {
    'event.name': 'api_request';
    'event.timestamp': string;
    model: string;
    prompt: GenAIPromptDetails;
    request_text?: string;
    role?: LlmRole;
    constructor(model: string, prompt_details: GenAIPromptDetails, request_text?: string, role?: LlmRole);
    toLogRecord(config: Config): LogRecord;
    toSemanticLogRecord(config: Config): LogRecord;
}
export declare const EVENT_API_ERROR = "gemini_cli.api_error";
export declare class ApiErrorEvent implements BaseTelemetryEvent {
    'event.name': 'api_error';
    'event.timestamp': string;
    model: string;
    prompt: GenAIPromptDetails;
    error: string;
    error_type?: string;
    status_code?: number | string;
    duration_ms: number;
    auth_type?: string;
    role?: LlmRole;
    constructor(model: string, error: string, duration_ms: number, prompt_details: GenAIPromptDetails, auth_type?: string, error_type?: string, status_code?: number | string, role?: LlmRole);
    toLogRecord(config: Config): LogRecord;
    toSemanticLogRecord(config: Config): LogRecord;
}
export interface ServerDetails {
    address: string;
    port: number;
}
export interface GenAIPromptDetails {
    prompt_id: string;
    contents: Content[];
    generate_content_config?: GenerateContentConfig;
    server?: ServerDetails;
}
export interface GenAIResponseDetails {
    response_id?: string;
    candidates?: Candidate[];
}
export interface ContextBreakdown {
    system_instructions: number;
    tool_definitions: number;
    history: number;
    tool_calls: Record<string, number>;
    mcp_servers: number;
}
export interface GenAIUsageDetails {
    input_token_count: number;
    output_token_count: number;
    cached_content_token_count: number;
    thoughts_token_count: number;
    tool_token_count: number;
    total_token_count: number;
    context_breakdown?: ContextBreakdown;
}
export declare const EVENT_API_RESPONSE = "gemini_cli.api_response";
export declare const EVENT_GEN_AI_OPERATION_DETAILS = "gen_ai.client.inference.operation.details";
export declare class ApiResponseEvent implements BaseTelemetryEvent {
    'event.name': 'api_response';
    'event.timestamp': string;
    status_code?: number | string;
    duration_ms: number;
    response_text?: string;
    auth_type?: string;
    model: string;
    prompt: GenAIPromptDetails;
    response: GenAIResponseDetails;
    usage: GenAIUsageDetails;
    finish_reasons: OTelFinishReason[];
    role?: LlmRole;
    constructor(model: string, duration_ms: number, prompt_details: GenAIPromptDetails, response_details: GenAIResponseDetails, auth_type?: string, usage_data?: GenerateContentResponseUsageMetadata, response_text?: string, role?: LlmRole);
    toLogRecord(config: Config): LogRecord;
    toSemanticLogRecord(config: Config): LogRecord;
}
export declare const EVENT_FLASH_FALLBACK = "gemini_cli.flash_fallback";
export declare class FlashFallbackEvent implements BaseTelemetryEvent {
    'event.name': 'flash_fallback';
    'event.timestamp': string;
    auth_type: string;
    constructor(auth_type: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_RIPGREP_FALLBACK = "gemini_cli.ripgrep_fallback";
export declare class RipgrepFallbackEvent implements BaseTelemetryEvent {
    error?: string | undefined;
    'event.name': 'ripgrep_fallback';
    'event.timestamp': string;
    constructor(error?: string | undefined);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare enum LoopType {
    CONSECUTIVE_IDENTICAL_TOOL_CALLS = "consecutive_identical_tool_calls",
    CHANTING_IDENTICAL_SENTENCES = "chanting_identical_sentences",
    LLM_DETECTED_LOOP = "llm_detected_loop",
    TOOL_CALL_LOOP = "consecutive_identical_tool_calls",
    CONTENT_CHANTING_LOOP = "chanting_identical_sentences"
}
export declare class LoopDetectedEvent implements BaseTelemetryEvent {
    'event.name': 'loop_detected';
    'event.timestamp': string;
    loop_type: LoopType;
    prompt_id: string;
    count: number;
    confirmed_by_model?: string;
    analysis?: string;
    confidence?: number;
    constructor(loop_type: LoopType, prompt_id: string, count: number, confirmed_by_model?: string, analysis?: string, confidence?: number);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare class LoopDetectionDisabledEvent implements BaseTelemetryEvent {
    'event.name': 'loop_detection_disabled';
    'event.timestamp': string;
    prompt_id: string;
    constructor(prompt_id: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_NEXT_SPEAKER_CHECK = "gemini_cli.next_speaker_check";
export declare class NextSpeakerCheckEvent implements BaseTelemetryEvent {
    'event.name': 'next_speaker_check';
    'event.timestamp': string;
    prompt_id: string;
    finish_reason: string;
    result: string;
    constructor(prompt_id: string, finish_reason: string, result: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_CONSECA_POLICY_GENERATION = "gemini_cli.conseca.policy_generation";
export declare class ConsecaPolicyGenerationEvent implements BaseTelemetryEvent {
    'event.name': 'conseca_policy_generation';
    'event.timestamp': string;
    user_prompt: string;
    trusted_content: string;
    policy: string;
    error?: string;
    constructor(user_prompt: string, trusted_content: string, policy: string, error?: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_CONSECA_VERDICT = "gemini_cli.conseca.verdict";
export declare class ConsecaVerdictEvent implements BaseTelemetryEvent {
    'event.name': 'conseca_verdict';
    'event.timestamp': string;
    user_prompt: string;
    policy: string;
    tool_call: string;
    verdict: string;
    verdict_rationale: string;
    error?: string;
    constructor(user_prompt: string, policy: string, tool_call: string, verdict: string, verdict_rationale: string, error?: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_SLASH_COMMAND = "gemini_cli.slash_command";
export interface SlashCommandEvent extends BaseTelemetryEvent {
    'event.name': 'slash_command';
    'event.timestamp': string;
    command: string;
    subcommand?: string;
    status?: SlashCommandStatus;
    extension_id?: string;
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare function makeSlashCommandEvent({ command, subcommand, status, extension_id, }: Omit<SlashCommandEvent, CommonFields | 'toOpenTelemetryAttributes' | 'toLogBody'>): SlashCommandEvent;
export declare enum SlashCommandStatus {
    SUCCESS = "success",
    ERROR = "error"
}
export declare const EVENT_REWIND = "gemini_cli.rewind";
export declare class RewindEvent implements BaseTelemetryEvent {
    'event.name': 'rewind';
    'event.timestamp': string;
    outcome: string;
    constructor(outcome: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_CHAT_COMPRESSION = "gemini_cli.chat_compression";
export interface ChatCompressionEvent extends BaseTelemetryEvent {
    'event.name': 'chat_compression';
    'event.timestamp': string;
    tokens_before: number;
    tokens_after: number;
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare function makeChatCompressionEvent({ tokens_before, tokens_after, }: Omit<ChatCompressionEvent, CommonFields | 'toOpenTelemetryAttributes' | 'toLogBody'>): ChatCompressionEvent;
export declare const EVENT_MALFORMED_JSON_RESPONSE = "gemini_cli.malformed_json_response";
export declare class MalformedJsonResponseEvent implements BaseTelemetryEvent {
    'event.name': 'malformed_json_response';
    'event.timestamp': string;
    model: string;
    constructor(model: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare enum IdeConnectionType {
    START = "start",
    SESSION = "session"
}
export declare const EVENT_IDE_CONNECTION = "gemini_cli.ide_connection";
export declare class IdeConnectionEvent {
    'event.name': 'ide_connection';
    'event.timestamp': string;
    connection_type: IdeConnectionType;
    constructor(connection_type: IdeConnectionType);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_CONVERSATION_FINISHED = "gemini_cli.conversation_finished";
export declare class ConversationFinishedEvent {
    'event_name': 'conversation_finished';
    'event.timestamp': string;
    approvalMode: ApprovalMode;
    turnCount: number;
    constructor(approvalMode: ApprovalMode, turnCount: number);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_FILE_OPERATION = "gemini_cli.file_operation";
export declare class FileOperationEvent implements BaseTelemetryEvent {
    'event.name': 'file_operation';
    'event.timestamp': string;
    tool_name: string;
    operation: FileOperation;
    lines?: number;
    mimetype?: string;
    extension?: string;
    programming_language?: string;
    constructor(tool_name: string, operation: FileOperation, lines?: number, mimetype?: string, extension?: string, programming_language?: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_INVALID_CHUNK = "gemini_cli.chat.invalid_chunk";
export declare class InvalidChunkEvent implements BaseTelemetryEvent {
    'event.name': 'invalid_chunk';
    'event.timestamp': string;
    error_message?: string;
    constructor(error_message?: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_CONTENT_RETRY = "gemini_cli.chat.content_retry";
export declare class ContentRetryEvent implements BaseTelemetryEvent {
    'event.name': 'content_retry';
    'event.timestamp': string;
    attempt_number: number;
    error_type: string;
    retry_delay_ms: number;
    model: string;
    constructor(attempt_number: number, error_type: string, retry_delay_ms: number, model: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_CONTENT_RETRY_FAILURE = "gemini_cli.chat.content_retry_failure";
export declare class ContentRetryFailureEvent implements BaseTelemetryEvent {
    'event.name': 'content_retry_failure';
    'event.timestamp': string;
    total_attempts: number;
    final_error_type: string;
    total_duration_ms?: number;
    model: string;
    constructor(total_attempts: number, final_error_type: string, model: string, total_duration_ms?: number);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_MODEL_ROUTING = "gemini_cli.model_routing";
export declare class ModelRoutingEvent implements BaseTelemetryEvent {
    'event.name': 'model_routing';
    'event.timestamp': string;
    decision_model: string;
    decision_source: string;
    routing_latency_ms: number;
    reasoning?: string;
    failed: boolean;
    error_message?: string;
    enable_numerical_routing?: boolean;
    classifier_threshold?: string;
    approval_mode: ApprovalMode;
    constructor(decision_model: string, decision_source: string, routing_latency_ms: number, reasoning: string | undefined, failed: boolean, error_message: string | undefined, approval_mode: ApprovalMode, enable_numerical_routing?: boolean, classifier_threshold?: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_EXTENSION_INSTALL = "gemini_cli.extension_install";
export declare class ExtensionInstallEvent implements BaseTelemetryEvent {
    'event.name': 'extension_install';
    'event.timestamp': string;
    extension_name: string;
    hashed_extension_name: string;
    extension_id: string;
    extension_version: string;
    extension_source: string;
    status: CoreToolCallStatus.Success | CoreToolCallStatus.Error;
    constructor(extension_name: string, hashed_extension_name: string, extension_id: string, extension_version: string, extension_source: string, status: CoreToolCallStatus.Success | CoreToolCallStatus.Error);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_TOOL_OUTPUT_TRUNCATED = "gemini_cli.tool_output_truncated";
export declare class ToolOutputTruncatedEvent implements BaseTelemetryEvent {
    readonly eventName = "tool_output_truncated";
    readonly 'event.timestamp': string;
    'event.name': string;
    tool_name: string;
    original_content_length: number;
    truncated_content_length: number;
    threshold: number;
    prompt_id: string;
    constructor(prompt_id: string, details: {
        toolName: string;
        originalContentLength: number;
        truncatedContentLength: number;
        threshold: number;
    });
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_TOOL_OUTPUT_MASKING = "gemini_cli.tool_output_masking";
export declare class ToolOutputMaskingEvent implements BaseTelemetryEvent {
    'event.name': 'tool_output_masking';
    'event.timestamp': string;
    tokens_before: number;
    tokens_after: number;
    masked_count: number;
    total_prunable_tokens: number;
    constructor(details: {
        tokens_before: number;
        tokens_after: number;
        masked_count: number;
        total_prunable_tokens: number;
    });
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_EXTENSION_UNINSTALL = "gemini_cli.extension_uninstall";
export declare class ExtensionUninstallEvent implements BaseTelemetryEvent {
    'event.name': 'extension_uninstall';
    'event.timestamp': string;
    extension_name: string;
    hashed_extension_name: string;
    extension_id: string;
    status: CoreToolCallStatus.Success | CoreToolCallStatus.Error;
    constructor(extension_name: string, hashed_extension_name: string, extension_id: string, status: CoreToolCallStatus.Success | CoreToolCallStatus.Error);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_EXTENSION_UPDATE = "gemini_cli.extension_update";
export declare class ExtensionUpdateEvent implements BaseTelemetryEvent {
    'event.name': 'extension_update';
    'event.timestamp': string;
    extension_name: string;
    hashed_extension_name: string;
    extension_id: string;
    extension_previous_version: string;
    extension_version: string;
    extension_source: string;
    status: CoreToolCallStatus.Success | CoreToolCallStatus.Error;
    constructor(extension_name: string, hashed_extension_name: string, extension_id: string, extension_version: string, extension_previous_version: string, extension_source: string, status: CoreToolCallStatus.Success | CoreToolCallStatus.Error);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_EXTENSION_ENABLE = "gemini_cli.extension_enable";
export declare class ExtensionEnableEvent implements BaseTelemetryEvent {
    'event.name': 'extension_enable';
    'event.timestamp': string;
    extension_name: string;
    hashed_extension_name: string;
    extension_id: string;
    setting_scope: string;
    constructor(extension_name: string, hashed_extension_name: string, extension_id: string, settingScope: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_MODEL_SLASH_COMMAND = "gemini_cli.slash_command.model";
export declare class ModelSlashCommandEvent implements BaseTelemetryEvent {
    'event.name': 'model_slash_command';
    'event.timestamp': string;
    model_name: string;
    constructor(model_name: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_LLM_LOOP_CHECK = "gemini_cli.llm_loop_check";
export declare class LlmLoopCheckEvent implements BaseTelemetryEvent {
    'event.name': 'llm_loop_check';
    'event.timestamp': string;
    prompt_id: string;
    flash_confidence: number;
    main_model: string;
    main_model_confidence: number;
    constructor(prompt_id: string, flash_confidence: number, main_model: string, main_model_confidence: number);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export type TelemetryEvent = StartSessionEvent | EndSessionEvent | UserPromptEvent | ToolCallEvent | ApiRequestEvent | ApiErrorEvent | ApiResponseEvent | FlashFallbackEvent | LoopDetectedEvent | LoopDetectionDisabledEvent | NextSpeakerCheckEvent | MalformedJsonResponseEvent | IdeConnectionEvent | ConversationFinishedEvent | SlashCommandEvent | FileOperationEvent | InvalidChunkEvent | ContentRetryEvent | ContentRetryFailureEvent | ExtensionEnableEvent | ExtensionInstallEvent | ExtensionUninstallEvent | ModelRoutingEvent | ToolOutputTruncatedEvent | ModelSlashCommandEvent | AgentStartEvent | AgentFinishEvent | RecoveryAttemptEvent | LlmLoopCheckEvent | StartupStatsEvent | WebFetchFallbackAttemptEvent | ToolOutputMaskingEvent | EditStrategyEvent | PlanExecutionEvent | RewindEvent | EditCorrectionEvent;
export declare const EVENT_EXTENSION_DISABLE = "gemini_cli.extension_disable";
export declare class ExtensionDisableEvent implements BaseTelemetryEvent {
    'event.name': 'extension_disable';
    'event.timestamp': string;
    extension_name: string;
    hashed_extension_name: string;
    extension_id: string;
    setting_scope: string;
    constructor(extension_name: string, hashed_extension_name: string, extension_id: string, settingScope: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_EDIT_STRATEGY = "gemini_cli.edit_strategy";
export declare class EditStrategyEvent implements BaseTelemetryEvent {
    'event.name': 'edit_strategy';
    'event.timestamp': string;
    strategy: string;
    constructor(strategy: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_EDIT_CORRECTION = "gemini_cli.edit_correction";
export declare class EditCorrectionEvent implements BaseTelemetryEvent {
    'event.name': 'edit_correction';
    'event.timestamp': string;
    correction: CoreToolCallStatus.Success | 'failure';
    constructor(correction: CoreToolCallStatus.Success | 'failure');
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export interface StartupPhaseStats {
    name: string;
    duration_ms: number;
    cpu_usage_user_usec: number;
    cpu_usage_system_usec: number;
    start_time_usec: number;
    end_time_usec: number;
}
export declare const EVENT_STARTUP_STATS = "gemini_cli.startup_stats";
export declare class StartupStatsEvent implements BaseTelemetryEvent {
    'event.name': 'startup_stats';
    'event.timestamp': string;
    phases: StartupPhaseStats[];
    os_platform: string;
    os_release: string;
    is_docker: boolean;
    constructor(phases: StartupPhaseStats[], os_platform: string, os_release: string, is_docker: boolean);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
declare abstract class BaseAgentEvent implements BaseTelemetryEvent {
    abstract 'event.name': 'agent_start' | 'agent_finish' | 'agent_recovery_attempt';
    'event.timestamp': string;
    agent_id: string;
    agent_name: string;
    constructor(agent_id: string, agent_name: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    abstract toLogBody(): string;
}
export declare const EVENT_AGENT_START = "gemini_cli.agent.start";
export declare class AgentStartEvent extends BaseAgentEvent {
    'event.name': "agent_start";
    constructor(agent_id: string, agent_name: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_AGENT_FINISH = "gemini_cli.agent.finish";
export declare class AgentFinishEvent extends BaseAgentEvent {
    'event.name': "agent_finish";
    duration_ms: number;
    turn_count: number;
    terminate_reason: AgentTerminateMode;
    constructor(agent_id: string, agent_name: string, duration_ms: number, turn_count: number, terminate_reason: AgentTerminateMode);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_AGENT_RECOVERY_ATTEMPT = "gemini_cli.agent.recovery_attempt";
export declare class RecoveryAttemptEvent extends BaseAgentEvent {
    'event.name': "agent_recovery_attempt";
    reason: AgentTerminateMode;
    duration_ms: number;
    success: boolean;
    turn_count: number;
    constructor(agent_id: string, agent_name: string, reason: AgentTerminateMode, duration_ms: number, success: boolean, turn_count: number);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_WEB_FETCH_FALLBACK_ATTEMPT = "gemini_cli.web_fetch_fallback_attempt";
export declare class WebFetchFallbackAttemptEvent implements BaseTelemetryEvent {
    'event.name': 'web_fetch_fallback_attempt';
    'event.timestamp': string;
    reason: 'private_ip' | 'primary_failed';
    constructor(reason: 'private_ip' | 'primary_failed');
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_HOOK_CALL = "gemini_cli.hook_call";
export declare const EVENT_APPROVAL_MODE_SWITCH = "gemini_cli.plan.approval_mode_switch";
export declare class ApprovalModeSwitchEvent implements BaseTelemetryEvent {
    eventName: string;
    from_mode: ApprovalMode;
    to_mode: ApprovalMode;
    constructor(fromMode: ApprovalMode, toMode: ApprovalMode);
    'event.name': string;
    'event.timestamp': string;
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_APPROVAL_MODE_DURATION = "gemini_cli.plan.approval_mode_duration";
export declare class ApprovalModeDurationEvent implements BaseTelemetryEvent {
    eventName: string;
    mode: ApprovalMode;
    duration_ms: number;
    constructor(mode: ApprovalMode, durationMs: number);
    'event.name': string;
    'event.timestamp': string;
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_PLAN_EXECUTION = "gemini_cli.plan.execution";
export declare class PlanExecutionEvent implements BaseTelemetryEvent {
    eventName: string;
    approval_mode: ApprovalMode;
    constructor(approvalMode: ApprovalMode);
    'event.name': string;
    'event.timestamp': string;
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare class HookCallEvent implements BaseTelemetryEvent {
    'event.name': string;
    'event.timestamp': string;
    hook_event_name: string;
    hook_type: HookType;
    hook_name: string;
    hook_input: Record<string, unknown>;
    hook_output?: Record<string, unknown>;
    exit_code?: number;
    stdout?: string;
    stderr?: string;
    duration_ms: number;
    success: boolean;
    error?: string;
    constructor(hookEventName: string, hookType: HookType, hookName: string, hookInput: Record<string, unknown>, durationMs: number, success: boolean, hookOutput?: Record<string, unknown>, exitCode?: number, stdout?: string, stderr?: string, error?: string);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_KEYCHAIN_AVAILABILITY = "gemini_cli.keychain.availability";
export declare class KeychainAvailabilityEvent implements BaseTelemetryEvent {
    'event.name': 'keychain_availability';
    'event.timestamp': string;
    available: boolean;
    constructor(available: boolean);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
export declare const EVENT_TOKEN_STORAGE_INITIALIZATION = "gemini_cli.token_storage.initialization";
export declare class TokenStorageInitializationEvent implements BaseTelemetryEvent {
    'event.name': 'token_storage_initialization';
    'event.timestamp': string;
    type: string;
    forced: boolean;
    constructor(type: string, forced: boolean);
    toOpenTelemetryAttributes(config: Config): LogAttributes;
    toLogBody(): string;
}
