/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PolicyDecision } from '../policy/types.js';
import { MessageBusType } from './types.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import { debugLogger } from '../utils/debugLogger.js';
export class MessageBus extends EventEmitter {
    policyEngine;
    debug;
    constructor(policyEngine, debug = false) {
        super();
        this.policyEngine = policyEngine;
        this.debug = debug;
        this.debug = debug;
    }
    isValidMessage(message) {
        if (!message || !message.type) {
            return false;
        }
        if (message.type === MessageBusType.TOOL_CONFIRMATION_REQUEST &&
            !('correlationId' in message)) {
            return false;
        }
        return true;
    }
    emitMessage(message) {
        this.emit(message.type, message);
    }
    async publish(message) {
        if (this.debug) {
            debugLogger.debug(`[MESSAGE_BUS] publish: ${safeJsonStringify(message)}`);
        }
        try {
            if (!this.isValidMessage(message)) {
                throw new Error(`Invalid message structure: ${safeJsonStringify(message)}`);
            }
            if (message.type === MessageBusType.TOOL_CONFIRMATION_REQUEST) {
                const { decision } = await this.policyEngine.check(message.toolCall, message.serverName, message.toolAnnotations);
                switch (decision) {
                    case PolicyDecision.ALLOW:
                        // Directly emit the response instead of recursive publish
                        this.emitMessage({
                            type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
                            correlationId: message.correlationId,
                            confirmed: true,
                        });
                        break;
                    case PolicyDecision.DENY:
                        // Emit both rejection and response messages
                        this.emitMessage({
                            type: MessageBusType.TOOL_POLICY_REJECTION,
                            toolCall: message.toolCall,
                        });
                        this.emitMessage({
                            type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
                            correlationId: message.correlationId,
                            confirmed: false,
                        });
                        break;
                    case PolicyDecision.ASK_USER:
                        // Pass through to UI for user confirmation if any listeners exist.
                        // If no listeners are registered (e.g., headless/ACP flows),
                        // immediately request user confirmation to avoid long timeouts.
                        if (this.listenerCount(MessageBusType.TOOL_CONFIRMATION_REQUEST) > 0) {
                            this.emitMessage(message);
                        }
                        else {
                            this.emitMessage({
                                type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
                                correlationId: message.correlationId,
                                confirmed: false,
                                requiresUserConfirmation: true,
                            });
                        }
                        break;
                    default:
                        throw new Error(`Unknown policy decision: ${decision}`);
                }
            }
            else {
                // For all other message types, just emit them
                this.emitMessage(message);
            }
        }
        catch (error) {
            this.emit('error', error);
        }
    }
    subscribe(type, listener) {
        this.on(type, listener);
    }
    unsubscribe(type, listener) {
        this.off(type, listener);
    }
    /**
     * Request-response pattern: Publish a message and wait for a correlated response
     * This enables synchronous-style communication over the async MessageBus
     * The correlation ID is generated internally and added to the request
     */
    async request(request, responseType, timeoutMs = 60000) {
        const correlationId = randomUUID();
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error(`Request timed out waiting for ${responseType}`));
            }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timeoutId);
                this.unsubscribe(responseType, responseHandler);
            };
            const responseHandler = (response) => {
                // Check if this response matches our request
                if ('correlationId' in response &&
                    response.correlationId === correlationId) {
                    cleanup();
                    resolve(response);
                }
            };
            // Subscribe to responses
            this.subscribe(responseType, responseHandler);
            // Publish the request with correlation ID
            // eslint-disable-next-line @typescript-eslint/no-floating-promises, @typescript-eslint/no-unsafe-type-assertion
            this.publish({ ...request, correlationId });
        });
    }
}
//# sourceMappingURL=message-bus.js.map