/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { Kind, BaseDeclarativeTool, BaseToolInvocation, } from './tools.js';
import { ApprovalMode } from '../policy/types.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { parse } from 'shell-quote';
import { ToolErrorType } from './tool-error.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import { debugLogger } from '../utils/debugLogger.js';
import { coreEvents } from '../utils/events.js';
import { DISCOVERED_TOOL_PREFIX, TOOL_LEGACY_ALIASES, getToolAliases, WRITE_FILE_TOOL_NAME, EDIT_TOOL_NAME, } from './tool-names.js';
class DiscoveredToolInvocation extends BaseToolInvocation {
    config;
    originalToolName;
    constructor(config, originalToolName, prefixedToolName, params, messageBus) {
        super(params, messageBus, prefixedToolName);
        this.config = config;
        this.originalToolName = originalToolName;
    }
    getDescription() {
        return safeJsonStringify(this.params);
    }
    async execute(_signal, _updateOutput) {
        const callCommand = this.config.getToolCallCommand();
        const child = spawn(callCommand, [this.originalToolName]);
        child.stdin.write(JSON.stringify(this.params));
        child.stdin.end();
        let stdout = '';
        let stderr = '';
        let error = null;
        let code = null;
        let signal = null;
        await new Promise((resolve) => {
            const onStdout = (data) => {
                stdout += data?.toString();
            };
            const onStderr = (data) => {
                stderr += data?.toString();
            };
            const onError = (err) => {
                error = err;
            };
            const onClose = (_code, _signal) => {
                code = _code;
                signal = _signal;
                cleanup();
                resolve();
            };
            const cleanup = () => {
                child.stdout.removeListener('data', onStdout);
                child.stderr.removeListener('data', onStderr);
                child.removeListener('error', onError);
                child.removeListener('close', onClose);
                if (child.connected) {
                    child.disconnect();
                }
            };
            child.stdout.on('data', onStdout);
            child.stderr.on('data', onStderr);
            child.on('error', onError);
            child.on('close', onClose);
        });
        // if there is any error, non-zero exit code, signal, or stderr, return error details instead of stdout
        if (error || code !== 0 || signal || stderr) {
            const llmContent = [
                `Stdout: ${stdout || '(empty)'}`,
                `Stderr: ${stderr || '(empty)'}`,
                `Error: ${error ?? '(none)'}`,
                `Exit Code: ${code ?? '(none)'}`,
                `Signal: ${signal ?? '(none)'}`,
            ].join('\n');
            return {
                llmContent,
                returnDisplay: llmContent,
                error: {
                    message: llmContent,
                    type: ToolErrorType.DISCOVERED_TOOL_EXECUTION_ERROR,
                },
            };
        }
        return {
            llmContent: stdout,
            returnDisplay: stdout,
        };
    }
}
export class DiscoveredTool extends BaseDeclarativeTool {
    config;
    parameterSchema;
    originalName;
    constructor(config, originalName, prefixedName, description, parameterSchema, messageBus) {
        const discoveryCmd = config.getToolDiscoveryCommand();
        const callCommand = config.getToolCallCommand();
        const fullDescription = description +
            `

This tool was discovered from the project by executing the command \`${discoveryCmd}\` on project root.
When called, this tool will execute the command \`${callCommand} ${originalName}\` on project root.
Tool discovery and call commands can be configured in project or user settings.

When called, the tool call command is executed as a subprocess.
On success, tool output is returned as a json string.
Otherwise, the following information is returned:

Stdout: Output on stdout stream. Can be \`(empty)\` or partial.
Stderr: Output on stderr stream. Can be \`(empty)\` or partial.
Error: Error or \`(none)\` if no error was reported for the subprocess.
Exit Code: Exit code or \`(none)\` if terminated by signal.
Signal: Signal number or \`(none)\` if no signal was received.
`;
        super(prefixedName, prefixedName, fullDescription, Kind.Other, parameterSchema, messageBus, false, // isOutputMarkdown
        false);
        this.config = config;
        this.parameterSchema = parameterSchema;
        this.originalName = originalName;
    }
    createInvocation(params, messageBus, _toolName, _displayName) {
        return new DiscoveredToolInvocation(this.config, this.originalName, _toolName ?? this.name, params, messageBus);
    }
}
export class ToolRegistry {
    // The tools keyed by tool name as seen by the LLM.
    // This includes tools which are currently not active, use `getActiveTools`
    // and `isActive` to get only the active tools.
    allKnownTools = new Map();
    config;
    messageBus;
    constructor(config, messageBus) {
        this.config = config;
        this.messageBus = messageBus;
    }
    getMessageBus() {
        return this.messageBus;
    }
    /**
     * Registers a tool definition.
     *
     * Note that excluded tools are still registered to allow for enabling them
     * later in the session.
     *
     * @param tool - The tool object containing schema and execution logic.
     */
    registerTool(tool) {
        if (this.allKnownTools.has(tool.name)) {
            if (tool instanceof DiscoveredMCPTool) {
                tool = tool.asFullyQualifiedTool();
            }
            else {
                // Decide on behavior: throw error, log warning, or allow overwrite
                debugLogger.warn(`Tool with name "${tool.name}" is already registered. Overwriting.`);
            }
        }
        this.allKnownTools.set(tool.name, tool);
    }
    /**
     * Unregisters a tool definition by name.
     *
     * @param name - The name of the tool to unregister.
     */
    unregisterTool(name) {
        this.allKnownTools.delete(name);
    }
    /**
     * Sorts tools as:
     * 1. Built in tools.
     * 2. Discovered tools.
     * 3. MCP tools ordered by server name.
     *
     * This is a stable sort in that tries preserve existing order.
     */
    sortTools() {
        const getPriority = (tool) => {
            if (tool instanceof DiscoveredMCPTool)
                return 2;
            if (tool instanceof DiscoveredTool)
                return 1;
            return 0; // Built-in
        };
        this.allKnownTools = new Map(Array.from(this.allKnownTools.entries()).sort((a, b) => {
            const toolA = a[1];
            const toolB = b[1];
            const priorityA = getPriority(toolA);
            const priorityB = getPriority(toolB);
            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }
            if (priorityA === 2) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const serverA = toolA.serverName;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const serverB = toolB.serverName;
                return serverA.localeCompare(serverB);
            }
            return 0;
        }));
    }
    removeDiscoveredTools() {
        for (const tool of this.allKnownTools.values()) {
            if (tool instanceof DiscoveredTool || tool instanceof DiscoveredMCPTool) {
                this.allKnownTools.delete(tool.name);
            }
        }
    }
    /**
     * Removes all tools from a specific MCP server.
     * @param serverName The name of the server to remove tools from.
     */
    removeMcpToolsByServer(serverName) {
        for (const [name, tool] of this.allKnownTools.entries()) {
            if (tool instanceof DiscoveredMCPTool && tool.serverName === serverName) {
                this.allKnownTools.delete(name);
            }
        }
    }
    /**
     * Discovers tools from project (if available and configured).
     * Can be called multiple times to update discovered tools.
     * This will discover tools from the command line and from MCP servers.
     */
    async discoverAllTools() {
        // remove any previously discovered tools
        this.removeDiscoveredTools();
        await this.discoverAndRegisterToolsFromCommand();
    }
    async discoverAndRegisterToolsFromCommand() {
        const discoveryCmd = this.config.getToolDiscoveryCommand();
        if (!discoveryCmd) {
            return;
        }
        try {
            const cmdParts = parse(discoveryCmd);
            if (cmdParts.length === 0) {
                throw new Error('Tool discovery command is empty or contains only whitespace.');
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const proc = spawn(cmdParts[0], cmdParts.slice(1));
            let stdout = '';
            const stdoutDecoder = new StringDecoder('utf8');
            let stderr = '';
            const stderrDecoder = new StringDecoder('utf8');
            let sizeLimitExceeded = false;
            const MAX_STDOUT_SIZE = 10 * 1024 * 1024; // 10MB limit
            const MAX_STDERR_SIZE = 10 * 1024 * 1024; // 10MB limit
            let stdoutByteLength = 0;
            let stderrByteLength = 0;
            proc.stdout.on('data', (data) => {
                if (sizeLimitExceeded)
                    return;
                if (stdoutByteLength + data.length > MAX_STDOUT_SIZE) {
                    sizeLimitExceeded = true;
                    proc.kill();
                    return;
                }
                stdoutByteLength += data.length;
                stdout += stdoutDecoder.write(data);
            });
            proc.stderr.on('data', (data) => {
                if (sizeLimitExceeded)
                    return;
                if (stderrByteLength + data.length > MAX_STDERR_SIZE) {
                    sizeLimitExceeded = true;
                    proc.kill();
                    return;
                }
                stderrByteLength += data.length;
                stderr += stderrDecoder.write(data);
            });
            await new Promise((resolve, reject) => {
                proc.on('error', reject);
                proc.on('close', (code) => {
                    stdout += stdoutDecoder.end();
                    stderr += stderrDecoder.end();
                    if (sizeLimitExceeded) {
                        return reject(new Error(`Tool discovery command output exceeded size limit of ${MAX_STDOUT_SIZE} bytes.`));
                    }
                    if (code !== 0) {
                        coreEvents.emitFeedback('error', `Tool discovery command failed with code ${code}.`, stderr);
                        return reject(new Error(`Tool discovery command failed with exit code ${code}`));
                    }
                    resolve();
                });
            });
            // execute discovery command and extract function declarations (w/ or w/o "tool" wrappers)
            const functions = [];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const discoveredItems = JSON.parse(stdout.trim());
            if (!discoveredItems || !Array.isArray(discoveredItems)) {
                throw new Error('Tool discovery command did not return a JSON array of tools.');
            }
            for (const tool of discoveredItems) {
                if (tool && typeof tool === 'object') {
                    if (Array.isArray(tool['function_declarations'])) {
                        functions.push(...tool['function_declarations']);
                    }
                    else if (Array.isArray(tool['functionDeclarations'])) {
                        functions.push(...tool['functionDeclarations']);
                    }
                    else if (tool['name']) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                        functions.push(tool);
                    }
                }
            }
            // register each function as a tool
            for (const func of functions) {
                if (!func.name) {
                    debugLogger.warn('Discovered a tool with no name. Skipping.');
                    continue;
                }
                const parameters = func.parametersJsonSchema &&
                    typeof func.parametersJsonSchema === 'object' &&
                    !Array.isArray(func.parametersJsonSchema)
                    ? func.parametersJsonSchema
                    : {};
                this.registerTool(new DiscoveredTool(this.config, func.name, DISCOVERED_TOOL_PREFIX + func.name, func.description ?? '', 
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                parameters, this.messageBus));
            }
        }
        catch (e) {
            debugLogger.error(`Tool discovery command "${discoveryCmd}" failed:`, e);
            throw e;
        }
    }
    buildToolMetadata() {
        const toolMetadata = new Map();
        for (const [name, tool] of this.allKnownTools) {
            if (tool.toolAnnotations) {
                const metadata = { ...tool.toolAnnotations };
                // Include server name so the policy engine can resolve composite
                // wildcard patterns (e.g. "*__*") against unqualified tool names.
                if (tool instanceof DiscoveredMCPTool) {
                    metadata['_serverName'] = tool.serverName;
                }
                toolMetadata.set(name, metadata);
            }
        }
        return toolMetadata;
    }
    /**
     * @returns All the tools that are not excluded.
     */
    getActiveTools() {
        const toolMetadata = this.buildToolMetadata();
        const allKnownNames = new Set(this.allKnownTools.keys());
        const excludedTools = this.expandExcludeToolsWithAliases(this.config.getExcludeTools(toolMetadata, allKnownNames)) ?? new Set([]);
        const activeTools = [];
        for (const tool of this.allKnownTools.values()) {
            if (this.isActiveTool(tool, excludedTools)) {
                activeTools.push(tool);
            }
        }
        return activeTools;
    }
    /**
     * Expands an excludeTools set to include all legacy aliases.
     * For example, if 'search_file_content' is excluded and it's an alias for
     * 'grep_search', both names will be in the returned set.
     */
    expandExcludeToolsWithAliases(excludeTools) {
        if (!excludeTools || excludeTools.size === 0) {
            return excludeTools;
        }
        const expanded = new Set();
        for (const name of excludeTools) {
            for (const alias of getToolAliases(name)) {
                expanded.add(alias);
            }
        }
        return expanded;
    }
    /**
     * @param tool
     * @param excludeTools (optional, helps performance for repeated calls)
     * @returns Whether or not the `tool` is not excluded.
     */
    isActiveTool(tool, excludeTools) {
        excludeTools ??=
            this.expandExcludeToolsWithAliases(this.config.getExcludeTools(this.buildToolMetadata(), new Set(this.allKnownTools.keys()))) ?? new Set([]);
        const normalizedClassName = tool.constructor.name.replace(/^_+/, '');
        const possibleNames = [tool.name, normalizedClassName];
        if (tool instanceof DiscoveredMCPTool) {
            // Check both the unqualified and qualified name for MCP tools.
            if (tool.name.startsWith(tool.getFullyQualifiedPrefix())) {
                possibleNames.push(tool.name.substring(tool.getFullyQualifiedPrefix().length));
            }
            else {
                possibleNames.push(`${tool.getFullyQualifiedPrefix()}${tool.name}`);
            }
        }
        return !possibleNames.some((name) => excludeTools.has(name));
    }
    /**
     * Retrieves the list of tool schemas (FunctionDeclaration array).
     * Extracts the declarations from the ToolListUnion structure.
     * Includes discovered (vs registered) tools if configured.
     * @param modelId Optional model identifier to get model-specific schemas.
     * @returns An array of FunctionDeclarations.
     */
    getFunctionDeclarations(modelId) {
        const isPlanMode = this.config.getApprovalMode() === ApprovalMode.PLAN;
        const plansDir = this.config.storage.getPlansDir();
        const declarations = [];
        const seenNames = new Set();
        this.getActiveTools().forEach((tool) => {
            const toolName = tool instanceof DiscoveredMCPTool
                ? tool.getFullyQualifiedName()
                : tool.name;
            if (seenNames.has(toolName)) {
                return;
            }
            seenNames.add(toolName);
            let schema = tool.getSchema(modelId);
            // Ensure the schema name matches the qualified name for MCP tools
            if (tool instanceof DiscoveredMCPTool) {
                schema = {
                    ...schema,
                    name: toolName,
                };
            }
            if (isPlanMode &&
                (toolName === WRITE_FILE_TOOL_NAME || toolName === EDIT_TOOL_NAME)) {
                schema = {
                    ...schema,
                    description: `ONLY FOR PLANS: ${schema.description}. You are currently in Plan Mode and may ONLY use this tool to write or update plans (.md files) in the plans directory: ${plansDir}/. You cannot use this tool to modify source code directly.`,
                };
            }
            declarations.push(schema);
        });
        return declarations;
    }
    /**
     * Retrieves a filtered list of tool schemas based on a list of tool names.
     * @param toolNames - An array of tool names to include.
     * @param modelId Optional model identifier to get model-specific schemas.
     * @returns An array of FunctionDeclarations for the specified tools.
     */
    getFunctionDeclarationsFiltered(toolNames, modelId) {
        const declarations = [];
        for (const name of toolNames) {
            const tool = this.getTool(name);
            if (tool) {
                declarations.push(tool.getSchema(modelId));
            }
        }
        return declarations;
    }
    /**
     * Returns an array of names for all active tools.
     * For MCP tools, this returns their fully qualified names.
     * The list is deduplicated.
     */
    getAllToolNames() {
        const names = new Set();
        for (const tool of this.getActiveTools()) {
            if (tool instanceof DiscoveredMCPTool) {
                names.add(tool.getFullyQualifiedName());
            }
            else {
                names.add(tool.name);
            }
        }
        return Array.from(names);
    }
    /**
     * Returns an array of all registered and discovered tool instances.
     */
    getAllTools() {
        const seen = new Set();
        const tools = [];
        for (const tool of this.getActiveTools().sort((a, b) => a.displayName.localeCompare(b.displayName))) {
            const name = tool instanceof DiscoveredMCPTool
                ? tool.getFullyQualifiedName()
                : tool.name;
            if (!seen.has(name)) {
                seen.add(name);
                tools.push(tool);
            }
        }
        return tools;
    }
    /**
     * Returns an array of tools registered from a specific MCP server.
     */
    getToolsByServer(serverName) {
        const serverTools = [];
        for (const tool of this.getActiveTools()) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            if (tool?.serverName === serverName) {
                serverTools.push(tool);
            }
        }
        return serverTools.sort((a, b) => a.name.localeCompare(b.name));
    }
    /**
     * Get the definition of a specific tool.
     */
    getTool(name) {
        let tool = this.allKnownTools.get(name);
        // If not found, check legacy aliases
        if (!tool && TOOL_LEGACY_ALIASES[name]) {
            const currentName = TOOL_LEGACY_ALIASES[name];
            tool = this.allKnownTools.get(currentName);
            if (tool) {
                debugLogger.debug(`Resolved legacy tool name "${name}" to current name "${currentName}"`);
            }
        }
        if (!tool && name.includes('__')) {
            for (const t of this.allKnownTools.values()) {
                if (t instanceof DiscoveredMCPTool) {
                    if (t.getFullyQualifiedName() === name) {
                        tool = t;
                        break;
                    }
                }
            }
        }
        if (tool && this.isActiveTool(tool)) {
            return tool;
        }
        return;
    }
}
//# sourceMappingURL=tool-registry.js.map