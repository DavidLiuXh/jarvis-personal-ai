/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { LocalAgentExecutor } from '../local-executor.js';
import { BaseToolInvocation, } from '../../tools/tools.js';
import { ToolErrorType } from '../../tools/tool-error.js';
import { createBrowserAgentDefinition, cleanupBrowserAgent, } from './browserAgentFactory.js';
const INPUT_PREVIEW_MAX_LENGTH = 50;
const DESCRIPTION_MAX_LENGTH = 200;
/**
 * Browser agent invocation with async tool setup.
 *
 * This invocation handles the browser agent's special requirements:
 * - MCP connection and tool wrapping at invocation time
 * - Browser cleanup after execution
 */
export class BrowserAgentInvocation extends BaseToolInvocation {
    config;
    constructor(config, params, messageBus, _toolName, _toolDisplayName) {
        // Note: BrowserAgentDefinition is a factory function, so we use hardcoded names
        super(params, messageBus, _toolName ?? 'browser_agent', _toolDisplayName ?? 'Browser Agent');
        this.config = config;
    }
    /**
     * Returns a concise, human-readable description of the invocation.
     */
    getDescription() {
        const inputSummary = Object.entries(this.params)
            .map(([key, value]) => `${key}: ${String(value).slice(0, INPUT_PREVIEW_MAX_LENGTH)}`)
            .join(', ');
        const description = `Running browser agent with inputs: { ${inputSummary} }`;
        return description.slice(0, DESCRIPTION_MAX_LENGTH);
    }
    /**
     * Executes the browser agent.
     *
     * This method:
     * 1. Creates browser manager and MCP connection
     * 2. Wraps MCP tools for the isolated registry
     * 3. Runs the agent via LocalAgentExecutor
     * 4. Cleans up browser resources
     */
    async execute(signal, updateOutput) {
        let browserManager;
        try {
            if (updateOutput) {
                updateOutput('🌐 Starting browser agent...\n');
            }
            // Create definition with MCP tools
            const printOutput = updateOutput
                ? (msg) => updateOutput(`🌐 ${msg}\n`)
                : undefined;
            const result = await createBrowserAgentDefinition(this.config, this.messageBus, printOutput);
            const { definition } = result;
            browserManager = result.browserManager;
            if (updateOutput) {
                updateOutput(`🌐 Browser connected. Tools: ${definition.toolConfig?.tools.length ?? 0}\n`);
            }
            // Create activity callback for streaming output
            const onActivity = (activity) => {
                if (!updateOutput)
                    return;
                if (activity.type === 'THOUGHT_CHUNK' &&
                    typeof activity.data['text'] === 'string') {
                    updateOutput(`🌐💭 ${activity.data['text']}`);
                }
            };
            // Create and run executor with the configured definition
            const executor = await LocalAgentExecutor.create(definition, this.config, onActivity);
            const output = await executor.run(this.params, signal);
            const resultContent = `Browser agent finished.
Termination Reason: ${output.terminate_reason}
Result:
${output.result}`;
            const displayContent = `
Browser Agent Finished

Termination Reason: ${output.terminate_reason}

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
            return {
                llmContent: `Browser agent failed. Error: ${errorMessage}`,
                returnDisplay: `Browser Agent Failed\nError: ${errorMessage}`,
                error: {
                    message: errorMessage,
                    type: ToolErrorType.EXECUTION_FAILED,
                },
            };
        }
        finally {
            // Always cleanup browser resources
            if (browserManager) {
                await cleanupBrowserAgent(browserManager);
            }
        }
    }
}
//# sourceMappingURL=browserAgentInvocation.js.map