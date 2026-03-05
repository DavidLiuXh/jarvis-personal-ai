/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, BaseToolInvocation, Kind, ToolConfirmationOutcome, } from './tools.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import * as Diff from 'diff';
import { DEFAULT_DIFF_OPTIONS } from './diffOptions.js';
import { tildeifyPath } from '../utils/paths.js';
import { ToolErrorType } from './tool-error.js';
import { MEMORY_TOOL_NAME } from './tool-names.js';
import { MEMORY_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
export const DEFAULT_CONTEXT_FILENAME = 'GEMINI.md';
export const MEMORY_SECTION_HEADER = '## Gemini Added Memories';
// This variable will hold the currently configured filename for GEMINI.md context files.
// It defaults to DEFAULT_CONTEXT_FILENAME but can be overridden by setGeminiMdFilename.
let currentGeminiMdFilename = DEFAULT_CONTEXT_FILENAME;
export function setGeminiMdFilename(newFilename) {
    if (Array.isArray(newFilename)) {
        if (newFilename.length > 0) {
            currentGeminiMdFilename = newFilename.map((name) => name.trim());
        }
    }
    else if (newFilename && newFilename.trim() !== '') {
        currentGeminiMdFilename = newFilename.trim();
    }
}
export function getCurrentGeminiMdFilename() {
    if (Array.isArray(currentGeminiMdFilename)) {
        return currentGeminiMdFilename[0];
    }
    return currentGeminiMdFilename;
}
export function getAllGeminiMdFilenames() {
    if (Array.isArray(currentGeminiMdFilename)) {
        return currentGeminiMdFilename;
    }
    return [currentGeminiMdFilename];
}
export function getGlobalMemoryFilePath() {
    return path.join(Storage.getGlobalGeminiDir(), getCurrentGeminiMdFilename());
}
/**
 * Ensures proper newline separation before appending content.
 */
function ensureNewlineSeparation(currentContent) {
    if (currentContent.length === 0)
        return '';
    if (currentContent.endsWith('\n\n') || currentContent.endsWith('\r\n\r\n'))
        return '';
    if (currentContent.endsWith('\n') || currentContent.endsWith('\r\n'))
        return '\n';
    return '\n\n';
}
/**
 * Reads the current content of the memory file
 */
async function readMemoryFileContent() {
    try {
        return await fs.readFile(getGlobalMemoryFilePath(), 'utf-8');
    }
    catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const error = err;
        if (!(error instanceof Error) || error.code !== 'ENOENT')
            throw err;
        return '';
    }
}
/**
 * Computes the new content that would result from adding a memory entry
 */
function computeNewContent(currentContent, fact) {
    // Sanitize to prevent markdown injection by collapsing to a single line.
    let processedText = fact.replace(/[\r\n]/g, ' ').trim();
    processedText = processedText.replace(/^(-+\s*)+/, '').trim();
    const newMemoryItem = `- ${processedText}`;
    const headerIndex = currentContent.indexOf(MEMORY_SECTION_HEADER);
    if (headerIndex === -1) {
        // Header not found, append header and then the entry
        const separator = ensureNewlineSeparation(currentContent);
        return (currentContent +
            `${separator}${MEMORY_SECTION_HEADER}\n${newMemoryItem}\n`);
    }
    else {
        // Header found, find where to insert the new memory entry
        const startOfSectionContent = headerIndex + MEMORY_SECTION_HEADER.length;
        let endOfSectionIndex = currentContent.indexOf('\n## ', startOfSectionContent);
        if (endOfSectionIndex === -1) {
            endOfSectionIndex = currentContent.length; // End of file
        }
        const beforeSectionMarker = currentContent
            .substring(0, startOfSectionContent)
            .trimEnd();
        let sectionContent = currentContent
            .substring(startOfSectionContent, endOfSectionIndex)
            .trimEnd();
        const afterSectionMarker = currentContent.substring(endOfSectionIndex);
        sectionContent += `\n${newMemoryItem}`;
        return (`${beforeSectionMarker}\n${sectionContent.trimStart()}\n${afterSectionMarker}`.trimEnd() +
            '\n');
    }
}
class MemoryToolInvocation extends BaseToolInvocation {
    static allowlist = new Set();
    proposedNewContent;
    constructor(params, messageBus, toolName, displayName) {
        super(params, messageBus, toolName, displayName);
    }
    getDescription() {
        const memoryFilePath = getGlobalMemoryFilePath();
        return `in ${tildeifyPath(memoryFilePath)}`;
    }
    async getConfirmationDetails(_abortSignal) {
        const memoryFilePath = getGlobalMemoryFilePath();
        const allowlistKey = memoryFilePath;
        if (MemoryToolInvocation.allowlist.has(allowlistKey)) {
            return false;
        }
        const currentContent = await readMemoryFileContent();
        const { fact, modified_by_user, modified_content } = this.params;
        // If an attacker injects modified_content, use it for the diff
        // to expose the attack to the user. Otherwise, compute from 'fact'.
        const contentForDiff = modified_by_user && modified_content !== undefined
            ? modified_content
            : computeNewContent(currentContent, fact);
        this.proposedNewContent = contentForDiff;
        const fileName = path.basename(memoryFilePath);
        const fileDiff = Diff.createPatch(fileName, currentContent, this.proposedNewContent, 'Current', 'Proposed', DEFAULT_DIFF_OPTIONS);
        const confirmationDetails = {
            type: 'edit',
            title: `Confirm Memory Save: ${tildeifyPath(memoryFilePath)}`,
            fileName: memoryFilePath,
            filePath: memoryFilePath,
            fileDiff,
            originalContent: currentContent,
            newContent: this.proposedNewContent,
            onConfirm: async (outcome) => {
                if (outcome === ToolConfirmationOutcome.ProceedAlways) {
                    MemoryToolInvocation.allowlist.add(allowlistKey);
                }
                // Policy updates are now handled centrally by the scheduler
            },
        };
        return confirmationDetails;
    }
    async execute(_signal) {
        const { fact, modified_by_user, modified_content } = this.params;
        try {
            let contentToWrite;
            let successMessage;
            // Sanitize the fact for use in the success message, matching the sanitization
            // that happened inside computeNewContent.
            const sanitizedFact = fact.replace(/[\r\n]/g, ' ').trim();
            if (modified_by_user && modified_content !== undefined) {
                // User modified the content, so that is the source of truth.
                contentToWrite = modified_content;
                successMessage = `Okay, I've updated the memory file with your modifications.`;
            }
            else {
                // User approved the proposed change without modification.
                // The source of truth is the exact content proposed during confirmation.
                if (this.proposedNewContent === undefined) {
                    // This case can be hit in flows without a confirmation step (e.g., --auto-confirm).
                    // As a fallback, we recompute the content now. This is safe because
                    // computeNewContent sanitizes the input.
                    const currentContent = await readMemoryFileContent();
                    this.proposedNewContent = computeNewContent(currentContent, fact);
                }
                contentToWrite = this.proposedNewContent;
                successMessage = `Okay, I've remembered that: "${sanitizedFact}"`;
            }
            await fs.mkdir(path.dirname(getGlobalMemoryFilePath()), {
                recursive: true,
            });
            await fs.writeFile(getGlobalMemoryFilePath(), contentToWrite, 'utf-8');
            return {
                llmContent: JSON.stringify({
                    success: true,
                    message: successMessage,
                }),
                returnDisplay: successMessage,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                llmContent: JSON.stringify({
                    success: false,
                    error: `Failed to save memory. Detail: ${errorMessage}`,
                }),
                returnDisplay: `Error saving memory: ${errorMessage}`,
                error: {
                    message: errorMessage,
                    type: ToolErrorType.MEMORY_TOOL_EXECUTION_ERROR,
                },
            };
        }
    }
}
export class MemoryTool extends BaseDeclarativeTool {
    static Name = MEMORY_TOOL_NAME;
    constructor(messageBus) {
        super(MemoryTool.Name, 'SaveMemory', MEMORY_DEFINITION.base.description, Kind.Think, MEMORY_DEFINITION.base.parametersJsonSchema, messageBus, true, false);
    }
    validateToolParamValues(params) {
        if (params.fact.trim() === '') {
            return 'Parameter "fact" must be a non-empty string.';
        }
        return null;
    }
    createInvocation(params, messageBus, toolName, displayName) {
        return new MemoryToolInvocation(params, messageBus, toolName ?? this.name, displayName ?? this.displayName);
    }
    getSchema(modelId) {
        return resolveToolDeclaration(MEMORY_DEFINITION, modelId);
    }
    getModifyContext(_abortSignal) {
        return {
            getFilePath: (_params) => getGlobalMemoryFilePath(),
            getCurrentContent: async (_params) => readMemoryFileContent(),
            getProposedContent: async (params) => {
                const currentContent = await readMemoryFileContent();
                const { fact, modified_by_user, modified_content } = params;
                // Ensure the editor is populated with the same content
                // that the confirmation diff would show.
                return modified_by_user && modified_content !== undefined
                    ? modified_content
                    : computeNewContent(currentContent, fact);
            },
            createUpdatedParams: (_oldContent, modifiedProposedContent, originalParams) => ({
                ...originalParams,
                modified_by_user: true,
                modified_content: modifiedProposedContent,
            }),
        };
    }
}
//# sourceMappingURL=memoryTool.js.map