/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { FinishReason } from '@google/genai';
import { getCitations } from '../utils/generateContentResponseUtilities.js';
import { ActionStatus, ConversationInteractionInteraction, InitiationMethod, } from './types.js';
import { debugLogger } from '../utils/debugLogger.js';
import { getCodeAssistServer } from './codeAssist.js';
import { EDIT_TOOL_NAMES } from '../tools/tool-names.js';
import { getErrorMessage } from '../utils/errors.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { getLanguageFromFilePath } from '../utils/language-detection.js';
import { computeModelAddedAndRemovedLines, getFileDiffFromResultDisplay, } from '../utils/fileDiffUtils.js';
import { isEditToolParams } from '../tools/edit.js';
import { isWriteFileToolParams } from '../tools/write-file.js';
export async function recordConversationOffered(server, traceId, response, streamingLatency, abortSignal) {
    try {
        if (traceId) {
            const offered = createConversationOffered(response, traceId, abortSignal, streamingLatency);
            if (offered) {
                await server.recordConversationOffered(offered);
            }
        }
    }
    catch (error) {
        debugLogger.warn(`Error recording tool call interactions: ${getErrorMessage(error)}`);
    }
}
export async function recordToolCallInteractions(config, toolCalls) {
    // Only send interaction events for responses that contain function calls.
    if (toolCalls.length === 0) {
        return;
    }
    try {
        const server = getCodeAssistServer(config);
        if (!server) {
            return;
        }
        const interaction = summarizeToolCalls(toolCalls);
        if (interaction) {
            await server.recordConversationInteraction(interaction);
        }
    }
    catch (error) {
        debugLogger.warn(`Error recording tool call interactions: ${getErrorMessage(error)}`);
    }
}
export function createConversationOffered(response, traceId, signal, streamingLatency) {
    // Only send conversation offered events for responses that contain edit
    // function calls. Non-edit function calls don't represent file modifications.
    if (!response.functionCalls ||
        !response.functionCalls.some((call) => EDIT_TOOL_NAMES.has(call.name || ''))) {
        return;
    }
    const actionStatus = getStatusFromResponse(response, signal);
    return {
        citationCount: String(getCitations(response).length),
        includedCode: includesCode(response),
        status: actionStatus,
        traceId,
        streamingLatency,
        isAgentic: true,
        initiationMethod: InitiationMethod.COMMAND,
    };
}
function summarizeToolCalls(toolCalls) {
    let acceptedToolCalls = 0;
    let actionStatus = undefined;
    let traceId = undefined;
    // Treat file edits as ACCEPT_FILE and everything else as unknown.
    let isEdit = false;
    let acceptedLines = 0;
    let removedLines = 0;
    let language = undefined;
    // Iterate the tool calls and summarize them into a single conversation
    // interaction so that the ConversationOffered and ConversationInteraction
    // events are 1:1 in telemetry.
    for (const toolCall of toolCalls) {
        traceId ||= toolCall.request.traceId;
        // If any tool call is canceled, we treat the entire interaction as canceled.
        if (toolCall.status === 'cancelled') {
            actionStatus = ActionStatus.ACTION_STATUS_CANCELLED;
            break;
        }
        // If any tool call encounters an error, we treat the entire interaction as
        // having errored.
        if (toolCall.status === 'error') {
            actionStatus = ActionStatus.ACTION_STATUS_ERROR_UNKNOWN;
            break;
        }
        // Record if the tool call was accepted.
        if (toolCall.outcome !== ToolConfirmationOutcome.Cancel) {
            acceptedToolCalls++;
            // Edits are ACCEPT_FILE, everything else is UNKNOWN.
            if (EDIT_TOOL_NAMES.has(toolCall.request.name)) {
                isEdit = true;
                if (!language &&
                    (isEditToolParams(toolCall.request.args) ||
                        isWriteFileToolParams(toolCall.request.args))) {
                    language = getLanguageFromFilePath(toolCall.request.args.file_path);
                }
                if (toolCall.status === 'success') {
                    const fileDiff = getFileDiffFromResultDisplay(toolCall.response.resultDisplay);
                    if (fileDiff?.diffStat) {
                        const lines = computeModelAddedAndRemovedLines(fileDiff.diffStat);
                        // The API expects acceptedLines to be addedLines + removedLines.
                        acceptedLines += lines.addedLines + lines.removedLines;
                        removedLines += lines.removedLines;
                    }
                }
            }
        }
    }
    // Only file interaction telemetry if 100% of the tool calls were accepted
    // and at least one of them was an edit.
    return traceId && acceptedToolCalls / toolCalls.length >= 1 && isEdit
        ? createConversationInteraction(traceId, actionStatus || ActionStatus.ACTION_STATUS_NO_ERROR, ConversationInteractionInteraction.ACCEPT_FILE, String(acceptedLines), String(removedLines), language)
        : undefined;
}
function createConversationInteraction(traceId, status, interaction, acceptedLines, removedLines, language) {
    return {
        traceId,
        status,
        interaction,
        acceptedLines,
        removedLines,
        language,
        isAgentic: true,
    };
}
function includesCode(resp) {
    if (!resp.candidates) {
        return false;
    }
    for (const candidate of resp.candidates) {
        if (!candidate.content || !candidate.content.parts) {
            continue;
        }
        for (const part of candidate.content.parts) {
            if ('text' in part && part?.text?.includes('```')) {
                return true;
            }
        }
    }
    return false;
}
function getStatusFromResponse(response, signal) {
    if (signal?.aborted) {
        return ActionStatus.ACTION_STATUS_CANCELLED;
    }
    if (hasError(response)) {
        return ActionStatus.ACTION_STATUS_ERROR_UNKNOWN;
    }
    if ((response.candidates?.length ?? 0) <= 0) {
        return ActionStatus.ACTION_STATUS_EMPTY;
    }
    return ActionStatus.ACTION_STATUS_NO_ERROR;
}
export function formatProtoJsonDuration(milliseconds) {
    return `${milliseconds / 1000}s`;
}
function hasError(response) {
    // Non-OK SDK results should be considered an error.
    if (response.sdkHttpResponse &&
        !response.sdkHttpResponse?.responseInternal?.ok) {
        return true;
    }
    for (const candidate of response.candidates || []) {
        // Treat sanitization, SPII, recitation, and forbidden terms as an error.
        if (candidate.finishReason &&
            candidate.finishReason !== FinishReason.STOP &&
            candidate.finishReason !== FinishReason.MAX_TOKENS) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=telemetry.js.map