/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type ServerGeminiStreamEvent } from '../core/turn.js';
import { LoopType } from '../telemetry/types.js';
import type { Config } from '../config/config.js';
/**
 * Result of a loop detection check.
 */
export interface LoopDetectionResult {
    count: number;
    type?: LoopType;
    detail?: string;
    confirmedByModel?: string;
}
/**
 * Service for detecting and preventing infinite loops in AI responses.
 * Monitors tool call repetitions and content sentence repetitions.
 */
export declare class LoopDetectionService {
    private readonly config;
    private promptId;
    private userPrompt;
    private lastToolCallKey;
    private toolCallRepetitionCount;
    private streamContentHistory;
    private contentStats;
    private lastContentIndex;
    private loopDetected;
    private detectedCount;
    private lastLoopDetail?;
    private inCodeBlock;
    private lastLoopType?;
    private turnsInCurrentPrompt;
    private llmCheckInterval;
    private lastCheckTurn;
    private disabledForSession;
    constructor(config: Config);
    /**
     * Disables loop detection for the current session.
     */
    disableForSession(): void;
    private getToolCallKey;
    /**
     * Processes a stream event and checks for loop conditions.
     * @param event - The stream event to process
     * @returns A LoopDetectionResult
     */
    addAndCheck(event: ServerGeminiStreamEvent): LoopDetectionResult;
    /**
     * Signals the start of a new turn in the conversation.
     *
     * This method increments the turn counter and, if specific conditions are met,
     * triggers an LLM-based check to detect potential conversation loops. The check
     * is performed periodically based on the `llmCheckInterval`.
     *
     * @param signal - An AbortSignal to allow for cancellation of the asynchronous LLM check.
     * @returns A promise that resolves to a LoopDetectionResult.
     */
    turnStarted(signal: AbortSignal): Promise<LoopDetectionResult>;
    private checkToolCallLoop;
    /**
     * Detects content loops by analyzing streaming text for repetitive patterns.
     *
     * The algorithm works by:
     * 1. Appending new content to the streaming history
     * 2. Truncating history if it exceeds the maximum length
     * 3. Analyzing content chunks for repetitive patterns using hashing
     * 4. Detecting loops when identical chunks appear frequently within a short distance
     * 5. Disabling loop detection within code blocks to prevent false positives,
     *    as repetitive code structures are common and not necessarily loops.
     */
    private checkContentLoop;
    /**
     * Truncates the content history to prevent unbounded memory growth.
     * When truncating, adjusts all stored indices to maintain their relative positions.
     */
    private truncateAndUpdate;
    /**
     * Analyzes content in fixed-size chunks to detect repetitive patterns.
     *
     * Uses a sliding window approach:
     * 1. Extract chunks of fixed size (CONTENT_CHUNK_SIZE)
     * 2. Hash each chunk for efficient comparison
     * 3. Track positions where identical chunks appear
     * 4. Detect loops when chunks repeat frequently within a short distance
     */
    private analyzeContentChunksForLoop;
    private hasMoreChunksToProcess;
    /**
     * Determines if a content chunk indicates a loop pattern.
     *
     * Loop detection logic:
     * 1. Check if we've seen this hash before (new chunks are stored for future comparison)
     * 2. Verify actual content matches to prevent hash collisions
     * 3. Track all positions where this chunk appears
     * 4. A loop is detected when the same chunk appears CONTENT_LOOP_THRESHOLD times
     *    within a small average distance (≤ 5 * chunk size)
     */
    private isLoopDetectedForChunk;
    /**
     * Verifies that two chunks with the same hash actually contain identical content.
     * This prevents false positives from hash collisions.
     */
    private isActualContentMatch;
    private trimRecentHistory;
    private checkForLoopWithLLM;
    private queryLoopDetectionModel;
    private updateCheckInterval;
    /**
     * Resets all loop detection state.
     */
    reset(promptId: string, userPrompt?: string): void;
    /**
     * Resets the loop detected flag to allow a recovery turn to proceed.
     * This preserves the detectedCount so that the next detection will be count 2.
     */
    clearDetection(): void;
    private resetToolCallCount;
    private resetContentTracking;
    private resetLlmCheckTracking;
}
