/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { Storage } from '../config/storage.js';
import { ApprovalMode, type PolicyEngineConfig, type PolicyRule, type PolicySettings, type SafetyCheckerRule } from './types.js';
import type { PolicyEngine } from './policy-engine.js';
import { type PolicyFileError } from './toml-loader.js';
import { type MessageBus } from '../confirmation-bus/message-bus.js';
export declare const DEFAULT_CORE_POLICIES_DIR: string;
export declare const DEFAULT_POLICY_TIER = 1;
export declare const EXTENSION_POLICY_TIER = 2;
export declare const WORKSPACE_POLICY_TIER = 3;
export declare const USER_POLICY_TIER = 4;
export declare const ADMIN_POLICY_TIER = 5;
export declare const ALWAYS_ALLOW_PRIORITY: number;
export declare const MCP_EXCLUDED_PRIORITY: number;
export declare const EXCLUDE_TOOLS_FLAG_PRIORITY: number;
export declare const ALLOWED_TOOLS_FLAG_PRIORITY: number;
export declare const TRUSTED_MCP_SERVER_PRIORITY: number;
export declare const ALLOWED_MCP_SERVER_PRIORITY: number;
/**
 * Gets the list of directories to search for policy files, in order of increasing priority
 * (Default -> Extension -> Workspace -> User -> Admin).
 *
 * Note: Extension policies are loaded separately by the extension manager.
 *
 * @param defaultPoliciesDir Optional path to a directory containing default policies.
 * @param policyPaths Optional user-provided policy paths (from --policy flag).
 *   When provided, these replace the default user policies directory.
 * @param workspacePoliciesDir Optional path to a directory containing workspace policies.
 */
export declare function getPolicyDirectories(defaultPoliciesDir?: string, policyPaths?: string[], workspacePoliciesDir?: string): string[];
/**
 * Determines the policy tier (1=default, 2=extension, 3=workspace, 4=user, 5=admin) for a given directory.
 * This is used by the TOML loader to assign priority bands.
 */
export declare function getPolicyTier(dir: string, defaultPoliciesDir?: string, workspacePoliciesDir?: string): number;
/**
 * Formats a policy file error for console logging.
 */
export declare function formatPolicyError(error: PolicyFileError): string;
/**
 * Loads and sanitizes policies from an extension's policies directory.
 * Security: Filters out 'ALLOW' rules and YOLO mode configurations.
 */
export declare function loadExtensionPolicies(extensionName: string, policyDir: string): Promise<{
    rules: PolicyRule[];
    checkers: SafetyCheckerRule[];
    errors: PolicyFileError[];
}>;
export declare function createPolicyEngineConfig(settings: PolicySettings, approvalMode: ApprovalMode, defaultPoliciesDir?: string): Promise<PolicyEngineConfig>;
export declare function createPolicyUpdater(policyEngine: PolicyEngine, messageBus: MessageBus, storage: Storage): void;
