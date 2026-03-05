/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { GenerateContentResponse, type Content, type ContentListUnion, type GenerateContentParameters, type CountTokensParameters, type CountTokensResponse, type GenerationConfigRoutingConfig, type MediaResolution, type Candidate, type ModelSelectionConfig, type GenerateContentResponsePromptFeedback, type GenerateContentResponseUsageMetadata, type Part, type SafetySetting, type PartUnion, type SpeechConfigUnion, type ThinkingConfig, type ToolListUnion, type ToolConfig } from '@google/genai';
import type { Credits } from './types.js';
export interface CAGenerateContentRequest {
    model: string;
    project?: string;
    user_prompt_id?: string;
    request: VertexGenerateContentRequest;
    enabled_credit_types?: string[];
}
interface VertexGenerateContentRequest {
    contents: Content[];
    systemInstruction?: Content;
    cachedContent?: string;
    tools?: ToolListUnion;
    toolConfig?: ToolConfig;
    labels?: Record<string, string>;
    safetySettings?: SafetySetting[];
    generationConfig?: VertexGenerationConfig;
    session_id?: string;
}
interface VertexGenerationConfig {
    temperature?: number;
    topP?: number;
    topK?: number;
    candidateCount?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseLogprobs?: boolean;
    logprobs?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    seed?: number;
    responseMimeType?: string;
    responseJsonSchema?: unknown;
    responseSchema?: unknown;
    routingConfig?: GenerationConfigRoutingConfig;
    modelSelectionConfig?: ModelSelectionConfig;
    responseModalities?: string[];
    mediaResolution?: MediaResolution;
    speechConfig?: SpeechConfigUnion;
    audioTimestamp?: boolean;
    thinkingConfig?: ThinkingConfig;
}
export interface CaGenerateContentResponse {
    response?: VertexGenerateContentResponse;
    traceId?: string;
    consumedCredits?: Credits[];
    remainingCredits?: Credits[];
}
interface VertexGenerateContentResponse {
    candidates?: Candidate[];
    automaticFunctionCallingHistory?: Content[];
    promptFeedback?: GenerateContentResponsePromptFeedback;
    usageMetadata?: GenerateContentResponseUsageMetadata;
    modelVersion?: string;
}
export interface CaCountTokenRequest {
    request: VertexCountTokenRequest;
}
interface VertexCountTokenRequest {
    model: string;
    contents: Content[];
}
export interface CaCountTokenResponse {
    totalTokens?: number;
}
export declare function toCountTokenRequest(req: CountTokensParameters): CaCountTokenRequest;
export declare function fromCountTokenResponse(res: CaCountTokenResponse): CountTokensResponse;
export declare function toGenerateContentRequest(req: GenerateContentParameters, userPromptId: string, project?: string, sessionId?: string, enabledCreditTypes?: string[]): CAGenerateContentRequest;
export declare function fromGenerateContentResponse(res: CaGenerateContentResponse): GenerateContentResponse;
export declare function toContents(contents: ContentListUnion): Content[];
export declare function toParts(parts: PartUnion[]): Part[];
export declare function fromGenerateContentResponseUsage(metadata?: GenerateContentResponseUsageMetadata): GenerateContentResponseUsageMetadata | undefined;
export {};
