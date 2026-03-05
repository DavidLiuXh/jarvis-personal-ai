/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CreditType, GeminiUserTier } from '../code_assist/types.js';
/**
 * Strategy for handling quota exhaustion when AI credits are available.
 * - 'ask': Prompt the user each time
 * - 'always': Automatically use credits
 * - 'never': Never use credits, show standard fallback
 */
export type OverageStrategy = 'ask' | 'always' | 'never';
/** Credit type for Google One AI credits */
export declare const G1_CREDIT_TYPE: CreditType;
/**
 * The set of models that support AI credits overage billing.
 * Only these models are eligible for the credits-based retry flow.
 */
export declare const OVERAGE_ELIGIBLE_MODELS: Set<string>;
/**
 * Checks if a model is eligible for AI credits overage billing.
 * @param model The model name to check.
 * @returns true if the model supports credits overage, false otherwise.
 */
export declare function isOverageEligibleModel(model: string): boolean;
/**
 * Wraps a URL in the AccountChooser redirect to maintain user context.
 * @param email User's email address for account selection
 * @param continueUrl The destination URL after account selection
 * @returns The full AccountChooser redirect URL
 */
export declare function wrapInAccountChooser(email: string, continueUrl: string): string;
/**
 * UTM campaign identifiers per the design doc.
 */
export declare const G1_UTM_CAMPAIGNS: {
    /** From Interception Flow "Manage" link (user has credits) */
    readonly MANAGE_ACTIVITY: "hydrogen_cli_settings_ai_credits_activity_page";
    /** From "Manage" to add more credits */
    readonly MANAGE_ADD_CREDITS: "hydrogen_cli_settings_add_credits";
    /** From Empty Wallet Flow "Get AI Credits" link */
    readonly EMPTY_WALLET_ADD_CREDITS: "hydrogen_cli_insufficient_credits_add_credits";
};
/**
 * Builds a G1 AI URL with UTM tracking parameters.
 * @param path The path segment (e.g., 'activity' or 'credits')
 * @param email User's email for AccountChooser wrapper
 * @param campaign The UTM campaign identifier
 * @returns The complete URL wrapped in AccountChooser
 */
export declare function buildG1Url(path: 'activity' | 'credits', email: string, campaign: string): string;
/**
 * Extracts the G1 AI credit balance from a tier's available credits.
 * @param tier The user tier to check
 * @returns The credit amount as a number, 0 if eligible but empty, or null if not eligible
 */
export declare function getG1CreditBalance(tier: GeminiUserTier | null | undefined): number | null;
export declare const MIN_CREDIT_BALANCE = 50;
/**
 * Determines if credits should be automatically used based on the overage strategy.
 * @param strategy The configured overage strategy
 * @param creditBalance The available credit balance
 * @returns true if credits should be auto-used, false otherwise
 */
export declare function shouldAutoUseCredits(strategy: OverageStrategy, creditBalance: number | null): boolean;
/**
 * Determines if the overage menu should be shown based on the strategy.
 * @param strategy The configured overage strategy
 * @param creditBalance The available credit balance
 * @returns true if the menu should be shown
 */
export declare function shouldShowOverageMenu(strategy: OverageStrategy, creditBalance: number | null): boolean;
/**
 * Determines if the empty wallet menu should be shown.
 * @param strategy The configured overage strategy
 * @param creditBalance The available credit balance
 * @returns true if the empty wallet menu should be shown
 */
export declare function shouldShowEmptyWalletMenu(strategy: OverageStrategy, creditBalance: number | null): boolean;
