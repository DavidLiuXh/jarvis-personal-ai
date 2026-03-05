/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Service for managing user steering hints during a session.
 */
export class UserHintService {
    isEnabled;
    userHints = [];
    userHintListeners = new Set();
    constructor(isEnabled) {
        this.isEnabled = isEnabled;
    }
    /**
     * Adds a new steering hint from the user.
     */
    addUserHint(hint) {
        if (!this.isEnabled()) {
            return;
        }
        const trimmed = hint.trim();
        if (trimmed.length === 0) {
            return;
        }
        this.userHints.push({ text: trimmed, timestamp: Date.now() });
        for (const listener of this.userHintListeners) {
            listener(trimmed);
        }
    }
    /**
     * Registers a listener for new user hints.
     */
    onUserHint(listener) {
        this.userHintListeners.add(listener);
    }
    /**
     * Unregisters a listener for new user hints.
     */
    offUserHint(listener) {
        this.userHintListeners.delete(listener);
    }
    /**
     * Returns all collected hints.
     */
    getUserHints() {
        return this.userHints.map((h) => h.text);
    }
    /**
     * Returns hints added after a specific index.
     */
    getUserHintsAfter(index) {
        if (index < 0) {
            return this.getUserHints();
        }
        return this.userHints.slice(index + 1).map((h) => h.text);
    }
    /**
     * Returns the index of the latest hint.
     */
    getLatestHintIndex() {
        return this.userHints.length - 1;
    }
    /**
     * Returns the timestamp of the last user hint.
     */
    getLastUserHintAt() {
        if (this.userHints.length === 0) {
            return null;
        }
        return this.userHints[this.userHints.length - 1].timestamp;
    }
    /**
     * Clears all collected hints.
     */
    clear() {
        this.userHints.length = 0;
    }
}
//# sourceMappingURL=userHintService.js.map