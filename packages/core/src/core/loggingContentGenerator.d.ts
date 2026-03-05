/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Content, CountTokensParameters, CountTokensResponse, EmbedContentParameters, EmbedContentResponse, GenerateContentConfig, GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { type ContextBreakdown } from '../telemetry/types.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import type { Config } from '../config/config.js';
import type { UserTierId, GeminiUserTier } from '../code_assist/types.js';
import type { ContentGenerator } from './contentGenerator.js';
/**
 * Estimates the context breakdown for telemetry. All returned fields are
 * additive (non-overlapping), so their sum approximates the total context size.
 *
 * - system_instructions: tokens from system instruction config
 * - tool_definitions: tokens from non-MCP tool definitions
 * - history: tokens from conversation history, excluding tool call/response parts
 * - tool_calls: per-tool token counts for non-MCP function call + response parts
 * - mcp_servers: tokens from MCP tool definitions + MCP tool call/response parts
 *
 * MCP tool calls are excluded from tool_calls and counted only in mcp_servers
 * to keep fields non-overlapping and avoid leaking MCP server names in telemetry.
 */
export declare function estimateContextBreakdown(contents: Content[], config?: GenerateContentConfig): ContextBreakdown;
export declare class LoggingContentGenerator implements ContentGenerator {
    private readonly wrapped;
    private readonly config;
    constructor(wrapped: ContentGenerator, config: Config);
    getWrapped(): ContentGenerator;
    get userTier(): UserTierId | undefined;
    get userTierName(): string | undefined;
    get paidTier(): GeminiUserTier | undefined;
    private logApiRequest;
    private _getEndpointUrl;
    private _logApiResponse;
    private _fixGaxiosErrorData;
    private _logApiError;
    generateContent(req: GenerateContentParameters, userPromptId: string, role: LlmRole): Promise<GenerateContentResponse>;
    generateContentStream(req: GenerateContentParameters, userPromptId: string, role: LlmRole): Promise<AsyncGenerator<GenerateContentResponse>>;
    private loggingStreamWrapper;
    countTokens(req: CountTokensParameters): Promise<CountTokensResponse>;
    embedContent(req: EmbedContentParameters): Promise<EmbedContentResponse>;
}
