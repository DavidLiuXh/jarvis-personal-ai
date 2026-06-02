import { describe, expect, it } from "vitest";
import {
  extractSessionSearchTerms,
  scoreSessionSearchCandidates,
} from "./sessionStore.js";

describe("sessionStore helpers", () => {
  it("extracts discriminative Chinese terms for conversation recall", () => {
    expect(
      extractSessionSearchTerms("帮我汇总之前梓潼相关的探讨内容"),
    ).toContain("梓潼");
  });

  it("scores matching transcript candidates with recency tiebreak", () => {
    const results = scoreSessionSearchCandidates({
      query: "ONNX配置",
      candidates: [
        {
          sessionId: "old",
          text: "User: ONNX模型的配置步骤是什么？\nJarvis: 安装 onnx-manager。",
          timestamp: 1,
        },
        {
          sessionId: "new",
          text: "User: ONNX模型的配置步骤是什么？\nJarvis: 执行 pull 命令。",
          timestamp: 2,
        },
        {
          sessionId: "other",
          text: "User: 梓潼的文化意义是什么？",
          timestamp: 3,
        },
      ],
    });

    expect(results.map((result) => result.sessionId)).toEqual(["new", "old"]);
  });
});
