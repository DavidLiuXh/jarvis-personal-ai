
import json
import time
import requests
from datetime import datetime, timedelta
from massive import RESTClient
import pandas as pd # New import

# Configuration
API_KEY = "lo65BjwoRnTLIiE6rTl_y7UOeal03yZI"
client = RESTClient(api_key=API_KEY)
BASE_URL_TEMPLATE = "https://massive.com/v1/open-close/{ticker}/{date}"
WATCHLIST_PATH = "/Users/lw/.gemini-jarvis/storage/investor/watchlist.json"
MAX_REQUESTS_PER_MINUTE = 5 # This will be handled by the adaptive_fetch_data logic
SLEEP_BUFFER = 2 # additional seconds to sleep for safety

def get_watchlist():
    """Reads the watchlist from the specified JSON file."""
    try:
        with open(WATCHLIST_PATH, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"Error: Watchlist file not found at {WATCHLIST_PATH}")
        return []
    except json.JSONDecodeError:
        print(f"Error: Could not decode JSON from {WATCHLIST_PATH}")
        return []

def fetch_historical_data(symbol, days_back=90):
    """
    Fetches historical daily market data for a given symbol from Massive Data API.
    Returns a list of dictionaries, each representing a day's data.
    """
    to_date = datetime.now()
    from_date = to_date - timedelta(days=days_back)

    try:
        aggs = client.list_aggs(
            ticker=symbol,
            multiplier=1,
            timespan="day",
            from_=from_date.strftime("%Y-%m-%d"), # Corrected parameter name
            to=to_date.strftime("%Y-%m-%d"),       # Corrected parameter name
            limit=50000 # A sufficiently large limit
        )
        # Convert Agg objects to dictionaries for consistency with previous structure
        # and easier DataFrame conversion
        historical_data = []
        for agg in aggs:
            historical_data.append({
                "code": symbol,
                "date": datetime.fromtimestamp(agg.timestamp / 1000).strftime("%Y-%m-%d"),
                "close": agg.close,
                "open": agg.open,
                "high": agg.high,
                "low": agg.low,
                "volume": agg.volume # Include volume as it's useful
            })
        return historical_data
    except Exception as e:
        print(f"Error fetching historical data for {symbol}: {e}")
        return []

def calculate_sma(df, window=20):
    """Calculates Simple Moving Average (SMA) for a given DataFrame."""
    df['SMA'] = df['close'].rolling(window=window).mean()
    return df

def calculate_rsi(df, window=14):
    """Calculates Relative Strength Index (RSI) for a given DataFrame."""
    delta = df['close'].diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=window).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=window).mean()

    rs = gain / loss
    df['RSI'] = 100 - (100 / (1 + rs))
    return df

def calculate_bollinger_bands(df, window=20, num_std_dev=2):
    """Calculates Bollinger Bands for a given DataFrame."""
    df['BB_Middle'] = df['close'].rolling(window=window).mean()
    std_dev = df['close'].rolling(window=window).std()
    df['BB_Upper'] = df['BB_Middle'] + (std_dev * num_std_dev)
    df['BB_Lower'] = df['BB_Middle'] - (std_dev * num_std_dev)
    return df

def calculate_support_resistance(df, window=60):
    """Calculates recent support and resistance levels for a given DataFrame."""
    df['Support'] = df['low'].rolling(window=window).min()
    df['Resistance'] = df['high'].rolling(window=window).max()
    return df

def adaptive_fetch_data(watchlist, days_back=90):
    """
    Fetches historical data for the entire watchlist adaptively to API limits,
    converts to DataFrame, and calculates technical indicators.
    """
    total_symbols = len(watchlist)
    if total_symbols == 0:
        return []

    min_sleep_duration = (60 / MAX_REQUESTS_PER_MINUTE) + SLEEP_BUFFER
    
    all_processed_data = []
    print(f"Starting historical data fetch and indicator calculation for {total_symbols} symbols over {days_back} days.")

    for i, symbol in enumerate(watchlist):
        print(f"Fetching historical data for {symbol} ({i+1}/{total_symbols})...")
        historical_data = fetch_historical_data(symbol, days_back)
        
        if historical_data:
            df = pd.DataFrame(historical_data)
            df['date'] = pd.to_datetime(df['date'])
            df = df.set_index('date').sort_index()

            df = calculate_sma(df)
            df = calculate_rsi(df)
            df = calculate_bollinger_bands(df)
            df = calculate_support_resistance(df)
            all_processed_data.append(df)
        else:
            print(f"Skipping indicator calculation for {symbol} due to no historical data.")
        
        if i < total_symbols - 1: # Don't sleep after the last request
            time.sleep(min_sleep_duration)
            
    return all_processed_data

if __name__ == "__main__":
    watchlist = get_watchlist()
    if watchlist:
        processed_market_data = adaptive_fetch_data(watchlist)
        print("\n--- Fetching and Indicator Calculation Complete ---")
        for df in processed_market_data:
            print(f"\nMarket Data and Indicators for {df['code'].iloc[0]}:")
            print(df.tail()) # Print the last few rows to show indicators
    else:
        print("Watchlist is empty. No data to fetch or indicators to calculate.")

