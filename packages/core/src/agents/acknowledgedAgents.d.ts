/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export interface AcknowledgedAgentsMap {
    [projectPath: string]: {
        [agentName: string]: string;
    };
}
export declare class AcknowledgedAgentsService {
    private acknowledgedAgents;
    private loaded;
    load(): Promise<void>;
    save(): Promise<void>;
    isAcknowledged(projectPath: string, agentName: string, hash: string): Promise<boolean>;
    acknowledge(projectPath: string, agentName: string, hash: string): Promise<void>;
}
