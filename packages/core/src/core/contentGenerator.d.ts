/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type CountTokensResponse, type GenerateContentResponse, type GenerateContentParameters, type CountTokensParameters, type EmbedContentResponse, type EmbedContentParameters } from '@google/genai';
import type { Config } from '../config/config.js';
import type { UserTierId, GeminiUserTier } from '../code_assist/types.js';
import type { LlmRole } from '../telemetry/llmRole.js';
/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
    generateContent(request: GenerateContentParameters, userPromptId: string, role: LlmRole): Promise<GenerateContentResponse>;
    generateContentStream(request: GenerateContentParameters, userPromptId: string, role: LlmRole): Promise<AsyncGenerator<GenerateContentResponse>>;
    countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;
    embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;
    userTier?: UserTierId;
    userTierName?: string;
    paidTier?: GeminiUserTier;
}
export declare enum AuthType {
    LOGIN_WITH_GOOGLE = "oauth-personal",
    USE_GEMINI = "gemini-api-key",
    USE_VERTEX_AI = "vertex-ai",
    LEGACY_CLOUD_SHELL = "cloud-shell",
    COMPUTE_ADC = "compute-default-credentials"
}
/**
 * Detects the best authentication type based on environment variables.
 *
 * Checks in order:
 * 1. GOOGLE_GENAI_USE_GCA=true -> LOGIN_WITH_GOOGLE
 * 2. GOOGLE_GENAI_USE_VERTEXAI=true -> USE_VERTEX_AI
 * 3. GEMINI_API_KEY -> USE_GEMINI
 */
export declare function getAuthTypeFromEnv(): AuthType | undefined;
export type ContentGeneratorConfig = {
    apiKey?: string;
    vertexai?: boolean;
    authType?: AuthType;
    proxy?: string;
};
export declare function createContentGeneratorConfig(config: Config, authType: AuthType | undefined, apiKey?: string): Promise<ContentGeneratorConfig>;
export declare function createContentGenerator(config: ContentGeneratorConfig, gcConfig: Config, sessionId?: string): Promise<ContentGenerator>;
