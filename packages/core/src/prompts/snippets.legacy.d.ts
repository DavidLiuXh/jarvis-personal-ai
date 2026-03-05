/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { HierarchicalMemory } from '../config/memory.js';
export interface SystemPromptOptions {
    preamble?: PreambleOptions;
    coreMandates?: CoreMandatesOptions;
    subAgents?: SubAgentOptions[];
    agentSkills?: AgentSkillOptions[];
    hookContext?: boolean;
    primaryWorkflows?: PrimaryWorkflowsOptions;
    planningWorkflow?: PlanningWorkflowOptions;
    operationalGuidelines?: OperationalGuidelinesOptions;
    sandbox?: SandboxMode;
    interactiveYoloMode?: boolean;
    gitRepo?: GitRepoOptions;
    finalReminder?: FinalReminderOptions;
}
export interface PreambleOptions {
    interactive: boolean;
}
export interface CoreMandatesOptions {
    interactive: boolean;
    isGemini3: boolean;
    hasSkills: boolean;
    hasHierarchicalMemory: boolean;
}
export interface PrimaryWorkflowsOptions {
    interactive: boolean;
    enableCodebaseInvestigator: boolean;
    enableWriteTodosTool: boolean;
    enableEnterPlanModeTool: boolean;
    approvedPlan?: {
        path: string;
    };
}
export interface OperationalGuidelinesOptions {
    interactive: boolean;
    isGemini3: boolean;
    enableShellEfficiency: boolean;
    interactiveShellEnabled: boolean;
}
export type SandboxMode = 'macos-seatbelt' | 'generic' | 'outside';
export interface GitRepoOptions {
    interactive: boolean;
}
export interface FinalReminderOptions {
    readFileToolName: string;
}
export interface PlanningWorkflowOptions {
    planModeToolsList: string;
    plansDir: string;
    approvedPlanPath?: string;
}
export interface AgentSkillOptions {
    name: string;
    description: string;
    location: string;
}
export interface SubAgentOptions {
    name: string;
    description: string;
}
/**
 * Composes the core system prompt from its constituent subsections.
 * Adheres to the minimal complexity principle by using simple interpolation of function calls.
 */
export declare function getCoreSystemPrompt(options: SystemPromptOptions): string;
/**
 * Wraps the base prompt with user memory and approval mode plans.
 */
export declare function renderFinalShell(basePrompt: string, userMemory?: string | HierarchicalMemory): string;
export declare function renderPreamble(options?: PreambleOptions): string;
export declare function renderCoreMandates(options?: CoreMandatesOptions): string;
export declare function renderSubAgents(subAgents?: SubAgentOptions[]): string;
export declare function renderAgentSkills(skills?: AgentSkillOptions[]): string;
export declare function renderHookContext(enabled?: boolean): string;
export declare function renderPrimaryWorkflows(options?: PrimaryWorkflowsOptions): string;
export declare function renderOperationalGuidelines(options?: OperationalGuidelinesOptions): string;
export declare function renderSandbox(mode?: SandboxMode): string;
export declare function renderInteractiveYoloMode(enabled?: boolean): string;
export declare function renderGitRepo(options?: GitRepoOptions): string;
export declare function renderFinalReminder(options?: FinalReminderOptions): string;
export declare function renderUserMemory(memory?: string | HierarchicalMemory): string;
export declare function renderPlanningWorkflow(options?: PlanningWorkflowOptions): string;
/**
 * Provides the system prompt for history compression.
 */
export declare function getCompressionPrompt(): string;
