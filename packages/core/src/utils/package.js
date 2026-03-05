/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { readPackageUp, } from 'read-package-up';
import { debugLogger } from './debugLogger.js';
/**
 * Reads package.json from the current directory or any parent directory.
 *
 * @param cwd - The directory to start searching from (searches upward to filesystem root)
 * @returns The package.json object if found, or `undefined` if no package.json exists
 *          in the directory hierarchy. This is expected behavior when called from
 *          directories outside of a Node.js project.
 *
 * @example
 * ```ts
 * const pkg = await getPackageJson(__dirname);
 * const version = pkg?.version ?? 'unknown';
 * ```
 */
export async function getPackageJson(cwd) {
    try {
        const result = await readPackageUp({ cwd, normalize: false });
        if (!result) {
            return undefined;
        }
        return result.packageJson;
    }
    catch (error) {
        debugLogger.error('Error occurred while reading package.json', error);
        return undefined;
    }
}
//# sourceMappingURL=package.js.map