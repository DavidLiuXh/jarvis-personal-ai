/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder } from './systemPromptBuilder.js';

describe('SystemPromptBuilder', () => {
  it('includes core facts in the prompt when facts exist', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build(['[identity] name is Jarvis', '[spec] runs on macOS']);

    expect(prompt).toContain('[identity] name is Jarvis');
    expect(prompt).toContain('[spec] runs on macOS');
  });

  it('shows empty state message when no facts exist', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);

    expect(prompt).toContain('No persistent facts stored');
  });

  it('always includes the recall_memory instruction', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);

    expect(prompt).toContain('recall_memory');
  });

  it('always includes the JARVIS SYSTEM OPERATIONAL FRAMEWORK header', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);

    expect(prompt).toContain('JARVIS SYSTEM OPERATIONAL FRAMEWORK');
  });
});
