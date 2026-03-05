/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export declare const GEMINI_DIR = ".gemini";
export declare const GOOGLE_ACCOUNTS_FILENAME = "google_accounts.json";
/**
 * Returns the home directory.
 * If GEMINI_CLI_HOME environment variable is set, it returns its value.
 * Otherwise, it returns the user's home directory.
 */
export declare function homedir(): string;
/**
 * Returns the operating system's default directory for temporary files.
 */
export declare function tmpdir(): string;
/**
 * Replaces the home directory with a tilde.
 * @param path - The path to tildeify.
 * @returns The tildeified path.
 */
export declare function tildeifyPath(path: string): string;
/**
 * Shortens a path string if it exceeds maxLen, prioritizing the start and end segments.
 * Example: /path/to/a/very/long/file.txt -> /path/.../long/file.txt
 */
export declare function shortenPath(filePath: string, maxLen?: number): string;
/**
 * Calculates the relative path from a root directory to a target path.
 * If targetPath is relative, it is returned as-is.
 * Returns '.' if the target path is the same as the root directory.
 *
 * @param targetPath The absolute or relative path to make relative.
 * @param rootDirectory The absolute path of the directory to make the target path relative to.
 * @returns The relative path from rootDirectory to targetPath.
 */
export declare function makeRelative(targetPath: string, rootDirectory: string): string;
/**
 * Escape paths for at-commands.
 *
 *  - Windows: double quoted if they contain special chars, otherwise bare
 *  - POSIX: backslash-escaped
 */
export declare function escapePath(filePath: string): string;
/**
 * Unescapes paths for at-commands.
 *
 *  - Windows: double quoted if they contain special chars, otherwise bare
 *  - POSIX: backslash-escaped
 */
export declare function unescapePath(filePath: string): string;
/**
 * Generates a unique hash for a project based on its root path.
 * @param projectRoot The absolute path to the project's root directory.
 * @returns A SHA256 hash of the project root path.
 */
export declare function getProjectHash(projectRoot: string): string;
/**
 * Normalizes a path for reliable comparison across platforms.
 * - Resolves to an absolute path.
 * - Converts all path separators to forward slashes.
 * - On Windows, converts to lowercase for case-insensitivity.
 */
export declare function normalizePath(p: string): string;
/**
 * Checks if a path is a subpath of another path.
 * @param parentPath The parent path.
 * @param childPath The child path.
 * @returns True if childPath is a subpath of parentPath, false otherwise.
 */
export declare function isSubpath(parentPath: string, childPath: string): boolean;
/**
 * Resolves a path to its real path, sanitizing it first.
 * - Removes 'file://' protocol if present.
 * - Decodes URI components (e.g. %20 -> space).
 * - Resolves symbolic links using fs.realpathSync.
 *
 * @param pathStr The path string to resolve.
 * @returns The resolved real path.
 */
export declare function resolveToRealPath(path: string): string;
