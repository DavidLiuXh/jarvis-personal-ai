/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PartUnion } from '@google/genai';
import type { FileSystemService } from '../services/fileSystemService.js';
import { ToolErrorType } from '../tools/tool-error.js';
export declare function readWasmBinaryFromDisk(specifier: string): Promise<Uint8Array>;
export declare function loadWasmBinary(dynamicImport: () => Promise<{
    default: Uint8Array;
}>, fallbackSpecifier: string): Promise<Uint8Array>;
export declare const DEFAULT_ENCODING: BufferEncoding;
type UnicodeEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be';
interface BOMInfo {
    encoding: UnicodeEncoding;
    bomLength: number;
}
/**
 * Detect a Unicode BOM (Byte Order Mark) if present.
 * Reads up to the first 4 bytes and returns encoding + BOM length, else null.
 */
export declare function detectBOM(buf: Buffer): BOMInfo | null;
/**
 * Read a file as text, honoring BOM encodings (UTF‑8/16/32) and stripping the BOM.
 * Falls back to utf8 when no BOM is present.
 */
export declare function readFileWithEncoding(filePath: string): Promise<string>;
/**
 * Looks up the specific MIME type for a file path.
 * @param filePath Path to the file.
 * @returns The specific MIME type string (e.g., 'text/python', 'application/javascript') or undefined if not found or ambiguous.
 */
export declare function getSpecificMimeType(filePath: string): string | undefined;
/**
 * Checks if a path is within a given root directory.
 * @param pathToCheck The absolute path to check.
 * @param rootDirectory The absolute root directory.
 * @returns True if the path is within the root directory, false otherwise.
 */
export declare function isWithinRoot(pathToCheck: string, rootDirectory: string): boolean;
/**
 * Safely resolves a path to its real path if it exists, otherwise returns the absolute resolved path.
 */
export declare function getRealPath(filePath: string): string;
/**
 * Checks if a file's content is empty or contains only whitespace.
 * Efficiently checks file size first, and only samples the beginning of the file.
 * Honors Unicode BOM encodings.
 */
export declare function isEmpty(filePath: string): Promise<boolean>;
/**
 * Heuristic: determine if a file is likely binary.
 * Now BOM-aware: if a Unicode BOM is detected, we treat it as text.
 * For non-BOM files, retain the existing null-byte and non-printable ratio checks.
 */
export declare function isBinaryFile(filePath: string): Promise<boolean>;
/**
 * Detects the type of file based on extension and content.
 * @param filePath Path to the file.
 * @returns Promise that resolves to 'text', 'image', 'pdf', 'audio', 'video', 'binary' or 'svg'.
 */
export declare function detectFileType(filePath: string): Promise<'text' | 'image' | 'pdf' | 'audio' | 'video' | 'binary' | 'svg'>;
export interface ProcessedFileReadResult {
    llmContent: PartUnion;
    returnDisplay: string;
    error?: string;
    errorType?: ToolErrorType;
    isTruncated?: boolean;
    originalLineCount?: number;
    linesShown?: [number, number];
}
/**
 * Reads and processes a single file, handling text, images, and PDFs.
 * @param filePath Absolute path to the file.
 * @param rootDirectory Absolute path to the project root for relative path display.
 * @param _fileSystemService Currently unused in this function; kept for signature stability.
 * @param startLine Optional 1-based line number to start reading from.
 * @param endLine Optional 1-based line number to end reading at (inclusive).
 * @returns ProcessedFileReadResult object.
 */
export declare function processSingleFileContent(filePath: string, rootDirectory: string, _fileSystemService: FileSystemService, startLine?: number, endLine?: number): Promise<ProcessedFileReadResult>;
export declare function fileExists(filePath: string): Promise<boolean>;
/**
 * Sanitizes a string for use as a filename part by removing path traversal
 * characters and other non-alphanumeric characters.
 */
export declare function sanitizeFilenamePart(part: string): string;
/**
 * Formats a truncated message for tool output.
 * Shows the first 20% and last 80% of the allowed characters with a marker in between.
 */
export declare function formatTruncatedToolOutput(contentStr: string, outputFile: string, maxChars: number): string;
/**
 * Saves tool output to a temporary file for later retrieval.
 */
export declare const TOOL_OUTPUTS_DIR = "tool-outputs";
export declare function saveTruncatedToolOutput(content: string, toolName: string, id: string | number, // Accept string (callId) or number (truncationId)
projectTempDir: string, sessionId?: string): Promise<{
    outputFile: string;
}>;
export {};
