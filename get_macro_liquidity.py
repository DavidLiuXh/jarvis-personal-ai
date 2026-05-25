import os
from dotenv import load_dotenv
from fredapi import Fred
import requests
import json
from datetime import datetime, timedelta

# 加载环境变量
load_dotenv()
FRED_API_KEY = os.getenv('FRED_API_KEY')
ALPHA_VANTAGE_API_KEY = os.getenv('MASSIVE_API_KEY') # MASSIVE_API_KEY is used for Alpha Vantage

def get_fred_data(series_id):
    """从 FRED API 获取数据"""
    fred = Fred(api_key=FRED_API_KEY)
    data = fred.get_series(series_id)
    if data is not None and not data.empty:
        # 获取最新数据点
        return data.iloc[-1]
    return None

def get_alpha_vantage_forex(from_symbol, to_symbol):
    """从 Alpha Vantage API 获取外汇数据"""
    url = f"https://www.alphavantage.co/query?function=FX_DAILY&from_symbol={from_symbol}&to_symbol={to_symbol}&apikey={ALPHA_VANTAGE_API_KEY}"
    try:
        response = requests.get(url)
        response.raise_for_status() # 检查 HTTP 错误
        data = response.json()
        
        # 确保 'Time Series FX (Daily)' 键存在
        if "Time Series FX (Daily)" in data:
            # 获取最新日期的汇率
            latest_date = sorted(data["Time Series FX (Daily)"].keys(), reverse=True)[0]
            return float(data["Time Series FX (Daily)"][latest_date]["4. close"])
        else:
            print(f"Error: 'Time Series FX (Daily)' not found in Alpha Vantage response for {from_symbol}/{to_symbol}: {data}")
            return None
    except requests.exceptions.RequestException as e:
        print(f"Error fetching data from Alpha Vantage for {from_symbol}/{to_symbol}: {e}")
        return None
    except json.JSONDecodeError as e:
        print(f"Error decoding JSON from Alpha Vantage for {from_symbol}/{to_symbol}: {e}")
        return None
    except Exception as e:
        print(f"An unexpected error occurred for Alpha Vantage {from_symbol}/{to_symbol}: {e}")
        return None

def analyze_macro_liquidity():
    """
    获取宏观流动性数据并生成策略基调。
    指标：
    - TGA (财政部总账户): 上升表示流动性收紧
    - RRP (逆回购协议): 上升表示流动性收紧
    - SOFR (担保隔夜融资利率): 上升表示流动性收紧
    - USD/JPY (美元/日元): 日元疲软 (USD/JPY 上升) 表示套利交易盛行，可能暗示全球流动性充裕；反之则收紧。
    """
    tga = get_fred_data('WTREGEN')
    rrp = get_fred_data('RRPONTSYD')
    sofr = get_fred_data('SOFR')
    usdjpy = get_alpha_vantage_forex('USD', 'JPY')

    print(f"FRED TGA (latest): {tga}")
    print(f"FRED RRP (latest): {rrp}")
    print(f"FRED SOFR (latest): {sofr}")
    print(f"Alpha Vantage USD/JPY (latest): {usdjpy}")

    # 简单的宏观策略基调生成逻辑（待完善）
    # 这里只是一个占位符，需要更复杂的逻辑来整合这些指标
    # 例如，可以设置阈值或趋势分析来判断流动性状况
    
    liquidity_score = 0

    if tga is not None and tga > 500000: # 假设TGA高位收紧流动性
        liquidity_score -= 1
    if rrp is not None and rrp > 1000000: # 假设RRP高位收紧流动性
        liquidity_score -= 1
    if sofr is not None and sofr > 5.0: # 假设SOFR高位收紧流动性
        liquidity_score -= 1
    if usdjpy is not None and usdjpy > 155: # 假设USD/JPY过高表示日元疲软，流动性泛滥
        liquidity_score += 1
    elif usdjpy is not None and usdjpy < 140: # 假设USD/JPY过低表示日元走强，流动性收紧
        liquidity_score -= 1

    if liquidity_score > 0:
        return "宽松"
    elif liquidity_score < 0:
        return "收紧"
    else:
        return "中性"

if __name__ == "__main__":
    macro_tone = analyze_macro_liquidity()
    print(f"宏观策略基调: {macro_tone}")
