import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceTools } from "./workspaceTools.js";

describe("WorkspaceTools", () => {
  let root: string;
  let tools: WorkspaceTools;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "jarvis-workspace-tools-"));
    tools = new WorkspaceTools({ root, shellTimeoutMs: 5_000 });
    await writeFile(path.join(root, "a.txt"), "alpha\nbeta\ngamma\n");
    await writeFile(path.join(root, "b.ts"), "export const answer = 42;\n");
    await writeFile(path.join(root, ".env"), "SECRET=value\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads a targeted line range inside the workspace", async () => {
    const result = await tools.execute({
      name: "read_file",
      callId: "read-1",
      args: { file_path: "a.txt", start_line: 2, end_line: 2 },
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      path: "a.txt",
      start_line: 2,
      end_line: 2,
      content: "beta",
    });
  });

  it("blocks path traversal and sensitive reads", async () => {
    await expect(
      tools.execute({
        name: "read_file",
        callId: "read-escape",
        args: { file_path: "../outside.txt" },
      }),
    ).resolves.toMatchObject({ ok: false });

    await expect(
      tools.execute({
        name: "read_file",
        callId: "read-env",
        args: { file_path: ".env" },
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("writes files inside the workspace", async () => {
    const result = await tools.execute({
      name: "write_file",
      callId: "write-1",
      args: {
        file_path: "nested/out.md",
        content: "# Hello\n",
        mode: "create",
      },
    });

    expect(result.ok).toBe(true);
    await expect(
      readFile(path.join(root, "nested/out.md"), "utf8"),
    ).resolves.toBe("# Hello\n");
  });

  it("finds files with glob and text with grep", async () => {
    await expect(
      tools.execute({
        name: "glob",
        callId: "glob-1",
        args: { pattern: "**/*.ts" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { matches: ["b.ts"] },
    });

    const grep = await tools.execute({
      name: "grep",
      callId: "grep-1",
      args: { pattern: "answer", include: "**/*.ts" },
    });

    expect(grep.ok).toBe(true);
    expect(JSON.stringify(grep.result)).toContain("b.ts");
    expect(JSON.stringify(grep.result)).toContain("answer");
  });

  it("runs safe shell commands and blocks dangerous commands", async () => {
    const safe = await tools.execute({
      name: "run_shell_command",
      callId: "shell-1",
      args: { command: "printf ok" },
    });

    expect(safe).toMatchObject({
      ok: true,
      result: { exit_code: 0, stdout: "ok" },
    });

    const blocked = await tools.execute({
      name: "run_shell_command",
      callId: "shell-2",
      args: { command: "rm -rf ." },
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("blocked");
  });

  it("blocks network fetch shell commands unless explicitly enabled", async () => {
    const fetchDisabledTools = new WorkspaceTools({
      root,
      shellTimeoutMs: 5_000,
      allowNetworkFetchCommands: false,
    });
    const blocked = await fetchDisabledTools.execute({
      name: "run_shell_command",
      callId: "shell-fetch-blocked",
      args: { command: "curl --version" },
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("allowNetworkFetchCommands=true");

    const fetchEnabledTools = new WorkspaceTools({
      root,
      shellTimeoutMs: 5_000,
      allowNetworkFetchCommands: true,
      networkFetchCommands: ["printf"],
    });
    const allowed = await fetchEnabledTools.execute({
      name: "run_shell_command",
      callId: "shell-fetch-allowed",
      args: { command: "printf ok" },
    });

    expect(allowed).toMatchObject({
      ok: true,
      result: { exit_code: 0, stdout: "ok" },
    });
  });

  it("allows configured network fetch pipelines and stderr discard", async () => {
    const allowed = await tools.execute({
      name: "run_shell_command",
      callId: "shell-fetch-pipeline",
      args: { command: "curl --version 2>/dev/null | head -c 4" },
    });

    expect(allowed).toMatchObject({
      ok: true,
      result: { exit_code: 0, stdout: "curl" },
    });
  });

  it("allows reads from configured read-only roots but blocks writes there", async () => {
    const readOnlyRoot = await mkdtemp(
      path.join(os.tmpdir(), "jarvis-readonly-root-"),
    );
    try {
      await mkdir(path.join(readOnlyRoot, "reports"), { recursive: true });
      await writeFile(
        path.join(readOnlyRoot, "reports", "market.md"),
        "market notes\n",
      );
      await mkdir(path.join(readOnlyRoot, "reports", "nested"), {
        recursive: true,
      });
      await writeFile(
        path.join(readOnlyRoot, "reports", "nested", "deep.md"),
        "nested notes\n",
      );
      await writeFile(
        path.join(readOnlyRoot, "reports", "ignore.txt"),
        "ignore me\n",
      );
      const toolsWithReadOnlyRoot = new WorkspaceTools({
        root,
        readOnlyRoots: [readOnlyRoot],
      });

      const read = await toolsWithReadOnlyRoot.execute({
        name: "read_file",
        callId: "read-external",
        args: { file_path: path.join(readOnlyRoot, "reports", "market.md") },
      });
      const many = await toolsWithReadOnlyRoot.execute({
        name: "read_many_files",
        callId: "read-many-external",
        args: {
          paths: [path.join(readOnlyRoot, "reports")],
          include: "*.md",
          recursive: false,
        },
      });
      const glob = await toolsWithReadOnlyRoot.execute({
        name: "glob",
        callId: "glob-external",
        args: { path: path.join(readOnlyRoot, "reports"), pattern: "**/*.md" },
      });
      const write = await toolsWithReadOnlyRoot.execute({
        name: "write_file",
        callId: "write-external",
        args: {
          file_path: path.join(readOnlyRoot, "reports", "new.md"),
          content: "nope",
        },
      });

      expect(read).toMatchObject({
        ok: true,
        result: { path: "reports/market.md", content: "market notes\n" },
      });
      expect(JSON.stringify(many)).toContain("market notes");
      expect(JSON.stringify(many)).not.toContain("nested notes");
      expect(JSON.stringify(many)).not.toContain("ignore me");
      expect(glob).toMatchObject({
        ok: true,
        result: { matches: ["reports/market.md", "reports/nested/deep.md"] },
      });
      expect(write.ok).toBe(false);
      expect(write.error).toContain("Path escapes workspace root");
    } finally {
      await rm(readOnlyRoot, { recursive: true, force: true });
    }
  });
});
