import time
from datetime import datetime
try:
    from massive import RESTClient
except ImportError:
    print("❌ 错误: 未找到 massive SDK。请运行 'pip install massive' 安装。")
    exit(1)

# ================= 配置区域 =================
API_KEY = "lo65BjwoRnTLIiE6rTl_y7UOeal03yZI"

# 个股清单
STOCKS = ["GOOGL", "NVDA", "ORCL", "V"]
# 指数清单 (注意格式 I:SYMBOL)
INDICES = ["I:SPX", "I:NDX"]

# 限流保护：一分钟最多5次，设定 12.5 秒间隔以保安全
RATE_LIMIT_INTERVAL = 12.5
# ===========================================

class MassiveDataFetcher:
    def __init__(self, api_key):
        self.client = RESTClient(api_key=api_key)
        self.last_request_time = 0

    def _wait(self):
        """执行强制等待以符合频率限制"""
        now = time.time()
        elapsed = now - self.last_request_time
        if elapsed < RATE_LIMIT_INTERVAL:
            wait_time = RATE_LIMIT_INTERVAL - elapsed
            print(f"⏳ [限流] 等待 {wait_time:.1f}s...")
            time.sleep(wait_time)
        self.last_request_time = time.time()

    def fetch_stock(self, ticker):
        self._wait()
        print(f"🚀 [正在获取个股] {ticker} ...", end="", flush=True)
        try:
            # SDK 规范：第一个参数是市场类型，第二个是 Ticker
            snapshot = self.client.get_snapshot_ticker("stocks", ticker)
            print(" ✅")
            return snapshot
        except Exception as e:
            print(f" ❌ 失败: {str(e)}")
            return None

    def fetch_index(self, ticker):
        self._wait()
        print(f"📊 [正在获取指数] {ticker} ...", end="", flush=True)
        try:
            # SDK 规范：指数市场类型为 "indices"
            snapshot = self.client.get_snapshot_ticker("indices", ticker)
            print(" ✅")
            return snapshot
        except Exception as e:
            print(f" ❌ 失败: {str(e)}")
            return None

    def run(self):
        print(f"📅 任务启动时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        all_results = {}
        
        # 先抓取个股
        for t in STOCKS:
            all_results[t] = self.fetch_stock(t)
            
        # 再抓取指数
        for t in INDICES:
            all_results[t] = self.fetch_index(t)
            
        print("-" * 50)
        return all_results

if __name__ == "__main__":
    fetcher = MassiveDataFetcher(API_KEY)
    final_data = fetcher.run()
    
    print("\n📝 最终行情简报:")
    for ticker, snap in final_data.items():
        if snap:
            try:
                # 个股通常有 last_trade.p，指数可能有不同的字段映射
                # 我们使用 getattr 安全访问
                last_trade = getattr(snap, 'last_trade', None)
                price = getattr(last_trade, 'p', 'N/A') if last_trade else "N/A"
                change = getattr(snap, 'todays_change_perc', 'N/A')
                print(f"  {ticker:8} | 价格: ${str(price):10} | 今日涨跌: {str(change):6}%")
            except Exception:
                print(f"  {ticker:8} | [解析异常]")
        else:
            print(f"  {ticker:8} | 无数据")
