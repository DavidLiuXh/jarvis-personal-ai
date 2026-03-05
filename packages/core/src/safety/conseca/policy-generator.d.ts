/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../../config/config.js';
import type { SecurityPolicy } from './types.js';
export interface PolicyGenerationResult {
    policy: SecurityPolicy;
    error?: string;
}
/**
 * Generates a security policy for the given user prompt and trusted content.
 */
export declare function generatePolicy(userPrompt: string, trustedContent: string, config: Config): Promise<PolicyGenerationResult>;
