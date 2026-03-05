/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { GitIgnoreParser, } from '../utils/gitIgnoreParser.js';
import { IgnoreFileParser, } from '../utils/ignoreFileParser.js';
import { isGitRepository } from '../utils/gitUtils.js';
import { GEMINI_IGNORE_FILE_NAME } from '../config/constants.js';
import fs from 'node:fs';
import * as path from 'node:path';
export class FileDiscoveryService {
    gitIgnoreFilter = null;
    geminiIgnoreFilter = null;
    customIgnoreFilter = null;
    combinedIgnoreFilter = null;
    defaultFilterFileOptions = {
        respectGitIgnore: true,
        respectGeminiIgnore: true,
        customIgnoreFilePaths: [],
    };
    projectRoot;
    constructor(projectRoot, options) {
        this.projectRoot = path.resolve(projectRoot);
        this.applyFilterFilesOptions(options);
        if (isGitRepository(this.projectRoot)) {
            this.gitIgnoreFilter = new GitIgnoreParser(this.projectRoot);
        }
        this.geminiIgnoreFilter = new IgnoreFileParser(this.projectRoot, GEMINI_IGNORE_FILE_NAME);
        if (this.defaultFilterFileOptions.customIgnoreFilePaths?.length) {
            this.customIgnoreFilter = new IgnoreFileParser(this.projectRoot, this.defaultFilterFileOptions.customIgnoreFilePaths);
        }
        if (this.gitIgnoreFilter) {
            const geminiPatterns = this.geminiIgnoreFilter.getPatterns();
            const customPatterns = this.customIgnoreFilter
                ? this.customIgnoreFilter.getPatterns()
                : [];
            // Create combined parser: .gitignore + .geminiignore + custom ignore
            this.combinedIgnoreFilter = new GitIgnoreParser(this.projectRoot, 
            // customPatterns should go the last to ensure overwriting of geminiPatterns
            [...geminiPatterns, ...customPatterns]);
        }
        else {
            // Create combined parser when not git repo
            const geminiPatterns = this.geminiIgnoreFilter.getPatterns();
            const customPatterns = this.customIgnoreFilter
                ? this.customIgnoreFilter.getPatterns()
                : [];
            this.combinedIgnoreFilter = new IgnoreFileParser(this.projectRoot, [...geminiPatterns, ...customPatterns], true);
        }
    }
    applyFilterFilesOptions(options) {
        if (!options)
            return;
        if (options.respectGitIgnore !== undefined) {
            this.defaultFilterFileOptions.respectGitIgnore = options.respectGitIgnore;
        }
        if (options.respectGeminiIgnore !== undefined) {
            this.defaultFilterFileOptions.respectGeminiIgnore =
                options.respectGeminiIgnore;
        }
        if (options.customIgnoreFilePaths) {
            this.defaultFilterFileOptions.customIgnoreFilePaths =
                options.customIgnoreFilePaths;
        }
    }
    /**
     * Filters a list of file paths based on ignore rules
     */
    filterFiles(filePaths, options = {}) {
        const { respectGitIgnore = this.defaultFilterFileOptions.respectGitIgnore, respectGeminiIgnore = this.defaultFilterFileOptions.respectGeminiIgnore, } = options;
        return filePaths.filter((filePath) => {
            if (respectGitIgnore &&
                respectGeminiIgnore &&
                this.combinedIgnoreFilter) {
                return !this.combinedIgnoreFilter.isIgnored(filePath);
            }
            // Always respect custom ignore filter if provided
            if (this.customIgnoreFilter?.isIgnored(filePath)) {
                return false;
            }
            if (respectGitIgnore && this.gitIgnoreFilter?.isIgnored(filePath)) {
                return false;
            }
            if (respectGeminiIgnore && this.geminiIgnoreFilter?.isIgnored(filePath)) {
                return false;
            }
            return true;
        });
    }
    /**
     * Filters a list of file paths based on git ignore rules and returns a report
     * with counts of ignored files.
     */
    filterFilesWithReport(filePaths, opts = {
        respectGitIgnore: true,
        respectGeminiIgnore: true,
    }) {
        const filteredPaths = this.filterFiles(filePaths, opts);
        const ignoredCount = filePaths.length - filteredPaths.length;
        return {
            filteredPaths,
            ignoredCount,
        };
    }
    /**
     * Unified method to check if a file should be ignored based on filtering options
     */
    shouldIgnoreFile(filePath, options = {}) {
        return this.filterFiles([filePath], options).length === 0;
    }
    /**
     * Returns the list of ignore files being used (e.g. .geminiignore) excluding .gitignore.
     */
    getIgnoreFilePaths() {
        const paths = [];
        if (this.geminiIgnoreFilter &&
            this.defaultFilterFileOptions.respectGeminiIgnore) {
            paths.push(...this.geminiIgnoreFilter.getIgnoreFilePaths());
        }
        if (this.customIgnoreFilter) {
            paths.push(...this.customIgnoreFilter.getIgnoreFilePaths());
        }
        return paths;
    }
    /**
     * Returns all ignore files including .gitignore if applicable.
     */
    getAllIgnoreFilePaths() {
        const paths = [];
        if (this.gitIgnoreFilter &&
            this.defaultFilterFileOptions.respectGitIgnore) {
            const gitIgnorePath = path.join(this.projectRoot, '.gitignore');
            if (fs.existsSync(gitIgnorePath)) {
                paths.push(gitIgnorePath);
            }
        }
        return paths.concat(this.getIgnoreFilePaths());
    }
}
//# sourceMappingURL=fileDiscoveryService.js.map