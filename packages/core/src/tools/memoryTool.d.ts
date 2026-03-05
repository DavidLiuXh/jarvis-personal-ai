/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, BaseToolInvocation, type ToolEditConfirmationDetails, type ToolResult } from './tools.js';
import type { ModifiableDeclarativeTool, ModifyContext } from './modifiable-tool.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
export declare const DEFAULT_CONTEXT_FILENAME = "GEMINI.md";
export declare const MEMORY_SECTION_HEADER = "## Gemini Added Memories";
export declare function setGeminiMdFilename(newFilename: string | string[]): void;
export declare function getCurrentGeminiMdFilename(): string;
export declare function getAllGeminiMdFilenames(): string[];
interface SaveMemoryParams {
    fact: string;
    modified_by_user?: boolean;
    modified_content?: string;
}
export declare function getGlobalMemoryFilePath(): string;
declare class MemoryToolInvocation extends BaseToolInvocation<SaveMemoryParams, ToolResult> {
    private static readonly allowlist;
    private proposedNewContent;
    constructor(params: SaveMemoryParams, messageBus: MessageBus, toolName?: string, displayName?: string);
    getDescription(): string;
    protected getConfirmationDetails(_abortSignal: AbortSignal): Promise<ToolEditConfirmationDetails | false>;
    execute(_signal: AbortSignal): Promise<ToolResult>;
}
export declare class MemoryTool extends BaseDeclarativeTool<SaveMemoryParams, ToolResult> implements ModifiableDeclarativeTool<SaveMemoryParams> {
    static readonly Name = "save_memory";
    constructor(messageBus: MessageBus);
    protected validateToolParamValues(params: SaveMemoryParams): string | null;
    protected createInvocation(params: SaveMemoryParams, messageBus: MessageBus, toolName?: string, displayName?: string): MemoryToolInvocation;
    getSchema(modelId?: string): import("@google/genai").FunctionDeclaration;
    getModifyContext(_abortSignal: AbortSignal): ModifyContext<SaveMemoryParams>;
}
export {};
