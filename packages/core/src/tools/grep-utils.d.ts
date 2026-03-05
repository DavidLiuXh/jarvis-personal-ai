/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Result object for a single grep match
 */
export interface GrepMatch {
    filePath: string;
    absolutePath: string;
    lineNumber: number;
    line: string;
    isContext?: boolean;
}
/**
 * Groups matches by their file path and ensures they are sorted by line number.
 */
export declare function groupMatchesByFile(allMatches: GrepMatch[]): Record<string, GrepMatch[]>;
/**
 * Reads the content of a file and splits it into lines.
 * Returns null if the file cannot be read.
 */
export declare function readFileLines(absolutePath: string): Promise<string[] | null>;
/**
 * Automatically enriches grep results with surrounding context if the match count is low
 * and no specific context was requested. This optimization can enable the agent
 * to skip turns that would be spent reading files after grep calls.
 */
export declare function enrichWithAutoContext(matchesByFile: Record<string, GrepMatch[]>, matchCount: number, params: {
    names_only?: boolean;
    context?: number;
    before?: number;
    after?: number;
}): Promise<void>;
/**
 * Formats the grep results for the LLM, including optional context.
 */
export declare function formatGrepResults(allMatches: GrepMatch[], params: {
    pattern: string;
    names_only?: boolean;
    include_pattern?: string;
    context?: number;
    before?: number;
    after?: number;
}, searchLocationDescription: string, totalMaxMatches: number): Promise<{
    llmContent: string;
    returnDisplay: string;
}>;
