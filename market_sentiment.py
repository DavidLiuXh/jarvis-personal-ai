import os
from dotenv import load_dotenv
import requests
import json
import re

# 加载环境变量
load_dotenv()
ALPHA_VANTAGE_API_KEY = os.getenv('MASSIVE_API_KEY')

def get_naaim_exposure_index(web_search_output: str):
    """
    从 web_search_output 中解析最新的 NAAIM Exposure Index。
    如果失败，返回默认值。
    """
    # 使用正则表达式从输出中提取 NAAIM 指数
    match = re.search(r'NAAIM Exposure Index(?:.*?)(\d+\.?\d*)%?(?!\w)', web_search_output, re.IGNORECASE)
    if not match:
        match = re.search(r'NAAIM.*?(\d+\.?\d*)', web_search_output, re.IGNORECASE)
        
    if match:
        try:
            return float(match.group(1).strip())
        except ValueError:
            pass
    return 60.0 # 默认值，如果无法解析

def get_sp500_forward_pe(web_search_output: str):
    """
    从 web_search_output 中解析最新的 S&P 500 Forward P/E Ratio。
    如果失败，返回默认值。
    """
    # 使用正则表达式从输出中提取 S&P 500 Forward P/E
    match = re.search(r'S&P 500 Forward P/E Ratio(?: is|:)?\s*(\d+\.?\d*)(?:x)?', web_search_output, re.IGNORECASE)
    if not match:
        match = re.search(r'Forward P/E(?: is|:)?\s*(\d+\.?\d*)(?:x)?', web_search_output, re.IGNORECASE)

    if match:
        try:
            return float(match.group(1).strip())
        except ValueError:
            pass
    return 20.0 # 默认值，如果无法解析

def get_market_sentiment_score(
    naaim_search_output: str,
    sp500_pe_search_output: str
):
    """
    Analyzes US market sentiment based on 5 core indicators and returns a quantified score。

    The score ranges from -2 (Extreme Fear) to +2 (Extreme Greed)。
    """

    # --- 1. 获取动态指标值 ---
    naaim_exposure_index = get_naaim_exposure_index(naaim_search_output)
    sp500_forward_pe = get_sp500_forward_pe(sp500_pe_search_output)
    
    # 暂时使用默认或假设值，直到有可靠的自动化数据源
    institutional_equity_allocation_is_extreme = False
    retail_participation_percentile = 50.0 # 假设中性
    hedge_fund_leverage_is_extreme = False

    # --- 2. 定义警告阈值 ---
    warning_count = 0

    # Indicator 1: NAAIM Exposure Index
    if naaim_exposure_index > 80:
        warning_count += 1
    print(f"  NAAIM Exposure Index: {naaim_exposure_index:.2f} (Warning if > 80)")

    # Indicator 2: Institutional Equity Allocation
    if institutional_equity_allocation_is_extreme:
        warning_count += 1
    print(f"  Institutional Equity Allocation Extreme: {institutional_equity_allocation_is_extreme}")

    # Indicator 3: Retail Net Buying
    if retail_participation_percentile > 85:
        warning_count += 1
    print(f"  Retail Participation Percentile: {retail_participation_percentile:.2f} (Warning if > 85)")

    # Indicator 4: S&P 500 Forward P/E Ratio
    if sp500_forward_pe >= 22:
        warning_count += 1
    print(f"  S&P 500 Forward P/E: {sp500_forward_pe:.2f} (Warning if >= 22)")

    # Indicator 5: Hedge Fund Leverage
    if hedge_fund_leverage_is_extreme:
        warning_count += 1
    print(f"  Hedge Fund Leverage Extreme: {hedge_fund_leverage_is_extreme}")

    # --- 3. 将警告计数映射到情绪分数 ---
    score_map = {
        0: -2, # Panic
        1: -1, # Neutral-Cautious
        2: 0,  # Neutral-Optimistic
        3: 1,  # Greed
        4: 2,  # Extreme Greed
        5: 2   # Extreme Greed
    }
    
    sentiment_score = score_map.get(warning_count, 0) # Default to 0 (Neutral)

    print(f"Market Sentiment Analysis Complete: {warning_count}/5 indicators are in a warning state. Score: {sentiment_score}")
    
    return sentiment_score

