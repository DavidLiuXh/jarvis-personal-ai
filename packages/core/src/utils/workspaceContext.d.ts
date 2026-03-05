/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export type Unsubscribe = () => void;
export interface AddDirectoriesResult {
    added: string[];
    failed: Array<{
        path: string;
        error: Error;
    }>;
}
/**
 * WorkspaceContext manages multiple workspace directories and validates paths
 * against them. This allows the CLI to operate on files from multiple directories
 * in a single session.
 */
export declare class WorkspaceContext {
    readonly targetDir: string;
    private directories;
    private initialDirectories;
    private readOnlyPaths;
    private onDirectoriesChangedListeners;
    /**
     * Creates a new WorkspaceContext with the given initial directory and optional additional directories.
     * @param targetDir The initial working directory (usually cwd)
     * @param additionalDirectories Optional array of additional directories to include
     */
    constructor(targetDir: string, additionalDirectories?: string[]);
    /**
     * Registers a listener that is called when the workspace directories change.
     * @param listener The listener to call.
     * @returns A function to unsubscribe the listener.
     */
    onDirectoriesChanged(listener: () => void): Unsubscribe;
    private notifyDirectoriesChanged;
    /**
     * Adds a directory to the workspace.
     * @param directory The directory path to add (can be relative or absolute)
     * @param basePath Optional base path for resolving relative paths (defaults to cwd)
     * @throws Error if the directory cannot be added
     */
    addDirectory(directory: string): void;
    /**
     * Adds multiple directories to the workspace.
     * Emits a single change event if any directories are added.
     * @param directories The directory paths to add
     * @returns Object containing successfully added directories and failures
     */
    addDirectories(directories: string[]): AddDirectoriesResult;
    /**
     * Adds a path to the read-only list.
     * These paths are allowed for reading but not for writing (unless they are also in the workspace).
     */
    addReadOnlyPath(pathToAdd: string): void;
    private resolveAndValidateDir;
    /**
     * Gets a copy of all workspace directories.
     * @returns Array of absolute directory paths
     */
    getDirectories(): readonly string[];
    getInitialDirectories(): readonly string[];
    setDirectories(directories: readonly string[]): void;
    /**
     * Checks if a given path is within any of the workspace directories.
     * @param pathToCheck The path to validate
     * @returns True if the path is within the workspace, false otherwise
     */
    isPathWithinWorkspace(pathToCheck: string): boolean;
    /**
     * Checks if a path is allowed to be read.
     * This includes workspace paths and explicitly added read-only paths.
     * @param pathToCheck The path to validate
     * @returns True if the path is readable, false otherwise
     */
    isPathReadable(pathToCheck: string): boolean;
    /**
     * Fully resolves a path, including symbolic links.
     * If the path does not exist, it returns the fully resolved path as it would be
     * if it did exist.
     */
    private fullyResolvedPath;
    /**
     * Checks if a path is within a given root directory.
     * @param pathToCheck The absolute path to check
     * @param rootDirectory The absolute root directory
     * @returns True if the path is within the root directory, false otherwise
     */
    private isPathWithinRoot;
    /**
     * Checks if a file path is a symbolic link that points to a file.
     */
    private isFileSymlink;
}
