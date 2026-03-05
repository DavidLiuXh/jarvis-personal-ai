/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Identity registry for all core tools.
 * Sits at the bottom of the dependency tree to prevent circular imports.
 */
export declare const PARAM_FILE_PATH = "file_path";
export declare const PARAM_DIR_PATH = "dir_path";
export declare const PARAM_PATTERN = "pattern";
export declare const PARAM_CASE_SENSITIVE = "case_sensitive";
export declare const PARAM_RESPECT_GIT_IGNORE = "respect_git_ignore";
export declare const PARAM_RESPECT_GEMINI_IGNORE = "respect_gemini_ignore";
export declare const PARAM_FILE_FILTERING_OPTIONS = "file_filtering_options";
export declare const PARAM_DESCRIPTION = "description";
export declare const GLOB_TOOL_NAME = "glob";
export declare const GREP_TOOL_NAME = "grep_search";
export declare const GREP_PARAM_INCLUDE_PATTERN = "include_pattern";
export declare const GREP_PARAM_EXCLUDE_PATTERN = "exclude_pattern";
export declare const GREP_PARAM_NAMES_ONLY = "names_only";
export declare const GREP_PARAM_MAX_MATCHES_PER_FILE = "max_matches_per_file";
export declare const GREP_PARAM_TOTAL_MAX_MATCHES = "total_max_matches";
export declare const GREP_PARAM_FIXED_STRINGS = "fixed_strings";
export declare const GREP_PARAM_CONTEXT = "context";
export declare const GREP_PARAM_AFTER = "after";
export declare const GREP_PARAM_BEFORE = "before";
export declare const GREP_PARAM_NO_IGNORE = "no_ignore";
export declare const LS_TOOL_NAME = "list_directory";
export declare const LS_PARAM_IGNORE = "ignore";
export declare const READ_FILE_TOOL_NAME = "read_file";
export declare const READ_FILE_PARAM_START_LINE = "start_line";
export declare const READ_FILE_PARAM_END_LINE = "end_line";
export declare const SHELL_TOOL_NAME = "run_shell_command";
export declare const SHELL_PARAM_COMMAND = "command";
export declare const SHELL_PARAM_IS_BACKGROUND = "is_background";
export declare const WRITE_FILE_TOOL_NAME = "write_file";
export declare const WRITE_FILE_PARAM_CONTENT = "content";
export declare const EDIT_TOOL_NAME = "replace";
export declare const EDIT_PARAM_INSTRUCTION = "instruction";
export declare const EDIT_PARAM_OLD_STRING = "old_string";
export declare const EDIT_PARAM_NEW_STRING = "new_string";
export declare const EDIT_PARAM_ALLOW_MULTIPLE = "allow_multiple";
export declare const WEB_SEARCH_TOOL_NAME = "google_web_search";
export declare const WEB_SEARCH_PARAM_QUERY = "query";
export declare const WRITE_TODOS_TOOL_NAME = "write_todos";
export declare const TODOS_PARAM_TODOS = "todos";
export declare const TODOS_ITEM_PARAM_DESCRIPTION = "description";
export declare const TODOS_ITEM_PARAM_STATUS = "status";
export declare const WEB_FETCH_TOOL_NAME = "web_fetch";
export declare const WEB_FETCH_PARAM_PROMPT = "prompt";
export declare const READ_MANY_FILES_TOOL_NAME = "read_many_files";
export declare const READ_MANY_PARAM_INCLUDE = "include";
export declare const READ_MANY_PARAM_EXCLUDE = "exclude";
export declare const READ_MANY_PARAM_RECURSIVE = "recursive";
export declare const READ_MANY_PARAM_USE_DEFAULT_EXCLUDES = "useDefaultExcludes";
export declare const MEMORY_TOOL_NAME = "save_memory";
export declare const MEMORY_PARAM_FACT = "fact";
export declare const GET_INTERNAL_DOCS_TOOL_NAME = "get_internal_docs";
export declare const DOCS_PARAM_PATH = "path";
export declare const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";
export declare const SKILL_PARAM_NAME = "name";
export declare const ASK_USER_TOOL_NAME = "ask_user";
export declare const ASK_USER_PARAM_QUESTIONS = "questions";
export declare const ASK_USER_QUESTION_PARAM_QUESTION = "question";
export declare const ASK_USER_QUESTION_PARAM_HEADER = "header";
export declare const ASK_USER_QUESTION_PARAM_TYPE = "type";
export declare const ASK_USER_QUESTION_PARAM_OPTIONS = "options";
export declare const ASK_USER_QUESTION_PARAM_MULTI_SELECT = "multiSelect";
export declare const ASK_USER_QUESTION_PARAM_PLACEHOLDER = "placeholder";
export declare const ASK_USER_OPTION_PARAM_LABEL = "label";
export declare const ASK_USER_OPTION_PARAM_DESCRIPTION = "description";
export declare const EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode";
export declare const EXIT_PLAN_PARAM_PLAN_PATH = "plan_path";
export declare const ENTER_PLAN_MODE_TOOL_NAME = "enter_plan_mode";
export declare const PLAN_MODE_PARAM_REASON = "reason";
