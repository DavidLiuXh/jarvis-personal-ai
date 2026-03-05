/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CountTokensResponse, GenerateContentParameters, GenerateContentResponse, CountTokensParameters, EmbedContentResponse, EmbedContentParameters } from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import type { UserTierId } from '../code_assist/types.js';
import type { LlmRole } from '../telemetry/types.js';
export declare class RecordingContentGenerator implements ContentGenerator {
    private readonly realGenerator;
    private readonly filePath;
    constructor(realGenerator: ContentGenerator, filePath: string);
    get userTier(): UserTierId | undefined;
    get userTierName(): string | undefined;
    generateContent(request: GenerateContentParameters, userPromptId: string, role: LlmRole): Promise<GenerateContentResponse>;
    generateContentStream(request: GenerateContentParameters, userPromptId: string, role: LlmRole): Promise<AsyncGenerator<GenerateContentResponse>>;
    countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;
    embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;
}
