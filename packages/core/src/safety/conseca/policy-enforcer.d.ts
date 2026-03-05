/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../../config/config.js';
import type { FunctionCall } from '@google/genai';
import { type SafetyCheckResult } from '../protocol.js';
import type { SecurityPolicy } from './types.js';
/**
 * Enforces the security policy for a given tool call.
 */
export declare function enforcePolicy(policy: SecurityPolicy, toolCall: FunctionCall, config: Config): Promise<SafetyCheckResult>;
