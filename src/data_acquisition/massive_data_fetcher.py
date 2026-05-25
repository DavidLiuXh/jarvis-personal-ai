import urllib.parse
import json # Will need to parse JSON later, but for this file, the tool handles the output.

MASSIVE_API_KEY = "lo65BjwoRnTLIiE6rTl_y7UOeal03yZI" # Directly use the key from persistent_context
BASE_URL = "https://api.massive.com/v1"

def construct_massive_api_url(endpoint: str, params: dict = None) -> str:
    """
    构造 Massive.com API 的完整 URL。
    """
    if params is None:
        params = {}
    
    params["apiKey"] = MASSIVE_API_KEY

    # 编码查询参数
    query_string = urllib.parse.urlencode(params)
    return f"{BASE_URL}/{endpoint}?{query_string}"

# Note: The actual fetching will be done by the agent using the web_fetch tool
#       This file primarily provides the URL construction logic.
#       A separate script or the agent itself will call construct_massive_api_url
#       and then use web_fetch.

if __name__ == "__main__":
    # 示例用法：构造获取股息数据的 URL
    print("尝试构造 Massive.com 获取股息数据的 URL...")
    example_url = construct_massive_api_url("dividends", {"ticker": "AAPL"})
    print(f"构造的 URL: {example_url}")

    # To actually fetch this, the agent would then do:
    # print(default_api.web_fetch(prompt=f"获取 {example_url} 的内容"))
