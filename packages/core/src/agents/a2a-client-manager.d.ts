/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AgentCard, Message, Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import { type Client, type AuthenticationHandler } from '@a2a-js/sdk/client';
export type SendMessageResult = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
/**
 * Manages A2A clients and caches loaded agent information.
 * Follows a singleton pattern to ensure a single client instance.
 */
export declare class A2AClientManager {
    private static instance;
    private clients;
    private agentCards;
    private constructor();
    /**
     * Gets the singleton instance of the A2AClientManager.
     */
    static getInstance(): A2AClientManager;
    /**
     * Resets the singleton instance. Only for testing purposes.
     * @internal
     */
    static resetInstanceForTesting(): void;
    /**
     * Loads an agent by fetching its AgentCard and caches the client.
     * @param name The name to assign to the agent.
     * @param agentCardUrl The full URL to the agent's card.
     * @param authHandler Optional authentication handler to use for this agent.
     * @returns The loaded AgentCard.
     */
    loadAgent(name: string, agentCardUrl: string, authHandler?: AuthenticationHandler): Promise<AgentCard>;
    /**
     * Invalidates all cached clients and agent cards.
     */
    clearCache(): void;
    /**
     * Sends a message to a loaded agent and returns a stream of responses.
     * @param agentName The name of the agent to send the message to.
     * @param message The message content.
     * @param options Optional context and task IDs to maintain conversation state.
     * @returns An async iterable of responses from the agent (Message or Task).
     * @throws Error if the agent returns an error response.
     */
    sendMessageStream(agentName: string, message: string, options?: {
        contextId?: string;
        taskId?: string;
        signal?: AbortSignal;
    }): AsyncIterable<SendMessageResult>;
    /**
     * Retrieves a loaded agent card.
     * @param name The name of the agent.
     * @returns The agent card, or undefined if not found.
     */
    getAgentCard(name: string): AgentCard | undefined;
    /**
     * Retrieves a loaded client.
     * @param name The name of the agent.
     * @returns The client, or undefined if not found.
     */
    getClient(name: string): Client | undefined;
    /**
     * Retrieves a task from an agent.
     * @param agentName The name of the agent.
     * @param taskId The ID of the task to retrieve.
     * @returns The task details.
     */
    getTask(agentName: string, taskId: string): Promise<Task>;
    /**
     * Cancels a task on an agent.
     * @param agentName The name of the agent.
     * @param taskId The ID of the task to cancel.
     * @returns The cancellation response.
     */
    cancelTask(agentName: string, taskId: string): Promise<Task>;
}
