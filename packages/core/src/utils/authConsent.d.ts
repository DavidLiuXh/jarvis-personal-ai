/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Requests consent from the user for OAuth login.
 * Handles both interactive and non-interactive (headless) modes.
 */
export declare function getConsentForOauth(prompt: string): Promise<boolean>;
