import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function loadMarkdownNormalization(): {
  normalizeBareLatexOutsideFences: (markdown: string) => string;
} {
  const html = readFileSync(
    new URL("../../ui/index.html", import.meta.url),
    "utf8",
  );
  const start = html.indexOf("function normalizeBareLatexOutsideFences");
  const end = html.indexOf("function protectMathSegments");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(html.slice(start, end), sandbox);
  return sandbox as {
    normalizeBareLatexOutsideFences: (markdown: string) => string;
  };
}

describe("markdown display normalization", () => {
  it("wraps and repairs standalone bare LaTeX expressions", () => {
    const { normalizeBareLatexOutsideFences } = loadMarkdownNormalization();

    expect(
      normalizeBareLatexOutsideFences(String.raw`\hat{y}t = W{hy} h_t + b_y`),
    ).toBe(String.raw`\[\hat{y}_t = W_{hy} h_t + b_y\]`);
  });

  it("does not rewrite fenced code or already delimited math", () => {
    const { normalizeBareLatexOutsideFences } = loadMarkdownNormalization();
    const fenced = [
      "Here:",
      "```",
      String.raw`\hat{y}t = W{hy} h_t + b_y`,
      "```",
      String.raw`\(\hat{y}_t = W_{hy} h_t + b_y\)`,
    ].join("\n");

    expect(normalizeBareLatexOutsideFences(fenced)).toBe(fenced);
  });
});
