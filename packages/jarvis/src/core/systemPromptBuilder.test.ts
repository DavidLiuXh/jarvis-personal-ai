/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder, type FactRecord } from './systemPromptBuilder.js';

describe('SystemPromptBuilder', () => {
  // --- framework structure ---

  it('always includes the JARVIS OPERATIONAL FRAMEWORK v4.0 header', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);
    expect(prompt).toContain('JARVIS OPERATIONAL FRAMEWORK v4.0');
  });

  it('always includes TOOL_USE_ATOMICITY protocol', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);
    expect(prompt).toContain('TOOL_USE_ATOMICITY');
  });

  it('always includes CODE_MODIFICATION_PROTOCOL', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);
    expect(prompt).toContain('CODE_MODIFICATION_PROTOCOL');
  });

  it('always includes PUSH_TO_CHANNEL protocol', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);
    expect(prompt).toContain('PUSH_TO_CHANNEL');
    expect(prompt).toContain('push_to_channel');
    expect(prompt).toContain('发到微信');
  });

  it('always includes TASK_MANAGEMENT protocol with function-call vs shell distinction', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);
    expect(prompt).toContain('TASK_MANAGEMENT');
    expect(prompt).toContain('FORBIDDEN');
    expect(prompt).toContain('crontab');
    expect(prompt).toContain('每天');
    expect(prompt).toContain('BAD');
    expect(prompt).toContain('GOOD');
    expect(prompt).toContain('run_shell_command("task_list")');
    expect(prompt).toContain('FUNCTION CALL TOOLS');
  });

  it('always includes recall_memory instruction', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);
    expect(prompt).toContain('recall_memory');
  });

  // --- persistent context ---

  it('renders facts inside <persistent_context> XML tags', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is a software engineer' },
    ];
    const prompt = builder.buildFromFacts(facts);
    expect(prompt).toContain('<persistent_context>');
    expect(prompt).toContain('</persistent_context>');
    expect(prompt).toContain('user is a software engineer');
  });

  it('renders facts with [CATEGORY] uppercase labels', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is David' },
      { category: 'behavior', content: 'user runs 3 times a week' },
      { category: 'specification', content: 'project uses TypeScript' },
    ];
    const prompt = builder.buildFromFacts(facts);
    expect(prompt).toContain('[IDENTITY]');
    expect(prompt).toContain('[BEHAVIOR]');
    expect(prompt).toContain('[SPECIFICATION]');
  });

  it('shows empty state message when no facts exist', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.buildFromFacts([]);
    expect(prompt).toContain('No persistent facts');
  });

  // --- style constraints ---

  it('renders style inside <style_constraints> XML tags', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'preference', content: 'prefers table format for data' },
    ];
    const prompt = builder.buildFromFacts(facts);
    expect(prompt).toContain('<style_constraints>');
    expect(prompt).toContain('</style_constraints>');
    expect(prompt).toContain('prefers table format for data');
  });

  it('marks derived style as [DEFAULT] and preference as [USER_PREFERENCE]', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is adept at engineering and coding' },
      { category: 'preference', content: 'please explain in plain language' },
    ];
    const prompt = builder.buildFromFacts(facts);
    expect(prompt).toContain('[DEFAULT]');
    expect(prompt).toContain('[USER_PREFERENCE]');
    expect(prompt).toContain('please explain in plain language');
  });

  it('derives [DEFAULT] style from technical identity when no preference exists', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: 'user is adept at engineering and coding' },
    ];
    const prompt = builder.buildFromFacts(facts);
    expect(prompt).toContain('[DEFAULT]');
    expect(prompt.toLowerCase()).toMatch(/technical|engineer|coding/);
  });

  it('does not render style_constraints when no preference and no technical identity', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'identity', content: "user's name is David" },
    ];
    const prompt = builder.buildFromFacts(facts);
    expect(prompt).not.toContain('<style_constraints>');
  });

  it('behavior facts go to persistent_context, not style_constraints', () => {
    const builder = new SystemPromptBuilder();
    const facts: FactRecord[] = [
      { category: 'behavior', content: 'user runs 3 times a week' },
    ];
    const prompt = builder.buildFromFacts(facts);
    expect(prompt).toContain('<persistent_context>');
    expect(prompt).toContain('user runs 3 times a week');
    expect(prompt).not.toContain('<style_constraints>');
  });

  // --- memory_status ---

  it('renders memory_status with HALLUCINATE warning', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.buildFromFacts([]);
    expect(prompt).toContain('<memory_status>');
    expect(prompt.toUpperCase()).toContain('HALLUCINATE');
  });

  // --- legacy build() ---

  it('build() with string array still produces a valid prompt with framework', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build(['[identity] name is Jarvis', '[spec] runs on macOS']);
    expect(prompt).toContain('JARVIS OPERATIONAL FRAMEWORK v4.0');
    expect(prompt).toContain('[identity] name is Jarvis');
    expect(prompt).toContain('[spec] runs on macOS');
  });

  it('build() with empty array still includes framework and empty state', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build([]);
    expect(prompt).toContain('JARVIS OPERATIONAL FRAMEWORK v4.0');
    expect(prompt).toContain('No persistent facts');
  });
});

describe('SystemPromptBuilder protocol numbering', () => {
  it('protocol numbers are unique — no duplicate numbering', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.buildFromFacts([], '');
    // Extract all "N. **PROTOCOL_NAME**" patterns
    const numbered = [...prompt.matchAll(/^(\d+)\.\s+\*\*/gm)].map(m => m[1]);
    const unique = new Set(numbered);
    expect(numbered.length).toBe(unique.size);
  });
});

describe('SystemPromptBuilder on-demand protocol injection', () => {
  it('injects PUSH_TO_CHANNEL only when prompt mentions push/微信/飞书', () => {
    const builder = new SystemPromptBuilder();

    const withPush = builder.buildFromFacts([], '发到微信');
    expect(withPush).toContain('PUSH_TO_CHANNEL');

    const withoutPush = builder.buildFromFacts([], '帮我分析代码');
    expect(withoutPush).not.toContain('PUSH_TO_CHANNEL');
  });

  it('injects TASK_MANAGEMENT only when prompt mentions scheduling/任务', () => {
    const builder = new SystemPromptBuilder();

    const withTask = builder.buildFromFacts([], '每天早上8点做X');
    expect(withTask).toContain('TASK_MANAGEMENT');

    const withoutTask = builder.buildFromFacts([], '帮我分析代码');
    expect(withoutTask).not.toContain('TASK_MANAGEMENT');
  });

  it('injects CODE_MODIFICATION_PROTOCOL only when prompt mentions code/file editing', () => {
    const builder = new SystemPromptBuilder();

    const withCode = builder.buildFromFacts([], '帮我修改这个文件');
    expect(withCode).toContain('CODE_MODIFICATION_PROTOCOL');

    const withoutCode = builder.buildFromFacts([], '今天天气怎么样');
    expect(withoutCode).not.toContain('CODE_MODIFICATION_PROTOCOL');
  });

  it('always injects TOOL_USE_ATOMICITY, TASK_DECOMPOSITION, ACTIVE_RECALL', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.buildFromFacts([], '随便说点什么');
    expect(prompt).toContain('TOOL_USE_ATOMICITY');
    expect(prompt).toContain('TASK_DECOMPOSITION');
    expect(prompt).toContain('ACTIVE_RECALL');
  });

  it('buildFromFacts with no userPrompt includes all protocols (safe default)', () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.buildFromFacts([]);
    expect(prompt).toContain('PUSH_TO_CHANNEL');
    expect(prompt).toContain('TASK_MANAGEMENT');
    expect(prompt).toContain('CODE_MODIFICATION_PROTOCOL');
  });
});
