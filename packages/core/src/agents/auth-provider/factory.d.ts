/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AgentCard, SecurityScheme } from '@a2a-js/sdk';
import type { A2AAuthConfig, A2AAuthProvider, AuthValidationResult } from './types.js';
export interface CreateAuthProviderOptions {
    /** Required for OAuth/OIDC token storage. */
    agentName?: string;
    authConfig?: A2AAuthConfig;
    agentCard?: AgentCard;
}
/**
 * Factory for creating A2A authentication providers.
 * @see https://a2a-protocol.org/latest/specification/#451-securityscheme
 */
export declare class A2AAuthProviderFactory {
    static create(options: CreateAuthProviderOptions): Promise<A2AAuthProvider | undefined>;
    /** Create provider directly from config, bypassing AgentCard validation. */
    static createFromConfig(authConfig: A2AAuthConfig, agentName?: string): Promise<A2AAuthProvider>;
    /** Validate auth config against AgentCard's security requirements. */
    static validateAuthConfig(authConfig: A2AAuthConfig | undefined, securitySchemes: Record<string, SecurityScheme> | undefined): AuthValidationResult;
    private static findMatchingScheme;
    /** Get human-readable description of required auth for error messages. */
    static describeRequiredAuth(securitySchemes: Record<string, SecurityScheme>): string;
}
