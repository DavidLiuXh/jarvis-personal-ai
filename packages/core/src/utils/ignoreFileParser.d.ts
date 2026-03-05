/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export interface IgnoreFileFilter {
    isIgnored(filePath: string): boolean;
    getPatterns(): string[];
    getIgnoreFilePaths(): string[];
    hasPatterns(): boolean;
}
/**
 * An ignore file parser that reads the ignore files from the project root.
 */
export declare class IgnoreFileParser implements IgnoreFileFilter {
    private projectRoot;
    private patterns;
    private ig;
    private readonly fileNames;
    constructor(projectRoot: string, input: string | string[], isPatterns?: boolean);
    private loadPatternsFromFiles;
    private parseIgnoreFile;
    isIgnored(filePath: string): boolean;
    getPatterns(): string[];
    getIgnoreFilePaths(): string[];
    /**
     * Returns true if at least one ignore file exists and has patterns.
     */
    hasPatterns(): boolean;
}
