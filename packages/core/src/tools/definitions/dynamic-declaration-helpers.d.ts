/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Reusable logic for generating tool declarations that depend on runtime state
 * (OS, platforms, or dynamic schema values like available skills).
 */
import { type FunctionDeclaration } from '@google/genai';
/**
 * Generates the platform-specific description for the shell tool.
 */
export declare function getShellToolDescription(enableInteractiveShell: boolean, enableEfficiency: boolean): string;
/**
 * Returns the platform-specific description for the 'command' parameter.
 */
export declare function getCommandDescription(): string;
/**
 * Returns the FunctionDeclaration for the shell tool.
 */
export declare function getShellDeclaration(enableInteractiveShell: boolean, enableEfficiency: boolean): FunctionDeclaration;
/**
 * Returns the FunctionDeclaration for exiting plan mode.
 */
export declare function getExitPlanModeDeclaration(plansDir: string): FunctionDeclaration;
/**
 * Returns the FunctionDeclaration for activating a skill.
 */
export declare function getActivateSkillDeclaration(skillNames: string[]): FunctionDeclaration;
