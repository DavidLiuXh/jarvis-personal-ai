/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {} from '@google/genai';
import {} from '../services/chatRecordingService.js';
import { partListUnionToString } from '../core/geminiRequest.js';
/**
 * Converts a PartListUnion into a normalized array of Part objects.
 * This handles converting raw strings into { text: string } parts.
 */
function ensurePartArray(content) {
    if (Array.isArray(content)) {
        return content.map((part) => typeof part === 'string' ? { text: part } : part);
    }
    if (typeof content === 'string') {
        return [{ text: content }];
    }
    return [content];
}
/**
 * Converts session/conversation data into Gemini client history formats.
 */
export function convertSessionToClientHistory(messages) {
    const clientHistory = [];
    for (const msg of messages) {
        if (msg.type === 'info' || msg.type === 'error' || msg.type === 'warning') {
            continue;
        }
        if (msg.type === 'user') {
            const contentString = partListUnionToString(msg.content);
            if (contentString.trim().startsWith('/') ||
                contentString.trim().startsWith('?')) {
                continue;
            }
            clientHistory.push({
                role: 'user',
                parts: ensurePartArray(msg.content),
            });
        }
        else if (msg.type === 'gemini') {
            const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
            if (hasToolCalls) {
                const modelParts = [];
                // TODO: Revisit if we should preserve more than just Part metadata (e.g. thoughtSignatures)
                // currently those are only required within an active loop turn which resume clears
                // by forcing a new user text prompt.
                // Preserve original parts to maintain multimodal integrity
                if (msg.content) {
                    modelParts.push(...ensurePartArray(msg.content));
                }
                for (const toolCall of msg.toolCalls) {
                    modelParts.push({
                        functionCall: {
                            name: toolCall.name,
                            args: toolCall.args,
                            ...(toolCall.id && { id: toolCall.id }),
                        },
                    });
                }
                clientHistory.push({
                    role: 'model',
                    parts: modelParts,
                });
                const functionResponseParts = [];
                for (const toolCall of msg.toolCalls) {
                    if (toolCall.result) {
                        let responseData;
                        if (typeof toolCall.result === 'string') {
                            responseData = {
                                functionResponse: {
                                    id: toolCall.id,
                                    name: toolCall.name,
                                    response: {
                                        output: toolCall.result,
                                    },
                                },
                            };
                        }
                        else if (Array.isArray(toolCall.result)) {
                            functionResponseParts.push(...ensurePartArray(toolCall.result));
                            continue;
                        }
                        else {
                            responseData = toolCall.result;
                        }
                        functionResponseParts.push(responseData);
                    }
                }
                if (functionResponseParts.length > 0) {
                    clientHistory.push({
                        role: 'user',
                        parts: functionResponseParts,
                    });
                }
            }
            else {
                if (msg.content) {
                    const parts = ensurePartArray(msg.content);
                    if (parts.length > 0) {
                        clientHistory.push({
                            role: 'model',
                            parts,
                        });
                    }
                }
            }
        }
    }
    return clientHistory;
}
//# sourceMappingURL=sessionUtils.js.map