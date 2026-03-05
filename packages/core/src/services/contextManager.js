/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { loadJitSubdirectoryMemory, concatenateInstructions, getGlobalMemoryPaths, getExtensionMemoryPaths, getEnvironmentMemoryPaths, readGeminiMdFiles, categorizeAndConcatenate, } from '../utils/memoryDiscovery.js';
import { coreEvents, CoreEvent } from '../utils/events.js';
export class ContextManager {
    loadedPaths = new Set();
    config;
    globalMemory = '';
    extensionMemory = '';
    projectMemory = '';
    constructor(config) {
        this.config = config;
    }
    /**
     * Refreshes the memory by reloading global, extension, and project memory.
     */
    async refresh() {
        this.loadedPaths.clear();
        const debugMode = this.config.getDebugMode();
        const paths = await this.discoverMemoryPaths(debugMode);
        const contentsMap = await this.loadMemoryContents(paths, debugMode);
        this.categorizeMemoryContents(paths, contentsMap);
        this.emitMemoryChanged();
    }
    async discoverMemoryPaths(debugMode) {
        const [global, extension, project] = await Promise.all([
            getGlobalMemoryPaths(debugMode),
            Promise.resolve(getExtensionMemoryPaths(this.config.getExtensionLoader())),
            this.config.isTrustedFolder()
                ? getEnvironmentMemoryPaths([...this.config.getWorkspaceContext().getDirectories()], debugMode)
                : Promise.resolve([]),
        ]);
        return { global, extension, project };
    }
    async loadMemoryContents(paths, debugMode) {
        const allPaths = Array.from(new Set([...paths.global, ...paths.extension, ...paths.project]));
        const allContents = await readGeminiMdFiles(allPaths, debugMode, this.config.getImportFormat());
        this.markAsLoaded(allContents.filter((c) => c.content !== null).map((c) => c.filePath));
        return new Map(allContents.map((c) => [c.filePath, c]));
    }
    categorizeMemoryContents(paths, contentsMap) {
        const workingDir = this.config.getWorkingDir();
        const hierarchicalMemory = categorizeAndConcatenate(paths, contentsMap, workingDir);
        this.globalMemory = hierarchicalMemory.global || '';
        this.extensionMemory = hierarchicalMemory.extension || '';
        const mcpInstructions = this.config.getMcpClientManager()?.getMcpInstructions() || '';
        const projectMemoryWithMcp = [
            hierarchicalMemory.project,
            mcpInstructions.trimStart(),
        ]
            .filter(Boolean)
            .join('\n\n');
        this.projectMemory = this.config.isTrustedFolder()
            ? projectMemoryWithMcp
            : '';
    }
    /**
     * Discovers and loads context for a specific accessed path (Tier 3 - JIT).
     * Traverses upwards from the accessed path to the project root.
     */
    async discoverContext(accessedPath, trustedRoots) {
        if (!this.config.isTrustedFolder()) {
            return '';
        }
        const result = await loadJitSubdirectoryMemory(accessedPath, trustedRoots, this.loadedPaths, this.config.getDebugMode());
        if (result.files.length === 0) {
            return '';
        }
        this.markAsLoaded(result.files.map((f) => f.path));
        return concatenateInstructions(result.files.map((f) => ({ filePath: f.path, content: f.content })), this.config.getWorkingDir());
    }
    emitMemoryChanged() {
        coreEvents.emit(CoreEvent.MemoryChanged, {
            fileCount: this.loadedPaths.size,
        });
    }
    getGlobalMemory() {
        return this.globalMemory;
    }
    getExtensionMemory() {
        return this.extensionMemory;
    }
    getEnvironmentMemory() {
        return this.projectMemory;
    }
    markAsLoaded(paths) {
        paths.forEach((p) => this.loadedPaths.add(p));
    }
    getLoadedPaths() {
        return this.loadedPaths;
    }
}
//# sourceMappingURL=contextManager.js.map