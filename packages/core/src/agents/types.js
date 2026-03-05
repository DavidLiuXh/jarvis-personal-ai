/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {} from 'zod';
/**
 * Describes the possible termination modes for an agent.
 */
export var AgentTerminateMode;
(function (AgentTerminateMode) {
    AgentTerminateMode["ERROR"] = "ERROR";
    AgentTerminateMode["TIMEOUT"] = "TIMEOUT";
    AgentTerminateMode["GOAL"] = "GOAL";
    AgentTerminateMode["MAX_TURNS"] = "MAX_TURNS";
    AgentTerminateMode["ABORTED"] = "ABORTED";
    AgentTerminateMode["ERROR_NO_COMPLETE_TASK_CALL"] = "ERROR_NO_COMPLETE_TASK_CALL";
})(AgentTerminateMode || (AgentTerminateMode = {}));
/**
 * The default query string provided to an agent as input.
 */
export const DEFAULT_QUERY_STRING = 'Get Started!';
/**
 * The default maximum number of conversational turns for an agent.
 */
export const DEFAULT_MAX_TURNS = 15;
/**
 * The default maximum execution time for an agent in minutes.
 */
export const DEFAULT_MAX_TIME_MINUTES = 5;
export function isSubagentProgress(obj) {
    return (typeof obj === 'object' &&
        obj !== null &&
        'isSubagentProgress' in obj &&
        obj.isSubagentProgress === true);
}
//# sourceMappingURL=types.js.map