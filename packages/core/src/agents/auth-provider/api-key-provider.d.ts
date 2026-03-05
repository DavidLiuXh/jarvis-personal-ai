/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { HttpHeaders } from '@a2a-js/sdk/client';
import { BaseA2AAuthProvider } from './base-provider.js';
import type { ApiKeyAuthConfig } from './types.js';
/**
 * Authentication provider for API Key authentication.
 * Sends the API key as an HTTP header.
 *
 * The API key value can be:
 * - A literal string
 * - An environment variable reference ($ENV_VAR)
 * - A shell command (!command)
 */
export declare class ApiKeyAuthProvider extends BaseA2AAuthProvider {
    private readonly config;
    readonly type: "apiKey";
    private resolvedKey;
    private readonly headerName;
    constructor(config: ApiKeyAuthConfig);
    initialize(): Promise<void>;
    headers(): Promise<HttpHeaders>;
    /**
     * Re-resolve command-based API keys on auth failure.
     */
    shouldRetryWithHeaders(_req: RequestInit, res: Response): Promise<HttpHeaders | undefined>;
}
