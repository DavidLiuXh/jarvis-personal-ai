/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export type WorkspaceToolRequest = {
  name: string;
  args: Record<string, unknown>;
  callId: string;
};

export type WorkspaceToolResult = {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
};

type WorkspaceToolOptions = {
  root: string;
  readOnlyRoots?: string[];
  maxReadBytes?: number;
  maxReadLines?: number;
  maxSearchResults?: number;
  shellTimeoutMs?: number;
  shellMaxOutputChars?: number;
  allowNetworkFetchCommands?: boolean;
  networkFetchCommands?: string[];
};

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });
const DEFAULT_MAX_READ_BYTES = 1_000_000;
const DEFAULT_MAX_READ_LINES = 2_000;
const DEFAULT_MAX_SEARCH_RESULTS = 200;
const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
const DEFAULT_SHELL_MAX_OUTPUT_CHARS = 40_000;
const DEFAULT_ALLOW_NETWORK_FETCH_COMMANDS = true;
const DEFAULT_NETWORK_FETCH_COMMANDS = ["curl", "wget"];

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") return [value];
  return [];
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeSlash(value: string): string {
  return value.split(path.sep).join("/");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeSlash(pattern).replace(/^\.\//, "");
  let source = "";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const next = normalized[i + 1];
    const afterNext = normalized[i + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      i += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function truncateText(
  text: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function isDangerousShellCommand(command: string): boolean {
  const normalized = command
    .trim()
    .toLowerCase()
    .replace(/(?:^|\s)(?:\d?>|&>)\s*\/dev\/null\b/g, " ");
  return [
    /\brm\s+(-[^\s]*r[^\s]*|-rf|-[^\s]*f[^\s]*r)\b/,
    /\bsudo\b/,
    /\bchmod\s+(-r\s+)?777\b/,
    /\bchown\b/,
    /\bdd\s+if=/,
    /\bmkfs\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\blaunchctl\b/,
    /\bcrontab\b/,
    />\s*\/dev\//,
  ].some((re) => re.test(normalized));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsNetworkFetchCommand(
  command: string,
  networkFetchCommands: string[],
): boolean {
  const names = networkFetchCommands
    .map((item) => item.trim())
    .filter(Boolean)
    .map(escapeRegExp);
  if (names.length === 0) return false;
  const re = new RegExp(`(^|[\\s;&|()])(?:${names.join("|")})(?=\\s|$)`, "i");
  return re.test(command);
}

export class WorkspaceTools {
  private readonly root: string;
  private readonly readOnlyRoots: string[];
  private readonly maxReadBytes: number;
  private readonly maxReadLines: number;
  private readonly maxSearchResults: number;
  private readonly shellTimeoutMs: number;
  private readonly shellMaxOutputChars: number;
  private readonly allowNetworkFetchCommands: boolean;
  private readonly networkFetchCommands: string[];

  constructor(options: WorkspaceToolOptions) {
    this.root = path.resolve(options.root);
    this.readOnlyRoots = (options.readOnlyRoots ?? []).map((item) =>
      path.resolve(item),
    );
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxReadLines = options.maxReadLines ?? DEFAULT_MAX_READ_LINES;
    this.maxSearchResults =
      options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
    this.shellTimeoutMs = options.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
    this.shellMaxOutputChars =
      options.shellMaxOutputChars ?? DEFAULT_SHELL_MAX_OUTPUT_CHARS;
    this.allowNetworkFetchCommands =
      options.allowNetworkFetchCommands ?? DEFAULT_ALLOW_NETWORK_FETCH_COMMANDS;
    this.networkFetchCommands =
      options.networkFetchCommands ?? DEFAULT_NETWORK_FETCH_COMMANDS;
  }

  canHandle(name: string): boolean {
    return (
      name === "read_file" ||
      name === "write_file" ||
      name === "read_many_files" ||
      name === "glob" ||
      name === "grep" ||
      name === "run_shell_command"
    );
  }

  async execute(request: WorkspaceToolRequest): Promise<WorkspaceToolResult> {
    try {
      if (request.name === "read_file") return await this.readFile(request);
      if (request.name === "write_file") return await this.writeFile(request);
      if (request.name === "read_many_files") {
        return await this.readManyFiles(request);
      }
      if (request.name === "glob") return await this.glob(request);
      if (request.name === "grep") return await this.grep(request);
      if (request.name === "run_shell_command") {
        return await this.runShellCommand(request);
      }
      return { ok: false, tool: request.name, error: "Unsupported tool." };
    } catch (error) {
      return {
        ok: false,
        tool: request.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveWorkspacePath(input: string): string {
    const raw = input.trim();
    if (!raw) throw new Error("Path is required.");
    const resolved = path.resolve(this.root, raw);
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes workspace root: ${input}`);
    }
    return resolved;
  }

  private resolveReadablePath(input: string): {
    path: string;
    displayRoot: string;
  } {
    const raw = input.trim();
    if (!raw) throw new Error("Path is required.");
    const candidates = path.isAbsolute(raw)
      ? [
          { root: this.root, resolved: path.resolve(raw) },
          ...this.readOnlyRoots.map((root) => ({
            root,
            resolved: path.resolve(raw),
          })),
        ]
      : [
          { root: this.root, resolved: path.resolve(this.root, raw) },
          ...this.readOnlyRoots.map((root) => ({
            root,
            resolved: path.resolve(root, raw),
          })),
        ];
    for (const candidate of candidates) {
      const relative = path.relative(candidate.root, candidate.resolved);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        return { path: candidate.resolved, displayRoot: candidate.root };
      }
    }
    throw new Error(`Path escapes workspace root/readOnlyRoots: ${input}`);
  }

  private assertReadablePath(filePath: string): void {
    const base = path.basename(filePath);
    if (SENSITIVE_BASENAMES.has(base)) {
      throw new Error(`Refusing to read sensitive file: ${base}`);
    }
  }

  private async readFile(
    request: WorkspaceToolRequest,
  ): Promise<WorkspaceToolResult> {
    const readable = this.resolveReadablePath(
      asString(request.args.file_path || request.args.path),
    );
    const filePath = readable.path;
    this.assertReadablePath(filePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Path is not a file.");
    if (stat.size > this.maxReadBytes) {
      throw new Error(
        `File is too large (${stat.size} bytes). Limit is ${this.maxReadBytes} bytes.`,
      );
    }
    const startLine = Math.max(1, asNumber(request.args.start_line, 1));
    const endLineRaw = asNumber(request.args.end_line, 0);
    const content = TEXT_DECODER.decode(await fs.readFile(filePath));
    const lines = content.split(/\r?\n/);
    const endLine =
      endLineRaw > 0 ? Math.min(endLineRaw, lines.length) : lines.length;
    const selected = lines.slice(startLine - 1, endLine);
    const truncatedByLines = selected.length > this.maxReadLines;
    const finalLines = truncatedByLines
      ? selected.slice(0, this.maxReadLines)
      : selected;
    return {
      ok: true,
      tool: request.name,
      result: {
        path: path.relative(readable.displayRoot, filePath),
        start_line: startLine,
        end_line: startLine + finalLines.length - 1,
        total_lines: lines.length,
        truncated: truncatedByLines,
        content: finalLines.join("\n"),
      },
    };
  }

  private async writeFile(
    request: WorkspaceToolRequest,
  ): Promise<WorkspaceToolResult> {
    const filePath = this.resolveWorkspacePath(
      asString(request.args.file_path || request.args.path),
    );
    const content = asString(request.args.content);
    const mode = asString(request.args.mode, "overwrite");
    if (!["overwrite", "append", "create"].includes(mode)) {
      throw new Error('mode must be "overwrite", "append", or "create".');
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (mode === "create") {
      await fs.writeFile(filePath, content, { flag: "wx" });
    } else if (mode === "append") {
      await fs.appendFile(filePath, content);
    } else {
      await fs.writeFile(filePath, content);
    }
    const stat = await fs.stat(filePath);
    return {
      ok: true,
      tool: request.name,
      result: {
        path: path.relative(this.root, filePath),
        mode,
        bytes: stat.size,
      },
    };
  }

  private async readManyFiles(
    request: WorkspaceToolRequest,
  ): Promise<WorkspaceToolResult> {
    const paths = asStringArray(request.args.paths || request.args.file_paths);
    if (paths.length === 0) throw new Error("paths is required.");
    const include = asString(request.args.include || request.args.file_pattern);
    const includeRe = include ? globToRegExp(include) : null;
    const recursive = asBoolean(request.args.recursive, true);
    const results = [];
    for (const item of paths.slice(0, 50)) {
      const readable = this.resolveReadablePath(item);
      const stat = await fs.stat(readable.path);
      if (stat.isDirectory()) {
        const files = recursive
          ? this.walk(readable.path)
          : this.walkShallow(readable.path);
        for await (const filePath of files) {
          const fileStat = await fs.stat(filePath);
          if (!fileStat.isFile()) continue;
          const relative = normalizeSlash(
            path.relative(readable.path, filePath),
          );
          if (includeRe && !includeRe.test(relative)) continue;
          const response = await this.readFile({
            ...request,
            name: "read_file",
            args: { ...request.args, file_path: filePath },
          });
          results.push(response);
          if (results.length >= 50) break;
        }
      } else {
        const response = await this.readFile({
          ...request,
          name: "read_file",
          args: { ...request.args, file_path: item },
        });
        results.push(response);
      }
      if (results.length >= 50) break;
    }
    return { ok: true, tool: request.name, result: { files: results } };
  }

  private async glob(
    request: WorkspaceToolRequest,
  ): Promise<WorkspaceToolResult> {
    const pattern = asString(request.args.pattern || request.args.glob);
    if (!pattern) throw new Error("pattern is required.");
    const pathArg = asString(request.args.path, ".");
    const readableRoot = this.resolveReadablePath(pathArg);
    const matches = [];
    const re = globToRegExp(pattern);
    for await (const filePath of this.walk(readableRoot.path)) {
      const relative = normalizeSlash(
        path.relative(readableRoot.displayRoot, filePath),
      );
      if (re.test(relative)) {
        matches.push(relative);
        if (matches.length >= this.maxSearchResults) break;
      }
    }
    return {
      ok: true,
      tool: request.name,
      result: {
        pattern,
        matches,
        truncated: matches.length >= this.maxSearchResults,
      },
    };
  }

  private async grep(
    request: WorkspaceToolRequest,
  ): Promise<WorkspaceToolResult> {
    const pattern = asString(request.args.pattern || request.args.query);
    if (!pattern) throw new Error("pattern is required.");
    const include = asString(request.args.include || request.args.file_pattern);
    const pathArg = asString(request.args.path, ".");
    const readableRoot = this.resolveReadablePath(pathArg);
    const root = readableRoot.path;
    const flags = request.args.ignore_case === false ? "g" : "gi";
    const re = new RegExp(pattern, flags);
    const includeRe = include ? globToRegExp(include) : null;
    const matches = [];
    for await (const filePath of this.walk(root)) {
      const relative = normalizeSlash(
        path.relative(readableRoot.displayRoot, filePath),
      );
      if (includeRe && !includeRe.test(relative)) continue;
      this.assertReadablePath(filePath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > this.maxReadBytes) continue;
      const lines = TEXT_DECODER.decode(await fs.readFile(filePath)).split(
        /\r?\n/,
      );
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          matches.push({
            path: relative,
            line: i + 1,
            text: truncateText(lines[i], 500).text,
          });
          if (matches.length >= this.maxSearchResults) {
            return {
              ok: true,
              tool: request.name,
              result: { pattern, matches, truncated: true },
            };
          }
        }
      }
    }
    return {
      ok: true,
      tool: request.name,
      result: { pattern, matches, truncated: false },
    };
  }

  private async runShellCommand(
    request: WorkspaceToolRequest,
  ): Promise<WorkspaceToolResult> {
    const command = asString(request.args.command);
    if (!command) throw new Error("command is required.");
    if (
      !this.allowNetworkFetchCommands &&
      containsNetworkFetchCommand(command, this.networkFetchCommands)
    ) {
      throw new Error(
        `Command blocked by Jarvis workspace policy: network fetch commands require security.shell.allowNetworkFetchCommands=true`,
      );
    }
    if (isDangerousShellCommand(command)) {
      throw new Error(`Command blocked by Jarvis workspace policy: ${command}`);
    }
    const cwd = request.args.cwd
      ? this.resolveWorkspacePath(asString(request.args.cwd))
      : this.root;
    const timeoutMs = Math.min(
      asNumber(request.args.timeout_ms, this.shellTimeoutMs),
      this.shellTimeoutMs,
    );
    const result = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.length > this.shellMaxOutputChars) {
          stdout = stdout.slice(0, this.shellMaxOutputChars);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.length > this.shellMaxOutputChars) {
          stderr = stderr.slice(0, this.shellMaxOutputChars);
        }
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout, stderr: error.message, timedOut });
      });
    });
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      tool: request.name,
      result: {
        command,
        cwd: path.relative(this.root, cwd) || ".",
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  }

  private async *walk(root: string): AsyncGenerator<string> {
    const stat = await fs.stat(root);
    if (stat.isFile()) {
      yield root;
      return;
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }

  private async *walkShallow(root: string): AsyncGenerator<string> {
    const stat = await fs.stat(root);
    if (stat.isFile()) {
      yield root;
      return;
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isFile()) continue;
      yield path.join(root, entry.name);
    }
  }
}
