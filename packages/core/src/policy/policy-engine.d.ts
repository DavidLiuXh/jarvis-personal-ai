/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type FunctionCall } from '@google/genai';
import { type PolicyEngineConfig, type PolicyRule, type SafetyCheckerRule, type HookCheckerRule, ApprovalMode, type CheckResult } from './types.js';
import type { CheckerRunner } from '../safety/checker-runner.js';
export declare class PolicyEngine {
    private rules;
    private checkers;
    private hookCheckers;
    private readonly defaultDecision;
    private readonly nonInteractive;
    private readonly checkerRunner?;
    private approvalMode;
    constructor(config?: PolicyEngineConfig, checkerRunner?: CheckerRunner);
    /**
     * Update the current approval mode.
     */
    setApprovalMode(mode: ApprovalMode): void;
    /**
     * Get the current approval mode.
     */
    getApprovalMode(): ApprovalMode;
    private shouldDowngradeForRedirection;
    /**
     * Check if a shell command is allowed.
     */
    private checkShellCommand;
    /**
     * Check if a tool call is allowed based on the configured policies.
     * Returns the decision and the matching rule (if any).
     */
    check(toolCall: FunctionCall, serverName: string | undefined, toolAnnotations?: Record<string, unknown>): Promise<CheckResult>;
    /**
     * Add a new rule to the policy engine.
     */
    addRule(rule: PolicyRule): void;
    addChecker(checker: SafetyCheckerRule): void;
    /**
     * Remove rules matching a specific tier (priority band).
     */
    removeRulesByTier(tier: number): void;
    /**
     * Remove rules matching a specific source.
     */
    removeRulesBySource(source: string): void;
    /**
     * Remove checkers matching a specific tier (priority band).
     */
    removeCheckersByTier(tier: number): void;
    /**
     * Remove checkers matching a specific source.
     */
    removeCheckersBySource(source: string): void;
    /**
     * Remove rules for a specific tool.
     * If source is provided, only rules matching that source are removed.
     */
    removeRulesForTool(toolName: string, source?: string): void;
    /**
     * Get all current rules.
     */
    getRules(): readonly PolicyRule[];
    /**
     * Check if a rule for a specific tool already exists.
     * If ignoreDynamic is true, it only returns true if a rule exists that was NOT added by AgentRegistry.
     */
    hasRuleForTool(toolName: string, ignoreDynamic?: boolean): boolean;
    getCheckers(): readonly SafetyCheckerRule[];
    /**
     * Add a new hook checker to the policy engine.
     */
    addHookChecker(checker: HookCheckerRule): void;
    /**
     * Get all current hook checkers.
     */
    getHookCheckers(): readonly HookCheckerRule[];
    /**
     * Get tools that are effectively denied by the current rules.
     * This takes into account:
     * 1. Global rules (no argsPattern)
     * 2. Priority order (higher priority wins)
     * 3. Non-interactive mode (ASK_USER becomes DENY)
     * 4. Annotation-based rules (when toolMetadata is provided)
     *
     * @param toolMetadata Optional map of tool names to their annotations.
     *   When provided, annotation-based rules can match tools by their metadata.
     *   When not provided, rules with toolAnnotations are skipped (conservative fallback).
     */
    getExcludedTools(toolMetadata?: Map<string, Record<string, unknown>>, allToolNames?: Set<string>): Set<string>;
    private applyNonInteractiveMode;
}
