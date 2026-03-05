/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type Content } from '@google/genai';
import type { Config } from '../config/config.js';
/**
 * A client for making single, non-streaming calls to a local Gemini-compatible API
 * and expecting a JSON response.
 */
export declare class LocalLiteRtLmClient {
    private readonly host;
    private readonly model;
    private readonly client;
    constructor(config: Config);
    /**
     * Sends a prompt to the local Gemini model and expects a JSON object in response.
     * @param contents The history and current prompt.
     * @param systemInstruction The system prompt.
     * @returns A promise that resolves to the parsed JSON object.
     */
    generateJson(contents: Content[], systemInstruction: string, reminder?: string, abortSignal?: AbortSignal): Promise<object>;
}
