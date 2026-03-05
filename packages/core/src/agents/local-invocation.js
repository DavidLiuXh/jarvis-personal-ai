/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { LocalAgentExecutor } from './local-executor.js';
import { BaseToolInvocation, } from '../tools/tools.js';
import { AgentTerminateMode, } from './types.js';
import { randomUUID } from 'node:crypto';
const INPUT_PREVIEW_MAX_LENGTH = 50;
const DESCRIPTION_MAX_LENGTH = 200;
const MAX_RECENT_ACTIVITY = 3;
/**
 * Represents a validated, executable instance of a subagent tool.
 *
 * This class orchestrates the execution of a defined agent by:
 * 1. Initializing the {@link LocalAgentExecutor}.
 * 2. Running the agent's execution loop.
 * 3. Bridging the agent's streaming activity (e.g., thoughts) to the tool's
 * live output stream.
 * 4. Formatting the final result into a {@link ToolResult}.
 */
export class LocalSubagentInvocation extends BaseToolInvocation {
    definition;
    config;
    /**
     * @param definition The definition object that configures the agent.
     * @param config The global runtime configuration.
     * @param params The validated input parameters for the agent.
     * @param messageBus Message bus for policy enforcement.
     */
    constructor(definition, config, params, messageBus, _toolName, _toolDisplayName) {
        super(params, messageBus, _toolName ?? definition.name, _toolDisplayName ?? definition.displayName);
        this.definition = definition;
        this.config = config;
    }
    /**
     * Returns a concise, human-readable description of the invocation.
     * Used for logging and display purposes.
     */
    getDescription() {
        const inputSummary = Object.entries(this.params)
            .map(([key, value]) => `${key}: ${String(value).slice(0, INPUT_PREVIEW_MAX_LENGTH)}`)
            .join(', ');
        const description = `Running subagent '${this.definition.name}' with inputs: { ${inputSummary} }`;
        return description.slice(0, DESCRIPTION_MAX_LENGTH);
    }
    /**
     * Executes the subagent.
     *
     * @param signal An `AbortSignal` to cancel the agent's execution.
     * @param updateOutput A callback to stream intermediate output, such as the
     * agent's thoughts, to the user interface.
     * @returns A `Promise` that resolves with the final `ToolResult`.
     */
    async execute(signal, updateOutput) {
        let recentActivity = [];
        try {
            if (updateOutput) {
                // Send initial state
                const initialProgress = {
                    isSubagentProgress: true,
                    agentName: this.definition.name,
                    recentActivity: [],
                    state: 'running',
                };
                updateOutput(initialProgress);
            }
            // Create an activity callback to bridge the executor's events to the
            // tool's streaming output.
            const onActivity = (activity) => {
                if (!updateOutput)
                    return;
                let updated = false;
                switch (activity.type) {
                    case 'THOUGHT_CHUNK': {
                        const text = String(activity.data['text']);
                        const lastItem = recentActivity[recentActivity.length - 1];
                        if (lastItem &&
                            lastItem.type === 'thought' &&
                            lastItem.status === 'running') {
                            lastItem.content += text;
                        }
                        else {
                            recentActivity.push({
                                id: randomUUID(),
                                type: 'thought',
                                content: text,
                                status: 'running',
                            });
                        }
                        updated = true;
                        break;
                    }
                    case 'TOOL_CALL_START': {
                        const name = String(activity.data['name']);
                        const displayName = activity.data['displayName']
                            ? String(activity.data['displayName'])
                            : undefined;
                        const description = activity.data['description']
                            ? String(activity.data['description'])
                            : undefined;
                        const args = JSON.stringify(activity.data['args']);
                        recentActivity.push({
                            id: randomUUID(),
                            type: 'tool_call',
                            content: name,
                            displayName,
                            description,
                            args,
                            status: 'running',
                        });
                        updated = true;
                        break;
                    }
                    case 'TOOL_CALL_END': {
                        const name = String(activity.data['name']);
                        // Find the last running tool call with this name
                        for (let i = recentActivity.length - 1; i >= 0; i--) {
                            if (recentActivity[i].type === 'tool_call' &&
                                recentActivity[i].content === name &&
                                recentActivity[i].status === 'running') {
                                recentActivity[i].status = 'completed';
                                updated = true;
                                break;
                            }
                        }
                        break;
                    }
                    case 'ERROR': {
                        const error = String(activity.data['error']);
                        const isCancellation = error === 'Request cancelled.';
                        const toolName = activity.data['name']
                            ? String(activity.data['name'])
                            : undefined;
                        if (toolName && isCancellation) {
                            for (let i = recentActivity.length - 1; i >= 0; i--) {
                                if (recentActivity[i].type === 'tool_call' &&
                                    recentActivity[i].content === toolName &&
                                    recentActivity[i].status === 'running') {
                                    recentActivity[i].status = 'cancelled';
                                    updated = true;
                                    break;
                                }
                            }
                        }
                        recentActivity.push({
                            id: randomUUID(),
                            type: 'thought', // Treat errors as thoughts for now, or add an error type
                            content: isCancellation ? error : `Error: ${error}`,
                            status: isCancellation ? 'cancelled' : 'error',
                        });
                        updated = true;
                        break;
                    }
                    default:
                        break;
                }
                if (updated) {
                    // Keep only the last N items
                    if (recentActivity.length > MAX_RECENT_ACTIVITY) {
                        recentActivity = recentActivity.slice(-MAX_RECENT_ACTIVITY);
                    }
                    const progress = {
                        isSubagentProgress: true,
                        agentName: this.definition.name,
                        recentActivity: [...recentActivity], // Copy to avoid mutation issues
                        state: 'running',
                    };
                    updateOutput(progress);
                }
            };
            const executor = await LocalAgentExecutor.create(this.definition, this.config, onActivity);
            const output = await executor.run(this.params, signal);
            if (output.terminate_reason === AgentTerminateMode.ABORTED) {
                const progress = {
                    isSubagentProgress: true,
                    agentName: this.definition.name,
                    recentActivity: [...recentActivity],
                    state: 'cancelled',
                };
                if (updateOutput) {
                    updateOutput(progress);
                }
                const cancelError = new Error('Operation cancelled by user');
                cancelError.name = 'AbortError';
                throw cancelError;
            }
            const resultContent = `Subagent '${this.definition.name}' finished.
Termination Reason: ${output.terminate_reason}
Result:
${output.result}`;
            const displayContent = `
Subagent ${this.definition.name} Finished

Termination Reason:\n ${output.terminate_reason}

Result:
${output.result}
`;
            return {
                llmContent: [{ text: resultContent }],
                returnDisplay: displayContent,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isAbort = (error instanceof Error && error.name === 'AbortError') ||
                errorMessage.includes('Aborted');
            // Mark any running items as error/cancelled
            for (const item of recentActivity) {
                if (item.status === 'running') {
                    item.status = isAbort ? 'cancelled' : 'error';
                }
            }
            // Ensure the error is reflected in the recent activity for display
            // But only if it's NOT an abort, or if we want to show "Cancelled" as a thought
            if (!isAbort) {
                const lastActivity = recentActivity[recentActivity.length - 1];
                if (!lastActivity || lastActivity.status !== 'error') {
                    recentActivity.push({
                        id: randomUUID(),
                        type: 'thought',
                        content: `Error: ${errorMessage}`,
                        status: 'error',
                    });
                    // Maintain size limit
                    if (recentActivity.length > MAX_RECENT_ACTIVITY) {
                        recentActivity = recentActivity.slice(-MAX_RECENT_ACTIVITY);
                    }
                }
            }
            const progress = {
                isSubagentProgress: true,
                agentName: this.definition.name,
                recentActivity: [...recentActivity],
                state: isAbort ? 'cancelled' : 'error',
            };
            if (updateOutput) {
                updateOutput(progress);
            }
            if (isAbort) {
                throw error;
            }
            return {
                llmContent: `Subagent '${this.definition.name}' failed. Error: ${errorMessage}`,
                returnDisplay: progress,
                // We omit the 'error' property so that the UI renders our rich returnDisplay
                // instead of the raw error message. The llmContent still informs the agent of the failure.
            };
        }
    }
}
//# sourceMappingURL=local-invocation.js.map