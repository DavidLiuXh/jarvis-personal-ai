/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Orchestrator for tool definitions.
 * Resolves the correct toolset based on model family and provides legacy exports.
 */
import type { ToolDefinition, CoreToolSet } from './types.js';
export { GLOB_TOOL_NAME, GREP_TOOL_NAME, LS_TOOL_NAME, READ_FILE_TOOL_NAME, SHELL_TOOL_NAME, WRITE_FILE_TOOL_NAME, EDIT_TOOL_NAME, WEB_SEARCH_TOOL_NAME, WRITE_TODOS_TOOL_NAME, WEB_FETCH_TOOL_NAME, READ_MANY_FILES_TOOL_NAME, MEMORY_TOOL_NAME, GET_INTERNAL_DOCS_TOOL_NAME, ACTIVATE_SKILL_TOOL_NAME, ASK_USER_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, ENTER_PLAN_MODE_TOOL_NAME, PARAM_FILE_PATH, PARAM_DIR_PATH, PARAM_PATTERN, PARAM_CASE_SENSITIVE, PARAM_RESPECT_GIT_IGNORE, PARAM_RESPECT_GEMINI_IGNORE, PARAM_FILE_FILTERING_OPTIONS, PARAM_DESCRIPTION, READ_FILE_PARAM_START_LINE, READ_FILE_PARAM_END_LINE, WRITE_FILE_PARAM_CONTENT, GREP_PARAM_INCLUDE_PATTERN, GREP_PARAM_EXCLUDE_PATTERN, GREP_PARAM_NAMES_ONLY, GREP_PARAM_MAX_MATCHES_PER_FILE, GREP_PARAM_TOTAL_MAX_MATCHES, GREP_PARAM_FIXED_STRINGS, GREP_PARAM_CONTEXT, GREP_PARAM_AFTER, GREP_PARAM_BEFORE, GREP_PARAM_NO_IGNORE, EDIT_PARAM_INSTRUCTION, EDIT_PARAM_OLD_STRING, EDIT_PARAM_NEW_STRING, EDIT_PARAM_ALLOW_MULTIPLE, LS_PARAM_IGNORE, SHELL_PARAM_COMMAND, SHELL_PARAM_IS_BACKGROUND, WEB_SEARCH_PARAM_QUERY, WEB_FETCH_PARAM_PROMPT, READ_MANY_PARAM_INCLUDE, READ_MANY_PARAM_EXCLUDE, READ_MANY_PARAM_RECURSIVE, READ_MANY_PARAM_USE_DEFAULT_EXCLUDES, MEMORY_PARAM_FACT, TODOS_PARAM_TODOS, TODOS_ITEM_PARAM_DESCRIPTION, TODOS_ITEM_PARAM_STATUS, DOCS_PARAM_PATH, ASK_USER_PARAM_QUESTIONS, ASK_USER_QUESTION_PARAM_QUESTION, ASK_USER_QUESTION_PARAM_HEADER, ASK_USER_QUESTION_PARAM_TYPE, ASK_USER_QUESTION_PARAM_OPTIONS, ASK_USER_QUESTION_PARAM_MULTI_SELECT, ASK_USER_QUESTION_PARAM_PLACEHOLDER, ASK_USER_OPTION_PARAM_LABEL, ASK_USER_OPTION_PARAM_DESCRIPTION, PLAN_MODE_PARAM_REASON, EXIT_PLAN_PARAM_PLAN_PATH, SKILL_PARAM_NAME, } from './base-declarations.js';
export { DEFAULT_LEGACY_SET } from './model-family-sets/default-legacy.js';
export { GEMINI_3_SET } from './model-family-sets/gemini-3.js';
/**
 * Resolves the appropriate tool set for a given model ID.
 */
export declare function getToolSet(modelId?: string): CoreToolSet;
export declare const READ_FILE_DEFINITION: ToolDefinition;
export declare const WRITE_FILE_DEFINITION: ToolDefinition;
export declare const GREP_DEFINITION: ToolDefinition;
export declare const RIP_GREP_DEFINITION: ToolDefinition;
export declare const WEB_SEARCH_DEFINITION: ToolDefinition;
export declare const EDIT_DEFINITION: ToolDefinition;
export declare const GLOB_DEFINITION: ToolDefinition;
export declare const LS_DEFINITION: ToolDefinition;
export declare const WEB_FETCH_DEFINITION: ToolDefinition;
export declare const READ_MANY_FILES_DEFINITION: ToolDefinition;
export declare const MEMORY_DEFINITION: ToolDefinition;
export declare const WRITE_TODOS_DEFINITION: ToolDefinition;
export declare const GET_INTERNAL_DOCS_DEFINITION: ToolDefinition;
export declare const ASK_USER_DEFINITION: ToolDefinition;
export declare const ENTER_PLAN_MODE_DEFINITION: ToolDefinition;
export { getShellToolDescription, getCommandDescription, } from './dynamic-declaration-helpers.js';
export declare function getShellDefinition(enableInteractiveShell: boolean, enableEfficiency: boolean): ToolDefinition;
export declare function getExitPlanModeDefinition(plansDir: string): ToolDefinition;
export declare function getActivateSkillDefinition(skillNames: string[]): ToolDefinition;
