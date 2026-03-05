/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Abstract base class for A2A authentication providers.
 * Provides default implementations for optional methods.
 */
export class BaseA2AAuthProvider {
    static MAX_AUTH_RETRIES = 2;
    authRetryCount = 0;
    /**
     * Check if a request should be retried with new headers.
     *
     * The default implementation checks for 401/403 status codes and
     * returns fresh headers for retry. Subclasses can override for
     * custom retry logic.
     *
     * @param _req The original request init
     * @param res The response from the server
     * @returns New headers for retry, or undefined if no retry should be made
     */
    async shouldRetryWithHeaders(_req, res) {
        if (res.status === 401 || res.status === 403) {
            if (this.authRetryCount >= BaseA2AAuthProvider.MAX_AUTH_RETRIES) {
                return undefined; // Max retries exceeded
            }
            this.authRetryCount++;
            return this.headers();
        }
        // Reset count if not an auth error
        this.authRetryCount = 0;
        return undefined;
    }
    /**
     * Initialize the provider. Override in subclasses that need async setup.
     */
    async initialize() {
        // Default: no-op
    }
}
//# sourceMappingURL=base-provider.js.map