/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder, type FactRecord } from './systemPromptBuilder.js';

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

  it('renders preference and behavior facts as Style Instructions section', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is a software engineer' },
      { category: 'preference', content: 'prefers table format for data' },
      { category: 'behavior', content: 'always asks for background before details' },
      { category: 'specification', content: 'project uses TypeScript' },
    ];
    const prompt = builder.buildFromFacts(facts);

    expect(prompt).toContain('STYLE INSTRUCTIONS');
    expect(prompt).toContain('prefers table format for data');
    expect(prompt).toContain('always asks for background before details');
  });

  it('does not render Style Instructions section when no preference or behavior facts exist', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is a software engineer' },
      { category: 'specification', content: 'project uses TypeScript' },
    ];
    const prompt = builder.buildFromFacts(facts);

    expect(prompt).not.toContain('STYLE INSTRUCTIONS');
  });

  it('identity and specification facts still appear in persistent context section', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is a software engineer' },
      { category: 'preference', content: 'prefers concise answers' },
    ];
    const prompt = builder.buildFromFacts(facts);

    expect(prompt).toContain('user is a software engineer');
    expect(prompt).toContain('PERSISTENT CONTEXT');
  });
});
