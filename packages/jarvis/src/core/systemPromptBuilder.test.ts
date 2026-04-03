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

  it('renders preference facts in Style Instructions, behavior facts in Persistent Context', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is a software engineer' },
      { category: 'preference', content: 'prefers table format for data' },
      { category: 'behavior', content: 'user runs 3 times a week' },
      { category: 'specification', content: 'project uses TypeScript' },
    ];
    const prompt = builder.buildFromFacts(facts);

    expect(prompt).toContain('STYLE INSTRUCTIONS');
    expect(prompt).toContain('prefers table format for data');
    // behavior goes to PERSISTENT CONTEXT, not STYLE INSTRUCTIONS
    expect(prompt).toContain('PERSISTENT CONTEXT');
    expect(prompt).toContain('user runs 3 times a week');
  });

  it('does not render Style Instructions section when no preference, behavior, or technical identity exists', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: "user's name is David" },
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

  it('derives default style from identity facts when no preference exists', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is adept at engineering and coding' },
    ];
    const prompt = builder.buildFromFacts(facts);

    expect(prompt).toContain('STYLE INSTRUCTIONS');
    // Must include derived style hint based on engineering identity
    expect(prompt.toLowerCase()).toMatch(/technical|engineer|coding|professional/);
    // Must label it as default/inferred
    expect(prompt.toLowerCase()).toMatch(/default|inferred|profile/);
  });

  it('preference overrides identity-derived default style', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is adept at engineering and coding' },
      { category: 'preference', content: 'please explain in plain language, avoid jargon' },
    ];
    const prompt = builder.buildFromFacts(facts);

    // Both sections must be present
    expect(prompt).toContain('STYLE INSTRUCTIONS');
    expect(prompt).toContain('plain language');
    // Preference must be marked as higher priority / override
    expect(prompt.toLowerCase()).toMatch(/override|explicit|preference|priority/);
  });

  it('does not derive style when identity has no skill/profession info', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: "user's name is David" },
    ];
    const prompt = builder.buildFromFacts(facts);

    // Name alone should not trigger style derivation
    expect(prompt).not.toContain('STYLE INSTRUCTIONS');
  });
});
