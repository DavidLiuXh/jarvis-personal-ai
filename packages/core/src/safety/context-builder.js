/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { debugLogger } from '../utils/debugLogger.js';
/**
 * Builds context objects for safety checkers, ensuring sensitive data is filtered.
 */
export class ContextBuilder {
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * Builds the full context object with all available data.
     */
    buildFullContext() {
        const clientHistory = this.config.getGeminiClient()?.getHistory() || [];
        const history = this.convertHistoryToTurns(clientHistory);
        debugLogger.debug(`[ContextBuilder] buildFullContext called. Converted history length: ${history.length}`);
        // ContextBuilder's responsibility is to provide the *current* context.
        // If the conversation hasn't started (history is empty), we check if there's a pending question.
        // However, if the history is NOT empty, we trust it reflects the true state.
        const currentQuestion = this.config.getQuestion();
        if (currentQuestion && history.length === 0) {
            history.push({
                user: {
                    text: currentQuestion,
                },
                model: {},
            });
        }
        return {
            environment: {
                cwd: process.cwd(),
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                workspaces: this.config
                    .getWorkspaceContext()
                    .getDirectories(),
            },
            history: {
                turns: history,
            },
        };
    }
    /**
     * Builds a minimal context with only the specified keys.
     */
    buildMinimalContext(requiredKeys) {
        const fullContext = this.buildFullContext();
        const minimalContext = {};
        for (const key of requiredKeys) {
            if (key in fullContext) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
                minimalContext[key] = fullContext[key];
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return minimalContext;
    }
    // Helper to convert Google GenAI Content[] to Safety Protocol ConversationTurn[]
    convertHistoryToTurns(history) {
        const turns = [];
        let currentUserRequest;
        for (const content of history) {
            if (content.role === 'user') {
                if (currentUserRequest) {
                    // Previous user turn didn't have a matching model response (or it was filtered out)
                    // Push it as a turn with empty model response
                    turns.push({ user: currentUserRequest, model: {} });
                }
                currentUserRequest = {
                    text: content.parts?.map((p) => p.text).join('') || '',
                };
            }
            else if (content.role === 'model') {
                const modelResponse = {
                    text: content.parts
                        ?.filter((p) => p.text)
                        .map((p) => p.text)
                        .join('') || '',
                    toolCalls: content.parts
                        ?.filter((p) => 'functionCall' in p)
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                        .map((p) => p.functionCall) || [],
                };
                if (currentUserRequest) {
                    turns.push({ user: currentUserRequest, model: modelResponse });
                    currentUserRequest = undefined;
                }
                else {
                    // Model response without preceding user request.
                    // This creates a turn with empty user text.
                    turns.push({ user: { text: '' }, model: modelResponse });
                }
            }
        }
        if (currentUserRequest) {
            turns.push({ user: currentUserRequest, model: {} });
        }
        return turns;
    }
}
//# sourceMappingURL=context-builder.js.map