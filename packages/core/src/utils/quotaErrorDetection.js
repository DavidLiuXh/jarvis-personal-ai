/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export function isApiError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'error' in error &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        typeof error.error === 'object' &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        'message' in error.error);
}
export function isStructuredError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        typeof error.message === 'string');
}
//# sourceMappingURL=quotaErrorDetection.js.map