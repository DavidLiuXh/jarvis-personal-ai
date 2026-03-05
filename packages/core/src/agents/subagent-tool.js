/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { BaseDeclarativeTool, Kind, BaseToolInvocation, isTool, } from '../tools/tools.js';
import { SubagentToolWrapper } from './subagent-tool-wrapper.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { formatUserHintsForModel } from '../utils/fastAckHelper.js';
import { runInDevTraceSpan } from '../telemetry/trace.js';
import { GeminiCliOperation, GEN_AI_AGENT_DESCRIPTION, GEN_AI_AGENT_NAME, } from '../telemetry/constants.js';
export class SubagentTool extends BaseDeclarativeTool {
    definition;
    config;
    constructor(definition, config, messageBus) {
        const inputSchema = definition.inputConfig.inputSchema;
        // Validate schema on construction
        const schemaError = SchemaValidator.validateSchema(inputSchema);
        if (schemaError) {
            throw new Error(`Invalid schema for agent ${definition.name}: ${schemaError}`);
        }
        super(definition.name, definition.displayName ?? definition.name, definition.description, Kind.Agent, inputSchema, messageBus, 
        /* isOutputMarkdown */ true, 
        /* canUpdateOutput */ true);
        this.definition = definition;
        this.config = config;
    }
    _memoizedIsReadOnly;
    get isReadOnly() {
        if (this._memoizedIsReadOnly !== undefined) {
            return this._memoizedIsReadOnly;
        }
        // No try-catch here. If getToolRegistry() throws, we let it throw.
        // This is an invariant: you can't check read-only status if the system isn't initialized.
        this._memoizedIsReadOnly = SubagentTool.checkIsReadOnly(this.definition, this.config);
        return this._memoizedIsReadOnly;
    }
    static checkIsReadOnly(definition, config) {
        if (definition.kind === 'remote') {
            return false;
        }
        const tools = definition.toolConfig?.tools ?? [];
        const registry = config.getToolRegistry();
        if (!registry) {
            return false;
        }
        for (const tool of tools) {
            if (typeof tool === 'string') {
                const resolvedTool = registry.getTool(tool);
                if (!resolvedTool || !resolvedTool.isReadOnly) {
                    return false;
                }
            }
            else if (isTool(tool)) {
                if (!tool.isReadOnly) {
                    return false;
                }
            }
            else {
                // FunctionDeclaration - we don't know, so assume NOT read-only
                return false;
            }
        }
        return true;
    }
    createInvocation(params, messageBus, _toolName, _toolDisplayName) {
        return new SubAgentInvocation(params, this.definition, this.config, messageBus, _toolName, _toolDisplayName);
    }
}
class SubAgentInvocation extends BaseToolInvocation {
    definition;
    config;
    startIndex;
    constructor(params, definition, config, messageBus, _toolName, _toolDisplayName) {
        super(params, messageBus, _toolName ?? definition.name, _toolDisplayName ?? definition.displayName ?? definition.name);
        this.definition = definition;
        this.config = config;
        this.startIndex = config.userHintService.getLatestHintIndex();
    }
    getDescription() {
        return `Delegating to agent '${this.definition.name}'`;
    }
    async shouldConfirmExecute(abortSignal) {
        const invocation = this.buildSubInvocation(this.definition, this.withUserHints(this.params));
        return invocation.shouldConfirmExecute(abortSignal);
    }
    async execute(signal, updateOutput) {
        const validationError = SchemaValidator.validate(this.definition.inputConfig.inputSchema, this.params);
        if (validationError) {
            throw new Error(`Invalid arguments for agent '${this.definition.name}': ${validationError}. Input schema: ${JSON.stringify(this.definition.inputConfig.inputSchema)}.`);
        }
        const invocation = this.buildSubInvocation(this.definition, this.withUserHints(this.params));
        return runInDevTraceSpan({
            operation: GeminiCliOperation.AgentCall,
            attributes: {
                [GEN_AI_AGENT_NAME]: this.definition.name,
                [GEN_AI_AGENT_DESCRIPTION]: this.definition.description,
            },
        }, async ({ metadata }) => {
            metadata.input = this.params;
            const result = await invocation.execute(signal, updateOutput);
            metadata.output = result;
            return result;
        });
    }
    withUserHints(agentArgs) {
        if (this.definition.kind !== 'remote') {
            return agentArgs;
        }
        const userHints = this.config.userHintService.getUserHintsAfter(this.startIndex);
        const formattedHints = formatUserHintsForModel(userHints);
        if (!formattedHints) {
            return agentArgs;
        }
        const query = agentArgs['query'];
        if (typeof query !== 'string' || query.trim().length === 0) {
            return agentArgs;
        }
        return {
            ...agentArgs,
            query: `${formattedHints}\n\n${query}`,
        };
    }
    buildSubInvocation(definition, agentArgs) {
        const wrapper = new SubagentToolWrapper(definition, this.config, this.messageBus);
        return wrapper.build(agentArgs);
    }
}
//# sourceMappingURL=subagent-tool.js.map