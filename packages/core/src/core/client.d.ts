/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type PartListUnion, type Content, type GenerateContentResponse } from '@google/genai';
import { Turn, type ServerGeminiStreamEvent, type ChatCompressionInfo } from './turn.js';
import type { Config } from '../config/config.js';
import { GeminiChat } from './geminiChat.js';
import type { ChatRecordingService, ResumedSessionData } from '../services/chatRecordingService.js';
import { LoopDetectionService } from '../services/loopDetectionService.js';
import { type LlmRole } from '../telemetry/types.js';
import type { ModelConfigKey } from '../services/modelConfigService.js';
export declare class GeminiClient {
    private readonly config;
    private chat?;
    private sessionTurnCount;
    private readonly loopDetector;
    private readonly compressionService;
    private readonly toolOutputMaskingService;
    private lastPromptId;
    private currentSequenceModel;
    private lastSentIdeContext;
    private forceFullIdeContext;
    /**
     * At any point in this conversation, was compression triggered without
     * being forced and did it fail?
     */
    private hasFailedCompressionAttempt;
    constructor(config: Config);
    private handleModelChanged;
    private hookStateMap;
    private fireBeforeAgentHookSafe;
    private fireAfterAgentHookSafe;
    private updateTelemetryTokenCount;
    initialize(): Promise<void>;
    private getContentGeneratorOrFail;
    addHistory(content: Content): Promise<void>;
    getChat(): GeminiChat;
    isInitialized(): boolean;
    getHistory(): Content[];
    stripThoughtsFromHistory(): void;
    setHistory(history: Content[]): void;
    private lastUsedModelId?;
    setTools(modelId?: string): Promise<void>;
    resetChat(): Promise<void>;
    dispose(): void;
    resumeChat(history: Content[], resumedSessionData?: ResumedSessionData): Promise<void>;
    getChatRecordingService(): ChatRecordingService | undefined;
    getLoopDetectionService(): LoopDetectionService;
    getCurrentSequenceModel(): string | null;
    addDirectoryContext(): Promise<void>;
    updateSystemInstruction(): void;
    startChat(extraHistory?: Content[], resumedSessionData?: ResumedSessionData): Promise<GeminiChat>;
    private getIdeContextParts;
    private _getActiveModelForCurrentTurn;
    private processTurn;
    sendMessageStream(request: PartListUnion, signal: AbortSignal, prompt_id: string, turns?: number, isInvalidStreamRetry?: boolean, displayContent?: PartListUnion): AsyncGenerator<ServerGeminiStreamEvent, Turn>;
    generateContent(modelConfigKey: ModelConfigKey, contents: Content[], abortSignal: AbortSignal, role: LlmRole): Promise<GenerateContentResponse>;
    tryCompressChat(prompt_id: string, force?: boolean): Promise<ChatCompressionInfo>;
    /**
     * Masks bulky tool outputs to save context window space.
     */
    private tryMaskToolOutputs;
    /**
     * Handles loop recovery by providing feedback to the model and initiating a new turn.
     */
    private _recoverFromLoop;
}
