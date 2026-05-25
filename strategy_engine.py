# file_path: strategy_engine.py

from market_sentiment import get_market_sentiment_score
from get_market_data import adaptive_fetch_data, get_watchlist
from get_macro_liquidity import analyze_macro_liquidity # 导入宏观流动性分析函数
import sys

def generate_signal(stock_df, sentiment_score, macro_strategy_tone):
    """
    Generates a detailed trading signal for a single stock, including a
    suggested price point and reasoning, based on technical indicators and
    overall market sentiment, and adjusted by the macro strategy tone.
    """
    # Extract latest technical indicator values
    latest_data = stock_df.iloc[-1]
    latest_rsi = latest_data['RSI']
    latest_close = latest_data['close']
    stock_code = latest_data['code']
    bb_lower = latest_data['BB_Lower']
    bb_upper = latest_data['BB_Upper']
    support = latest_data['Support']
    resistance = latest_data['Resistance']

    # Initialize default response
    analysis = {
        "signal": "持有/观望",
        "price_point": None,
        "reason": "当前技术指标和市场情绪未形成明确的买入或卖出信号。"
    }

    # --- Rule Matrix for Generating Buy/Sell Points and Reasons (Pre-Macro Adjustment) ---

    # A. Market is Fearful or Extremely Fearful (sentiment_score <= -1)
    # Strategy: Look for buying opportunities in oversold stocks
    if sentiment_score <= -1:
        if latest_rsi < 30: # Stock is oversold
            buy_price = min(bb_lower, support) # Suggested buy price is the lower of BB_Lower or recent support
            analysis["signal"] = "强力买入"
            analysis["price_point"] = f"{buy_price:.2f}"
            analysis["reason"] = f"市场情绪为恐惧，且个股 RSI ({latest_rsi:.2f}) 进入超卖区。建议在近期支撑位或布林带下轨附近 ({buy_price:.2f}) 买入。"
        elif latest_rsi > 70: # Stock is overbought, but market is fearful
            analysis["signal"] = "持有 / 减仓"
            analysis["reason"] = f"市场情绪为恐惧，但个股 RSI ({latest_rsi:.2f}) 处于超买区，信号冲突，建议观望或减仓。"

    # B. Market is Neutral (sentiment_score == 0)
    # Strategy: Standard technical signals
    elif sentiment_score == 0:
        if latest_rsi < 30:
            buy_price = min(bb_lower, support)
            analysis["signal"] = "买入"
            analysis["price_point"] = f"{buy_price:.2f}"
            analysis["reason"] = f"市场情绪中性，个股 RSI ({latest_rsi:.2f}) 进入超卖区。建议在近期支撑位 ({buy_price:.2f}) 附近买入。"
        elif latest_rsi > 70:
            sell_price = max(bb_upper, resistance) # Suggested sell price is the higher of BB_Upper or recent resistance
            analysis["signal"] = "卖出"
            analysis["price_point"] = f"{sell_price:.2f}"
            analysis["reason"] = f"市场情绪中性，个股 RSI ({latest_rsi:.2f}) 进入超买区。建议在近期阻力位或布林带上轨附近 ({sell_price:.2f}) 卖出。"

    # C. Market is Greedy or Extremely Greedy (sentiment_score >= 1)
    # Strategy: Look for selling opportunities in overbought stocks; be cautious with buying
    elif sentiment_score >= 1:
        if latest_rsi < 30:
            analysis["signal"] = "持有 / 观望 (风险)"
            analysis["reason"] = f"市场情绪贪婪，个股 RSI ({latest_rsi:.2f}) 虽然超卖，但整体市场风险较高，建议观望。"
        elif latest_rsi > 70:
            sell_price = max(bb_upper, resistance)
            analysis["signal"] = "强力卖出"
            analysis["price_point"] = f"{sell_price:.2f}"
            analysis["reason"] = f"市场情绪为贪婪，且个股 RSI ({latest_rsi:.2f}) 进入严重超买区。建议在近期阻力位或布林带上轨附近 ({sell_price:.2f}) 卖出以锁定利润。"

    # --- Macro Strategy Tone Adjustment (新添加的宏观策略基调调整逻辑) ---
    if macro_strategy_tone == "强力卖出":
        if analysis["signal"] != "强力买入": # If not already a strong buy, override to strong sell
            analysis["signal"] = "强力卖出"
            analysis["reason"] = f"宏观策略基调为【强力卖出】（流动性收紧 & 市场情绪贪婪），风险极高，无论个股信号如何，建议立即清仓或规避风险。"
        else: # If it was a strong buy, neutralize it due to macro
            analysis["signal"] = "规避风险"
            analysis["reason"] = f"宏观策略基调为【强力卖出】（流动性收紧 & 市场情绪贪婪），尽管个股出现买入信号，但宏观风险极高，建议规避风险，不进行任何操作。"
    elif macro_strategy_tone == "规避风险":
        if analysis["signal"] in ["强力买入", "买入", "持有/减仓"]: # If any positive/neutral signal, override to avoid risk
            analysis["signal"] = "规避风险"
            analysis["reason"] = f"宏观策略基调为【规避风险】（流动性收紧），市场面临系统性风险，建议保持空仓或显著降低仓位。"
    elif macro_strategy_tone == "保持观望":
        if analysis["signal"] in ["强力买入", "买入", "强力卖出", "卖出", "持有/减仓"]: # If any strong action signal, override to observe
            analysis["signal"] = "保持观望"
            analysis["reason"] = f"宏观策略基调为【保持观望】（流动性收紧），市场信号不明朗，建议不进行任何操作，等待时机。"
    elif macro_strategy_tone == "积极买入":
        if analysis["signal"] in ["持有/观望", "持有 / 减仓"]: # If neutral, upgrade to buy
            analysis["signal"] = "积极买入"
            analysis["reason"] = f"宏观策略基调为【积极买入】（流动性宽松 & 市场情绪中性），市场环境有利，建议积极寻找买入机会。 具体买入点位参考个股分析。"

    # --- Final Output Formatting ---
    print(f"  - {stock_code}: 最新RSI={latest_rsi:.2f}, 情绪分={sentiment_score} -> 决策: {analysis['signal']}")
    if analysis["price_point"]:
        print(f"    - 建议点位: {analysis['price_point']}")
    print(f"    - 理由: {analysis['reason']}")

    return analysis

def run_investment_strategy(
    naaim_output_file: str,
    sp500_pe_output_file: str,
    macro_strategy_tone: str
):
    """
    The main engine for the investment strategy.

    Parameters:
    - naaim_output (str): Web search output for NAAIM Exposure Index.
    - sp500_pe_output (str): Web search output for S&P 500 Forward P/E Ratio.
    - macro_strategy_tone (str): The overall macro strategy tone (e.g., "强力买入", "规避风险").

    1. Uses the provided market sentiment score and macro strategy tone.
    2. Fetches historical data and technical indicators for each stock in the watchlist.
    3. Applies a decision-making logic to generate signals.
    """
    print("--- 启动个人投资系统 ---")

    # 1. 获取市场情绪
    # Read content from files
    with open(naaim_output_file, 'r') as f:
        naaim_output = f.read()
    with open(sp500_pe_output_file, 'r') as f:
        sp500_pe_output = f.read()

    print()
    print("[1/2] 正在计算市场情绪...")
    sentiment_score = get_market_sentiment_score(naaim_output, sp500_pe_output)
    score_interpretation = {
        -2: "极度恐惧 (Panic)", -1: "中性-谨慎 (Neutral-Cautious)", 0: "中性-乐观 (Neutral-Optimistic)",
        1: "贪婪 (Greed)", 2: "极度贪婪 (Extreme Greed)"
    }
    print(f"市场情绪分析完成。得分为: {sentiment_score} ({score_interpretation.get(sentiment_score)})")
    print(f"宏观策略基调: {macro_strategy_tone}")

    # 2. 获取个股的技术指标数据
    print()
    print("[2/2] 正在获取观察列表个股的技术指标...")
    watchlist = get_watchlist()
    if not watchlist:
        print("观察列表为空，无法继续。")
        return
        
    processed_dataframes = adaptive_fetch_data(watchlist)
    print(f"已成功处理 {len(processed_dataframes)} 支股票的数据。")

    # 3. 对每只股票应用策略逻辑
    print()
    print("[3/3] 正在根据策略生成投资信号...")
    final_signals = {}
    for df in processed_dataframes:
        analysis = generate_signal(df, sentiment_score, macro_strategy_tone)
        stock_code = df['code'].iloc[0]
        final_signals[stock_code] = analysis

    print()
    print("--- 投资决策分析完成 ---")
    print("最终信号汇总:")
    # Pretty print the final results
    for stock_code, analysis in final_signals.items():
        print(f"  - {stock_code}:")
        print(f"    信号: {analysis['signal']}")
        if analysis["price_point"]:
            print(f"    建议点位: {analysis['price_point']}")
        print(f"    理由: {analysis['reason']}")
        
if __name__ == "__main__":
    if len(sys.argv) < 4:
        print('Usage: python strategy_engine.py <naaim_output_file_path> <sp500_pe_output_file_path> <macro_strategy_tone>')
        print('Example: python strategy_engine.py naaim_data.txt sp500_pe_data.txt "中性"')
        sys.exit(1)
    
    naaim_output_file_arg = sys.argv[1]
    sp500_pe_output_file_arg = sys.argv[2]
    macro_strategy_tone_arg = sys.argv[3]
    
    run_investment_strategy(naaim_output_file_arg, sp500_pe_output_file_arg, macro_strategy_tone_arg)
