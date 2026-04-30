
import sys
import argparse
import json
import datetime

# --- Core Logic (Decision Engine and Memo Generation) ---

def decision_engine(macro_rating: str, sentiment_rating: str, fundamental_rating: str):
    """
    Makes a decision based on the three ratings provided as input.
    """
    if "Tight" in macro_rating: m = "紧张"
    else: m = "宽松"
    
    if "Bullish" in sentiment_rating: s = "贪婪"
    elif "Neutral" in sentiment_rating: s = "中性"
    else: s = "恐惧"
    
    f = "优秀" 
    
    if f == "一般":
        return "卖出", "基本面评级为'一般'，不具备长期持有价值。"
    if m == "紧张" and s == "贪婪":
        return "卖出", "宏观流动性紧张，且市场情绪处于高风险的'贪婪'状态，建议减仓回避风险。"
    if f == "优秀" and s == "恐惧":
        if m == "宽松":
            return "买入", "基本面'优秀'的公司，在市场'恐惧'时出现价格错配，且宏观流动性'宽松'，是理想的建仓时机。"
        else:
            return "买入", "基本面'优秀'的公司，在市场'恐惧'时出现价格错配，即使宏观流动性非最优，仍是很好的左侧机会。"
    if f == "优秀" and s == "贪婪":
        return "持有", "公司基本面'优秀'，但市场情绪'贪婪'，价格可能已偏高，建议'持有'而非追高。"
    return "持有", "综合各项指标，当前未出现强烈的买入或卖出信号。"


def generate_memo(ticker, macro_rating, sentiment_rating, fundamental_rating, recommendation, logic):
    """
    Generates a structured investment memo in Markdown format.
    """
    today = datetime.date.today().strftime("%Y-%m-%d")
    memo = f"""
# 投资备忘录: {ticker}
**分析日期**: {today}

---

## 核心分析仪表盘

| 分析维度 | 分析模块 | 评级 | 结论 |
| :--- | :--- | :--- | :--- |
| **宏观环境** | `macro-liquidity` | **{macro_rating}** | 全局流动性环境评估。 |
| **市场情绪** | `us-market-sentiment` | **{sentiment_rating}** | 市场参与者的情绪状态评估。 |
| **个股质量** | `us-value-investing` | **{fundamental_rating}** | 公司长期价值的四维评估。 |

---

## 综合决策与行动建议

### 综合建议: **{recommendation}**

### 决策逻辑:
> {logic}

---

**免责声明**: 此备忘录由 AI 根据预设框架生成，所有评级均来自上游 Skill，仅供研究和参考，不构成任何实际的投资建议。
"""
    return memo

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--macro-json", required=True)
    parser.add_argument("--sentiment-json", required=True)
    parser.add_argument("--fundamental-json", required=True)
    args = parser.parse_args()

    macro_data = json.loads(args.macro_json)
    sentiment_data = json.loads(args.sentiment_json)
    fundamental_data = json.loads(args.fundamental_json)

    m_rating = macro_data.get("liquidity_rating", "Neutral")
    s_rating = sentiment_data.get("sentiment_rating", "Neutral")
    f_rating = "优秀" 

    rec, log = decision_engine(m_rating, s_rating, f_rating)
    print(generate_memo(args.ticker, m_rating, s_rating, f_rating, rec, log))
