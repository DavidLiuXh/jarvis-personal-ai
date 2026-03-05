/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export interface FilterFilesOptions {
    respectGitIgnore?: boolean;
    respectGeminiIgnore?: boolean;
    customIgnoreFilePaths?: string[];
}
export interface FilterReport {
    filteredPaths: string[];
    ignoredCount: number;
}
export declare class FileDiscoveryService {
    private gitIgnoreFilter;
    private geminiIgnoreFilter;
    private customIgnoreFilter;
    private combinedIgnoreFilter;
    private defaultFilterFileOptions;
    private projectRoot;
    constructor(projectRoot: string, options?: FilterFilesOptions);
    private applyFilterFilesOptions;
    /**
     * Filters a list of file paths based on ignore rules
     */
    filterFiles(filePaths: string[], options?: FilterFilesOptions): string[];
    /**
     * Filters a list of file paths based on git ignore rules and returns a report
     * with counts of ignored files.
     */
    filterFilesWithReport(filePaths: string[], opts?: FilterFilesOptions): FilterReport;
    /**
     * Unified method to check if a file should be ignored based on filtering options
     */
    shouldIgnoreFile(filePath: string, options?: FilterFilesOptions): boolean;
    /**
     * Returns the list of ignore files being used (e.g. .geminiignore) excluding .gitignore.
     */
    getIgnoreFilePaths(): string[];
    /**
     * Returns all ignore files including .gitignore if applicable.
     */
    getAllIgnoreFilePaths(): string[];
}
