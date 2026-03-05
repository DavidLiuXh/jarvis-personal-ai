/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { EventEmitter } from 'node:events';
/**
 * A wrapper transport that intercepts messages from Xcode's mcpbridge and fixes
 * non-compliant responses.
 *
 * Issue: Xcode 26.3's mcpbridge returns tool results in `content` but misses
 * `structuredContent` when the tool has an output schema.
 *
 * Fix: Parse the text content as JSON and populate `structuredContent`.
 */
export declare class XcodeMcpBridgeFixTransport extends EventEmitter implements Transport {
    private readonly transport;
    constructor(transport: Transport);
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    start(): Promise<void>;
    close(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
    private handleMessage;
    private isJsonResponse;
    private fixStructuredContent;
}
