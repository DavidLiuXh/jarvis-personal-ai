/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach, afterEach, } from 'vitest';
import { SimpleExtensionLoader } from './extensionLoader.js';
import { PolicyDecision } from '../policy/types.js';
import {} from '../tools/mcp-client-manager.js';
const mockRefreshServerHierarchicalMemory = vi.hoisted(() => vi.fn());
vi.mock('./memoryDiscovery.js', async (importActual) => {
    const actual = await importActual();
    return {
        ...actual,
        refreshServerHierarchicalMemory: mockRefreshServerHierarchicalMemory,
    };
});
describe('SimpleExtensionLoader', () => {
    let mockConfig;
    let extensionReloadingEnabled;
    let mockMcpClientManager;
    let mockGeminiClientSetTools;
    let mockHookSystemInit;
    let mockAgentRegistryReload;
    let mockSkillsReload;
    let mockPolicyEngine;
    const activeExtension = {
        name: 'test-extension',
        isActive: true,
        version: '1.0.0',
        path: '/path/to/extension',
        contextFiles: [],
        excludeTools: ['some-tool'],
        id: '123',
        rules: [
            {
                toolName: 'test-tool',
                decision: PolicyDecision.ALLOW,
                source: 'Extension (test-extension): policies.toml',
            },
        ],
        checkers: [
            {
                toolName: 'test-tool',
                checker: { type: 'external', name: 'test-checker' },
                source: 'Extension (test-extension): policies.toml',
            },
        ],
    };
    const inactiveExtension = {
        name: 'test-extension',
        isActive: false,
        version: '1.0.0',
        path: '/path/to/extension',
        contextFiles: [],
        id: '123',
    };
    beforeEach(() => {
        mockMcpClientManager = {
            startExtension: vi.fn(),
            stopExtension: vi.fn(),
        };
        extensionReloadingEnabled = false;
        mockGeminiClientSetTools = vi.fn();
        mockHookSystemInit = vi.fn();
        mockAgentRegistryReload = vi.fn();
        mockSkillsReload = vi.fn();
        mockPolicyEngine = {
            addRule: vi.fn(),
            addChecker: vi.fn(),
            removeRulesBySource: vi.fn(),
            removeCheckersBySource: vi.fn(),
        };
        mockConfig = {
            getMcpClientManager: () => mockMcpClientManager,
            getEnableExtensionReloading: () => extensionReloadingEnabled,
            getGeminiClient: vi.fn(() => ({
                isInitialized: () => true,
                setTools: mockGeminiClientSetTools,
            })),
            getHookSystem: () => ({
                initialize: mockHookSystemInit,
            }),
            getAgentRegistry: () => ({
                reload: mockAgentRegistryReload,
            }),
            reloadSkills: mockSkillsReload,
            getPolicyEngine: () => mockPolicyEngine,
        };
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('should register policies when an extension starts', async () => {
        const loader = new SimpleExtensionLoader([activeExtension]);
        await loader.start(mockConfig);
        expect(mockPolicyEngine.addRule).toHaveBeenCalledWith(activeExtension.rules[0]);
        expect(mockPolicyEngine.addChecker).toHaveBeenCalledWith(activeExtension.checkers[0]);
    });
    it('should unregister policies when an extension stops', async () => {
        const loader = new TestingSimpleExtensionLoader([activeExtension]);
        await loader.start(mockConfig);
        await loader.stopExtension(activeExtension);
        expect(mockPolicyEngine.removeRulesBySource).toHaveBeenCalledWith('Extension (test-extension): policies.toml');
        expect(mockPolicyEngine.removeCheckersBySource).toHaveBeenCalledWith('Extension (test-extension): policies.toml');
    });
    it('should start active extensions', async () => {
        const loader = new SimpleExtensionLoader([activeExtension]);
        await loader.start(mockConfig);
        expect(mockMcpClientManager.startExtension).toHaveBeenCalledExactlyOnceWith(activeExtension);
    });
    it('should not start inactive extensions', async () => {
        const loader = new SimpleExtensionLoader([inactiveExtension]);
        await loader.start(mockConfig);
        expect(mockMcpClientManager.startExtension).not.toHaveBeenCalled();
    });
    describe('interactive extension loading and unloading', () => {
        it('should not call `start` or `stop` if the loader is not already started', async () => {
            const loader = new SimpleExtensionLoader([]);
            await loader.loadExtension(activeExtension);
            expect(mockMcpClientManager.startExtension).not.toHaveBeenCalled();
            await loader.unloadExtension(activeExtension);
            expect(mockMcpClientManager.stopExtension).not.toHaveBeenCalled();
        });
        it('should start extensions that were explicitly loaded prior to initializing the loader', async () => {
            const loader = new SimpleExtensionLoader([]);
            await loader.loadExtension(activeExtension);
            expect(mockMcpClientManager.startExtension).not.toHaveBeenCalled();
            await loader.start(mockConfig);
            expect(mockMcpClientManager.startExtension).toHaveBeenCalledExactlyOnceWith(activeExtension);
        });
        describe.each([true, false])('when enableExtensionReloading === $i', (reloadingEnabled) => {
            beforeEach(() => {
                extensionReloadingEnabled = reloadingEnabled;
            });
            it(`should ${reloadingEnabled ? '' : 'not '}reload extension features`, async () => {
                const loader = new SimpleExtensionLoader([]);
                await loader.start(mockConfig);
                expect(mockMcpClientManager.startExtension).not.toHaveBeenCalled();
                await loader.loadExtension(activeExtension);
                if (reloadingEnabled) {
                    expect(mockMcpClientManager.startExtension).toHaveBeenCalledExactlyOnceWith(activeExtension);
                    expect(mockRefreshServerHierarchicalMemory).toHaveBeenCalledOnce();
                    expect(mockHookSystemInit).toHaveBeenCalledOnce();
                    expect(mockGeminiClientSetTools).toHaveBeenCalledOnce();
                    expect(mockAgentRegistryReload).toHaveBeenCalledOnce();
                    expect(mockSkillsReload).toHaveBeenCalledOnce();
                }
                else {
                    expect(mockMcpClientManager.startExtension).not.toHaveBeenCalled();
                    expect(mockRefreshServerHierarchicalMemory).not.toHaveBeenCalled();
                    expect(mockHookSystemInit).not.toHaveBeenCalled();
                    expect(mockGeminiClientSetTools).not.toHaveBeenCalledOnce();
                    expect(mockAgentRegistryReload).not.toHaveBeenCalled();
                    expect(mockSkillsReload).not.toHaveBeenCalled();
                }
                mockRefreshServerHierarchicalMemory.mockClear();
                mockHookSystemInit.mockClear();
                mockGeminiClientSetTools.mockClear();
                mockAgentRegistryReload.mockClear();
                mockSkillsReload.mockClear();
                await loader.unloadExtension(activeExtension);
                if (reloadingEnabled) {
                    expect(mockMcpClientManager.stopExtension).toHaveBeenCalledExactlyOnceWith(activeExtension);
                    expect(mockRefreshServerHierarchicalMemory).toHaveBeenCalledOnce();
                    expect(mockHookSystemInit).toHaveBeenCalledOnce();
                    expect(mockGeminiClientSetTools).toHaveBeenCalledOnce();
                    expect(mockAgentRegistryReload).toHaveBeenCalledOnce();
                    expect(mockSkillsReload).toHaveBeenCalledOnce();
                }
                else {
                    expect(mockMcpClientManager.stopExtension).not.toHaveBeenCalled();
                    expect(mockRefreshServerHierarchicalMemory).not.toHaveBeenCalled();
                    expect(mockHookSystemInit).not.toHaveBeenCalled();
                    expect(mockGeminiClientSetTools).not.toHaveBeenCalledOnce();
                    expect(mockAgentRegistryReload).not.toHaveBeenCalled();
                    expect(mockSkillsReload).not.toHaveBeenCalled();
                }
            });
            it.runIf(reloadingEnabled)('Should only reload memory once all extensions are done', async () => {
                const anotherExtension = {
                    ...activeExtension,
                    name: 'another-extension',
                };
                const loader = new SimpleExtensionLoader([]);
                await loader.loadExtension(activeExtension);
                await loader.start(mockConfig);
                expect(mockRefreshServerHierarchicalMemory).not.toHaveBeenCalled();
                await Promise.all([
                    loader.unloadExtension(activeExtension),
                    loader.loadExtension(anotherExtension),
                ]);
                expect(mockRefreshServerHierarchicalMemory).toHaveBeenCalledOnce();
                expect(mockHookSystemInit).toHaveBeenCalledOnce();
                expect(mockAgentRegistryReload).toHaveBeenCalledOnce();
                expect(mockSkillsReload).toHaveBeenCalledOnce();
            });
        });
    });
    describe('restartExtension', () => {
        it('should stop and then start the extension', async () => {
            const loader = new TestingSimpleExtensionLoader([activeExtension]);
            vi.spyOn(loader, 'stopExtension');
            vi.spyOn(loader, 'startExtension');
            await loader.start(mockConfig);
            await loader.restartExtension(activeExtension);
            expect(loader.stopExtension).toHaveBeenCalledWith(activeExtension);
            expect(loader.startExtension).toHaveBeenCalledWith(activeExtension);
            expect(mockSkillsReload).toHaveBeenCalledTimes(2);
        });
    });
});
// Adding these overrides allows us to access the protected members.
class TestingSimpleExtensionLoader extends SimpleExtensionLoader {
    async startExtension(extension) {
        await super.startExtension(extension);
    }
    async stopExtension(extension) {
        await super.stopExtension(extension);
    }
}
//# sourceMappingURL=extensionLoader.test.js.map