/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Flattens hierarchical memory into a single string for display or legacy use.
 */
export function flattenMemory(memory) {
    if (!memory)
        return '';
    if (typeof memory === 'string')
        return memory;
    const sections = [];
    if (memory.global?.trim()) {
        sections.push({ name: 'Global', content: memory.global.trim() });
    }
    if (memory.extension?.trim()) {
        sections.push({ name: 'Extension', content: memory.extension.trim() });
    }
    if (memory.project?.trim()) {
        sections.push({ name: 'Project', content: memory.project.trim() });
    }
    if (sections.length === 0)
        return '';
    return sections.map((s) => `--- ${s.name} ---\n${s.content}`).join('\n\n');
}
//# sourceMappingURL=memory.js.map