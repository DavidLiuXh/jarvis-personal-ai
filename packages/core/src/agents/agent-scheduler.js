/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { Scheduler } from '../scheduler/scheduler.js';
/**
 * Schedules a batch of tool calls for an agent using the new event-driven Scheduler.
 *
 * @param config The global runtime configuration.
 * @param requests The list of tool call requests from the agent.
 * @param options Scheduling options including registry and IDs.
 * @returns A promise that resolves to the completed tool calls.
 */
export async function scheduleAgentTools(config, requests, options) {
    const { schedulerId, parentCallId, toolRegistry, signal, getPreferredEditor, onWaitingForConfirmation, } = options;
    // Create a proxy/override of the config to provide the agent-specific tool registry.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const agentConfig = Object.create(config);
    agentConfig.getToolRegistry = () => toolRegistry;
    const scheduler = new Scheduler({
        config: agentConfig,
        messageBus: config.getMessageBus(),
        getPreferredEditor: getPreferredEditor ?? (() => undefined),
        schedulerId,
        parentCallId,
        onWaitingForConfirmation,
    });
    return scheduler.schedule(requests, signal);
}
//# sourceMappingURL=agent-scheduler.js.map