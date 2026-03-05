/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { type FileFilteringOptions } from '../config/constants.js';
import type { ExtensionLoader } from './extensionLoader.js';
import type { Config } from '../config/config.js';
import type { HierarchicalMemory } from '../config/memory.js';
export interface GeminiFileContent {
    filePath: string;
    content: string | null;
}
export declare function readGeminiMdFiles(filePaths: string[], debugMode: boolean, importFormat?: 'flat' | 'tree'): Promise<GeminiFileContent[]>;
export declare function concatenateInstructions(instructionContents: GeminiFileContent[], currentWorkingDirectoryForDisplay: string): string;
export interface MemoryLoadResult {
    files: Array<{
        path: string;
        content: string;
    }>;
}
export declare function getGlobalMemoryPaths(debugMode?: boolean): Promise<string[]>;
export declare function getExtensionMemoryPaths(extensionLoader: ExtensionLoader): string[];
export declare function getEnvironmentMemoryPaths(trustedRoots: string[], debugMode?: boolean): Promise<string[]>;
export declare function categorizeAndConcatenate(paths: {
    global: string[];
    extension: string[];
    project: string[];
}, contentsMap: Map<string, GeminiFileContent>, workingDir: string): HierarchicalMemory;
export interface LoadServerHierarchicalMemoryResponse {
    memoryContent: HierarchicalMemory;
    fileCount: number;
    filePaths: string[];
}
/**
 * Loads hierarchical GEMINI.md files and concatenates their content.
 * This function is intended for use by the server.
 */
export declare function loadServerHierarchicalMemory(currentWorkingDirectory: string, includeDirectoriesToReadGemini: readonly string[], debugMode: boolean, fileService: FileDiscoveryService, extensionLoader: ExtensionLoader, folderTrust: boolean, importFormat?: 'flat' | 'tree', fileFilteringOptions?: FileFilteringOptions, maxDirs?: number): Promise<LoadServerHierarchicalMemoryResponse>;
/**
 * Loads the hierarchical memory and resets the state of `config` as needed such
 * that it reflects the new memory.
 *
 * Returns the result of the call to `loadHierarchicalGeminiMemory`.
 */
export declare function refreshServerHierarchicalMemory(config: Config): Promise<LoadServerHierarchicalMemoryResponse>;
export declare function loadJitSubdirectoryMemory(targetPath: string, trustedRoots: string[], alreadyLoadedPaths: Set<string>, debugMode?: boolean): Promise<MemoryLoadResult>;
