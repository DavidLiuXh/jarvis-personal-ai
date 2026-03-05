/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, BaseToolInvocation, ToolConfirmationOutcome, type ToolCallConfirmationDetails, type ToolInvocation, type ToolResult, type PolicyUpdateOptions } from './tools.js';
import type { CallableTool, Part } from '@google/genai';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { McpContext } from './mcp-client.js';
/**
 * The separator used to qualify MCP tool names with their server prefix.
 * e.g. "server_name__tool_name"
 */
export declare const MCP_QUALIFIED_NAME_SEPARATOR = "__";
/**
 * Returns true if `name` matches the MCP qualified name format: "server__tool",
 * i.e. exactly two non-empty parts separated by the MCP_QUALIFIED_NAME_SEPARATOR.
 */
export declare function isMcpToolName(name: string): boolean;
type ToolParams = Record<string, unknown>;
export declare class DiscoveredMCPToolInvocation extends BaseToolInvocation<ToolParams, ToolResult> {
    private readonly mcpTool;
    readonly serverName: string;
    readonly serverToolName: string;
    readonly displayName: string;
    readonly trust?: boolean | undefined;
    private readonly cliConfig?;
    private readonly toolDescription?;
    private readonly toolParameterSchema?;
    private static readonly allowlist;
    constructor(mcpTool: CallableTool, serverName: string, serverToolName: string, displayName: string, messageBus: MessageBus, trust?: boolean | undefined, params?: ToolParams, cliConfig?: McpContext | undefined, toolDescription?: string | undefined, toolParameterSchema?: unknown | undefined, toolAnnotationsData?: Record<string, unknown>);
    protected getPolicyUpdateOptions(_outcome: ToolConfirmationOutcome): PolicyUpdateOptions | undefined;
    protected getConfirmationDetails(_abortSignal: AbortSignal): Promise<ToolCallConfirmationDetails | false>;
    isMCPToolError(rawResponseParts: Part[]): boolean;
    execute(signal: AbortSignal): Promise<ToolResult>;
    getDescription(): string;
}
export declare class DiscoveredMCPTool extends BaseDeclarativeTool<ToolParams, ToolResult> {
    private readonly mcpTool;
    readonly serverName: string;
    readonly serverToolName: string;
    readonly parameterSchema: unknown;
    readonly trust?: boolean | undefined;
    private readonly cliConfig?;
    readonly extensionName?: string | undefined;
    readonly extensionId?: string | undefined;
    private readonly _toolAnnotations?;
    constructor(mcpTool: CallableTool, serverName: string, serverToolName: string, description: string, parameterSchema: unknown, messageBus: MessageBus, trust?: boolean | undefined, isReadOnly?: boolean, nameOverride?: string, cliConfig?: McpContext | undefined, extensionName?: string | undefined, extensionId?: string | undefined, _toolAnnotations?: Record<string, unknown> | undefined);
    private readonly _isReadOnly?;
    get isReadOnly(): boolean;
    get toolAnnotations(): Record<string, unknown> | undefined;
    getFullyQualifiedPrefix(): string;
    getFullyQualifiedName(): string;
    asFullyQualifiedTool(): DiscoveredMCPTool;
    protected createInvocation(params: ToolParams, messageBus: MessageBus, _toolName?: string, _displayName?: string): ToolInvocation<ToolParams, ToolResult>;
}
/** Visible for testing */
export declare function generateValidName(name: string): string;
export {};
