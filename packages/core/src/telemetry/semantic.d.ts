/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * This file contains functions and types for converting Gemini API request/response
 * formats to the OpenTelemetry semantic conventions for generative AI.
 *
 * @see https://github.com/open-telemetry/semantic-conventions/blob/8b4f210f43136e57c1f6f47292eb6d38e3bf30bb/docs/gen-ai/gen-ai-events.md
 */
import { FinishReason, type Candidate, type Content, type ContentUnion } from '@google/genai';
export declare function toInputMessages(contents: Content[]): InputMessages;
export declare function toSystemInstruction(systemInstruction?: ContentUnion): SystemInstruction | undefined;
export declare function toOutputMessages(candidates?: Candidate[]): OutputMessages;
export declare function toFinishReasons(candidates?: Candidate[]): OTelFinishReason[];
export declare function toOutputType(requested_mime?: string): string | undefined;
export declare function toChatMessage(content?: Content): ChatMessage;
export declare enum OTelRole {
    SYSTEM = "system",
    USER = "user",
    ASSISTANT = "assistant",
    TOOL = "tool"
}
export type InputMessages = ChatMessage[];
export declare enum OTelOutputType {
    IMAGE = "image",
    JSON = "json",
    SPEECH = "speech",
    TEXT = "text"
}
export declare enum OTelFinishReason {
    STOP = "stop",
    LENGTH = "length",
    CONTENT_FILTER = "content_filter",
    TOOL_CALL = "tool_call",
    ERROR = "error"
}
export interface OutputMessage extends ChatMessage {
    finish_reason: FinishReason | string;
}
export type OutputMessages = OutputMessage[];
export type AnyPart = TextPart | ToolCallRequestPart | ToolCallResponsePart | ReasoningPart | GenericPart;
export type SystemInstruction = AnyPart[];
export interface ChatMessage {
    role: string | undefined;
    parts: AnyPart[];
}
declare class TextPart {
    readonly type = "text";
    content: string;
    constructor(content: string);
}
declare class ToolCallRequestPart {
    readonly type = "tool_call";
    name?: string;
    id?: string;
    arguments?: string;
    constructor(name?: string, id?: string, args?: string);
}
declare class ToolCallResponsePart {
    readonly type = "tool_call_response";
    response?: string;
    id?: string;
    constructor(response?: string, id?: string);
}
declare class ReasoningPart {
    readonly type = "reasoning";
    content: string;
    constructor(content: string);
}
declare class GenericPart {
    type: string;
    [key: string]: unknown;
    constructor(type: string, data: {
        [key: string]: unknown;
    });
}
export {};
