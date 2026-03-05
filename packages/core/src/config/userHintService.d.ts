/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Service for managing user steering hints during a session.
 */
export declare class UserHintService {
    private readonly isEnabled;
    private readonly userHints;
    private readonly userHintListeners;
    constructor(isEnabled: () => boolean);
    /**
     * Adds a new steering hint from the user.
     */
    addUserHint(hint: string): void;
    /**
     * Registers a listener for new user hints.
     */
    onUserHint(listener: (hint: string) => void): void;
    /**
     * Unregisters a listener for new user hints.
     */
    offUserHint(listener: (hint: string) => void): void;
    /**
     * Returns all collected hints.
     */
    getUserHints(): string[];
    /**
     * Returns hints added after a specific index.
     */
    getUserHintsAfter(index: number): string[];
    /**
     * Returns the index of the latest hint.
     */
    getLatestHintIndex(): number;
    /**
     * Returns the timestamp of the last user hint.
     */
    getLastUserHintAt(): number | null;
    /**
     * Clears all collected hints.
     */
    clear(): void;
}
