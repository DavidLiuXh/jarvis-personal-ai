/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { UserTierId, type GeminiUserTier, type IneligibleTier } from './types.js';
import { type HttpOptions } from './server.js';
import type { AuthClient } from 'google-auth-library';
import type { ValidationHandler } from '../fallback/types.js';
export declare class ProjectIdRequiredError extends Error {
    constructor();
}
/**
 * Error thrown when user cancels the validation process.
 * This is a non-recoverable error that should result in auth failure.
 */
export declare class ValidationCancelledError extends Error {
    constructor();
}
export declare class IneligibleTierError extends Error {
    readonly ineligibleTiers: IneligibleTier[];
    constructor(ineligibleTiers: IneligibleTier[]);
}
export interface UserData {
    projectId: string;
    userTier: UserTierId;
    userTierName?: string;
    paidTier?: GeminiUserTier;
}
/**
 * Sets up the user by loading their Code Assist configuration and onboarding if needed.
 *
 * Tier eligibility:
 * - FREE tier: Eligibility is determined by the Code Assist server response.
 * - STANDARD tier: User is always eligible if they have a valid project ID.
 *
 * If no valid project ID is available (from env var or server response):
 * - Surfaces ineligibility reasons for the FREE tier from the server.
 * - Throws ProjectIdRequiredError if no ineligibility reasons are available.
 *
 * Handles VALIDATION_REQUIRED via the optional validation handler, allowing
 * retry, auth change, or cancellation.
 *
 * @param client - The authenticated client to use for API calls
 * @param validationHandler - Optional handler for account validation flow
 * @returns The user's project ID, tier ID, and tier name
 * @throws {ValidationRequiredError} If account validation is required
 * @throws {ProjectIdRequiredError} If no project ID is available and required
 * @throws {ValidationCancelledError} If user cancels validation
 * @throws {ChangeAuthRequestedError} If user requests to change auth method
 */
export declare function setupUser(client: AuthClient, validationHandler?: ValidationHandler, httpOptions?: HttpOptions): Promise<UserData>;
