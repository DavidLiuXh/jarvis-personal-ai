/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { HttpHeaders } from '@a2a-js/sdk/client';
import { BaseA2AAuthProvider } from './base-provider.js';
import type { HttpAuthConfig } from './types.js';
/**
 * Authentication provider for HTTP authentication schemes.
 * Supports Bearer, Basic, and any IANA-registered scheme via raw value.
 */
export declare class HttpAuthProvider extends BaseA2AAuthProvider {
    private readonly config;
    readonly type: "http";
    private resolvedToken?;
    private resolvedUsername?;
    private resolvedPassword?;
    private resolvedValue?;
    constructor(config: HttpAuthConfig);
    initialize(): Promise<void>;
    headers(): Promise<HttpHeaders>;
    /**
     * Re-resolves credentials on auth failure (e.g. rotated tokens via $ENV or !command).
     * Respects MAX_AUTH_RETRIES from the base class to prevent infinite loops.
     */
    shouldRetryWithHeaders(req: RequestInit, res: Response): Promise<HttpHeaders | undefined>;
}
