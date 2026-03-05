/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { ToolErrorType } from './tool-error.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { randomUUID } from 'node:crypto';
import { MessageBusType, } from '../confirmation-bus/types.js';
import {} from '../policy/types.js';
/**
 * A convenience base class for ToolInvocation.
 */
export class BaseToolInvocation {
    params;
    messageBus;
    _toolName;
    _toolDisplayName;
    _serverName;
    _toolAnnotations;
    constructor(params, messageBus, _toolName, _toolDisplayName, _serverName, _toolAnnotations) {
        this.params = params;
        this.messageBus = messageBus;
        this._toolName = _toolName;
        this._toolDisplayName = _toolDisplayName;
        this._serverName = _serverName;
        this._toolAnnotations = _toolAnnotations;
    }
    toolLocations() {
        return [];
    }
    async shouldConfirmExecute(abortSignal) {
        const decision = await this.getMessageBusDecision(abortSignal);
        if (decision === 'ALLOW') {
            return false;
        }
        if (decision === 'DENY') {
            throw new Error(`Tool execution for "${this._toolDisplayName || this._toolName}" denied by policy.`);
        }
        if (decision === 'ASK_USER') {
            return this.getConfirmationDetails(abortSignal);
        }
        // Default to confirmation details if decision is unknown (should not happen with exhaustive policy)
        return this.getConfirmationDetails(abortSignal);
    }
    /**
     * Returns tool-specific options for policy updates.
     * Subclasses can override this to provide additional options like
     * commandPrefix (for shell) or mcpName (for MCP tools).
     */
    getPolicyUpdateOptions(_outcome) {
        return undefined;
    }
    /**
     * Helper method to publish a policy update when user selects
     * ProceedAlways or ProceedAlwaysAndSave.
     */
    async publishPolicyUpdate(outcome) {
        if (outcome === ToolConfirmationOutcome.ProceedAlways ||
            outcome === ToolConfirmationOutcome.ProceedAlwaysAndSave) {
            if (this._toolName) {
                const options = this.getPolicyUpdateOptions(outcome);
                void this.messageBus.publish({
                    type: MessageBusType.UPDATE_POLICY,
                    toolName: this._toolName,
                    persist: outcome === ToolConfirmationOutcome.ProceedAlwaysAndSave,
                    ...options,
                });
            }
        }
    }
    /**
     * Subclasses should override this method to provide custom confirmation UI
     * when the policy engine's decision is 'ASK_USER'.
     * The base implementation provides a generic confirmation prompt.
     */
    async getConfirmationDetails(_abortSignal) {
        if (!this.messageBus) {
            return false;
        }
        const confirmationDetails = {
            type: 'info',
            title: `Confirm: ${this._toolDisplayName || this._toolName}`,
            prompt: this.getDescription(),
            onConfirm: async (_outcome) => {
                // Policy updates are now handled centrally by the scheduler
            },
        };
        return confirmationDetails;
    }
    getMessageBusDecision(abortSignal) {
        if (!this.messageBus || !this._toolName) {
            // If there's no message bus, we can't make a decision, so we allow.
            // The legacy confirmation flow will still apply if the tool needs it.
            return Promise.resolve('ALLOW');
        }
        const correlationId = randomUUID();
        const request = {
            type: MessageBusType.TOOL_CONFIRMATION_REQUEST,
            correlationId,
            toolCall: {
                name: this._toolName,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                args: this.params,
            },
            serverName: this._serverName,
            toolAnnotations: this._toolAnnotations,
        };
        return new Promise((resolve) => {
            if (!this.messageBus) {
                resolve('ALLOW');
                return;
            }
            let timeoutId = null;
            let unsubscribe = null;
            const cleanup = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                if (unsubscribe) {
                    unsubscribe();
                    unsubscribe = null;
                }
                abortSignal.removeEventListener('abort', abortHandler);
            };
            const abortHandler = () => {
                cleanup();
                resolve('DENY');
            };
            if (abortSignal.aborted) {
                resolve('DENY');
                return;
            }
            const responseHandler = (response) => {
                if (response.correlationId === correlationId) {
                    cleanup();
                    if (response.requiresUserConfirmation) {
                        resolve('ASK_USER');
                    }
                    else if (response.confirmed) {
                        resolve('ALLOW');
                    }
                    else {
                        resolve('DENY');
                    }
                }
            };
            abortSignal.addEventListener('abort', abortHandler, { once: true });
            timeoutId = setTimeout(() => {
                cleanup();
                resolve('ASK_USER'); // Default to ASK_USER on timeout
            }, 30000);
            this.messageBus.subscribe(MessageBusType.TOOL_CONFIRMATION_RESPONSE, responseHandler);
            unsubscribe = () => {
                this.messageBus?.unsubscribe(MessageBusType.TOOL_CONFIRMATION_RESPONSE, responseHandler);
            };
            try {
                void this.messageBus.publish(request);
            }
            catch (_error) {
                cleanup();
                resolve('ALLOW');
            }
        });
    }
}
/**
 * New base class for tools that separates validation from execution.
 * New tools should extend this class.
 */
export class DeclarativeTool {
    name;
    displayName;
    description;
    kind;
    parameterSchema;
    messageBus;
    isOutputMarkdown;
    canUpdateOutput;
    extensionName;
    extensionId;
    constructor(name, displayName, description, kind, parameterSchema, messageBus, isOutputMarkdown = true, canUpdateOutput = false, extensionName, extensionId) {
        this.name = name;
        this.displayName = displayName;
        this.description = description;
        this.kind = kind;
        this.parameterSchema = parameterSchema;
        this.messageBus = messageBus;
        this.isOutputMarkdown = isOutputMarkdown;
        this.canUpdateOutput = canUpdateOutput;
        this.extensionName = extensionName;
        this.extensionId = extensionId;
    }
    get isReadOnly() {
        return READ_ONLY_KINDS.includes(this.kind);
    }
    get toolAnnotations() {
        return undefined;
    }
    getSchema(_modelId) {
        return {
            name: this.name,
            description: this.description,
            parametersJsonSchema: this.parameterSchema,
        };
    }
    get schema() {
        return this.getSchema();
    }
    /**
     * Validates the raw tool parameters.
     * Subclasses should override this to add custom validation logic
     * beyond the JSON schema check.
     * @param params The raw parameters from the model.
     * @returns An error message string if invalid, null otherwise.
     */
    validateToolParams(_params) {
        // Base implementation can be extended by subclasses.
        return null;
    }
    /**
     * A convenience method that builds and executes the tool in one step.
     * Throws an error if validation fails.
     * @param params The raw, untrusted parameters from the model.
     * @param signal AbortSignal for tool cancellation.
     * @param updateOutput Optional callback to stream output.
     * @returns The result of the tool execution.
     */
    async buildAndExecute(params, signal, updateOutput, shellExecutionConfig) {
        const invocation = this.build(params);
        return invocation.execute(signal, updateOutput, shellExecutionConfig);
    }
    /**
     * Similar to `build` but never throws.
     * @param params The raw, untrusted parameters from the model.
     * @returns A `ToolInvocation` instance.
     */
    silentBuild(params) {
        try {
            return this.build(params);
        }
        catch (e) {
            if (e instanceof Error) {
                return e;
            }
            return new Error(String(e));
        }
    }
    /**
     * A convenience method that builds and executes the tool in one step.
     * Never throws.
     * @param params The raw, untrusted parameters from the model.
     * @param abortSignal a signal to abort.
     * @returns The result of the tool execution.
     */
    async validateBuildAndExecute(params, abortSignal) {
        const invocationOrError = this.silentBuild(params);
        if (invocationOrError instanceof Error) {
            const errorMessage = invocationOrError.message;
            return {
                llmContent: `Error: Invalid parameters provided. Reason: ${errorMessage}`,
                returnDisplay: errorMessage,
                error: {
                    message: errorMessage,
                    type: ToolErrorType.INVALID_TOOL_PARAMS,
                },
            };
        }
        try {
            return await invocationOrError.execute(abortSignal);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                llmContent: `Error: Tool call execution failed. Reason: ${errorMessage}`,
                returnDisplay: errorMessage,
                error: {
                    message: errorMessage,
                    type: ToolErrorType.EXECUTION_FAILED,
                },
            };
        }
    }
}
/**
 * New base class for declarative tools that separates validation from execution.
 * New tools should extend this class, which provides a `build` method that
 * validates parameters before deferring to a `createInvocation` method for
 * the final `ToolInvocation` object instantiation.
 */
export class BaseDeclarativeTool extends DeclarativeTool {
    build(params) {
        const validationError = this.validateToolParams(params);
        if (validationError) {
            throw new Error(validationError);
        }
        return this.createInvocation(params, this.messageBus, this.name, this.displayName);
    }
    validateToolParams(params) {
        const errors = SchemaValidator.validate(this.schema.parametersJsonSchema, params);
        if (errors) {
            return errors;
        }
        return this.validateToolParamValues(params);
    }
    validateToolParamValues(_params) {
        // Base implementation can be extended by subclasses.
        return null;
    }
}
/**
 * Type guard to check if an object is a Tool.
 * @param obj The object to check.
 * @returns True if the object is a Tool, false otherwise.
 */
export function isTool(obj) {
    return (typeof obj === 'object' &&
        obj !== null &&
        'name' in obj &&
        'build' in obj &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        typeof obj.build === 'function');
}
/**
 * Detects cycles in a JSON schemas due to `$ref`s.
 * @param schema The root of the JSON schema.
 * @returns `true` if a cycle is detected, `false` otherwise.
 */
export function hasCycleInSchema(schema) {
    function resolveRef(ref) {
        if (!ref.startsWith('#/')) {
            return null;
        }
        const path = ref.substring(2).split('/');
        let current = schema;
        for (const segment of path) {
            if (typeof current !== 'object' ||
                current === null ||
                !Object.prototype.hasOwnProperty.call(current, segment)) {
                return null;
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            current = current[segment];
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return current;
    }
    function traverse(node, visitedRefs, pathRefs) {
        if (typeof node !== 'object' || node === null) {
            return false;
        }
        if (Array.isArray(node)) {
            for (const item of node) {
                if (traverse(item, visitedRefs, pathRefs)) {
                    return true;
                }
            }
            return false;
        }
        if ('$ref' in node && typeof node.$ref === 'string') {
            const ref = node.$ref;
            if (ref === '#' || ref === '#/' || pathRefs.has(ref)) {
                // A ref to just '#/' is always a cycle.
                return true; // Cycle detected!
            }
            if (visitedRefs.has(ref)) {
                return false; // Bail early, we have checked this ref before.
            }
            const resolvedNode = resolveRef(ref);
            if (resolvedNode) {
                // Add it to both visited and the current path
                visitedRefs.add(ref);
                pathRefs.add(ref);
                const hasCycle = traverse(resolvedNode, visitedRefs, pathRefs);
                pathRefs.delete(ref); // Backtrack, leaving it in visited
                return hasCycle;
            }
        }
        // Crawl all the properties of node
        for (const key in node) {
            if (Object.prototype.hasOwnProperty.call(node, key)) {
                if (traverse(
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                node[key], visitedRefs, pathRefs)) {
                    return true;
                }
            }
        }
        return false;
    }
    return traverse(schema, new Set(), new Set());
}
export var ToolConfirmationOutcome;
(function (ToolConfirmationOutcome) {
    ToolConfirmationOutcome["ProceedOnce"] = "proceed_once";
    ToolConfirmationOutcome["ProceedAlways"] = "proceed_always";
    ToolConfirmationOutcome["ProceedAlwaysAndSave"] = "proceed_always_and_save";
    ToolConfirmationOutcome["ProceedAlwaysServer"] = "proceed_always_server";
    ToolConfirmationOutcome["ProceedAlwaysTool"] = "proceed_always_tool";
    ToolConfirmationOutcome["ModifyWithEditor"] = "modify_with_editor";
    ToolConfirmationOutcome["Cancel"] = "cancel";
})(ToolConfirmationOutcome || (ToolConfirmationOutcome = {}));
export var Kind;
(function (Kind) {
    Kind["Read"] = "read";
    Kind["Edit"] = "edit";
    Kind["Delete"] = "delete";
    Kind["Move"] = "move";
    Kind["Search"] = "search";
    Kind["Execute"] = "execute";
    Kind["Think"] = "think";
    Kind["Agent"] = "agent";
    Kind["Fetch"] = "fetch";
    Kind["Communicate"] = "communicate";
    Kind["Plan"] = "plan";
    Kind["SwitchMode"] = "switch_mode";
    Kind["Other"] = "other";
})(Kind || (Kind = {}));
// Function kinds that have side effects
export const MUTATOR_KINDS = [
    Kind.Edit,
    Kind.Delete,
    Kind.Move,
    Kind.Execute,
];
// Function kinds that are safe to run in parallel
export const READ_ONLY_KINDS = [
    Kind.Read,
    Kind.Search,
    Kind.Fetch,
];
//# sourceMappingURL=tools.js.map