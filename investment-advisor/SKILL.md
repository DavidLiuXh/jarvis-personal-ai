---
name: investment-advisor
description: 长期稳健投资分析与策略系统。用于分析美股/港股标的，结合财报深度分析、估值模型、风险压力测试，输出结构化的建仓与调仓执行指令。
---

# 投资顾问 (Investment Advisor)

本 Skill 提供系统化的长期稳健投资分析工作流。

## 工作流说明

当你被触发时，请按照以下步骤执行：

1. **信息收集**：调用 `google_web_search` 或 `web_fetch` 获取标的最新财报、经营数据及机构分析。
2. **深度解析**：加载 `references/analysis-framework.md` 对标的进行多维度深度拆解。
3. **策略合成**：加载 `references/strategy-matrix.md`，根据用户的长期稳健偏好，制定阶梯建仓与调仓计划。
4. **风险压力测试**：加载 `references/evaluation-criteria.md` 对方案进行压力测试。
5. **输出结果**：提供结构化的投资建议，确保内容适合在移动端（如微信）快速阅读。

## 关键指令

- 使用 `analysis-framework.md` 作为分析标的资产的核心框架。
- 始终以“长期价值投资”为基准，忽略短期市场噪音。
- 输出内容必须包含：核心逻辑、执行计划、风险控制及对标分析表。
