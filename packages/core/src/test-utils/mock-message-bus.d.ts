/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType, type Message } from '../confirmation-bus/types.js';
/**
 * Mock MessageBus for testing hook execution through MessageBus
 */
export declare class MockMessageBus {
    private subscriptions;
    publishedMessages: Message[];
    defaultToolDecision: 'allow' | 'deny' | 'ask_user';
    /**
     * Mock publish method that captures messages and simulates responses
     */
    publish: import("vitest").Mock<(message: Message) => void>;
    /**
     * Mock subscribe method that stores listeners
     */
    subscribe: import("vitest").Mock<(type: MessageBusType, listener: (message: Message) => void) => void>;
    /**
     * Mock unsubscribe method
     */
    unsubscribe: import("vitest").Mock<(type: MessageBusType, listener: (message: Message) => void) => void>;
    /**
     * Emit a message to subscribers (for testing)
     */
    private emit;
    /**
     * Clear all captured messages (for test isolation)
     */
    clear(): void;
}
/**
 * Create a mock MessageBus for testing
 */
export declare function createMockMessageBus(): MessageBus;
/**
 * Get the MockMessageBus instance from a mocked MessageBus
 */
export declare function getMockMessageBusInstance(messageBus: MessageBus): MockMessageBus;
