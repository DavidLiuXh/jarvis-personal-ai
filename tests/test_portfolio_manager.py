# tests/test_portfolio_manager.py
import pytest
import os
import json
from unittest.mock import patch
from datetime import datetime, timedelta
import pandas as pd

# Import the class under test
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from portfolio_manager import PortfolioManager, PORTFOLIO_FILE

# Fixture to ensure a clean portfolio.json for each test
@pytest.fixture(autouse=True)
def clean_portfolio_file():
    if os.path.exists(PORTFOLIO_FILE):
        os.remove(PORTFOLIO_FILE)
    yield
    if os.path.exists(PORTFOLIO_FILE):
        os.remove(PORTFOLIO_FILE)

def test_add_holding_successfully():
    manager = PortfolioManager()
    manager.add_holding("AAPL", 10.0, 150.50, "2023-01-15")
    
    assert len(manager.portfolio) == 1
    assert manager.portfolio.iloc[0]['symbol'] == "AAPL"
    assert manager.portfolio.iloc[0]['quantity'] == 10.0
    assert manager.portfolio.iloc[0]['purchase_price'] == 150.50
    assert manager.portfolio.iloc[0]['purchase_date'] == "2023-01-15"
    
    # Verify it's saved to file
    data = pd.read_csv(PORTFOLIO_FILE)
    assert len(data) == 1
    assert data.iloc[0]['symbol'] == "AAPL"

def test_add_holding_invalid_quantity():
    manager = PortfolioManager()
    with pytest.raises(ValueError, match="Quantity must be a positive number."):
        manager.add_holding("AAPL", -5.0, 150.50, "2023-01-15")

def test_add_holding_invalid_price():
    manager = PortfolioManager()
    with pytest.raises(ValueError, match="Buy price must be a positive number."):
        manager.add_holding("AAPL", 10.0, -150.50, "2023-01-15")

def test_add_holding_invalid_date_format():
    manager = PortfolioManager()
    with pytest.raises(ValueError, match="Invalid date format. Please use YYYY-MM-DD."):
        manager.add_holding("AAPL", 10.0, 150.50, "15-01-2023")

def test_add_holding_future_date():
    manager = PortfolioManager()
    future_date = (datetime.now().date() + timedelta(days=1)).strftime("%Y-%m-%d")
    with pytest.raises(ValueError, match="Buy date cannot be in the future."):
        manager.add_holding("AAPL", 10.0, 150.50, future_date)

def test_add_holding_duplicate_updates_existing():
    manager = PortfolioManager()
    manager.add_holding("AAPL", 10.0, 150.0, "2023-01-15")
    manager.add_holding("AAPL", 5.0, 160.0, "2023-01-15") # Should update existing

    assert len(manager.portfolio) == 1
    assert manager.portfolio.iloc[0]['symbol'] == "AAPL"
    assert manager.portfolio.iloc[0]['quantity'] == 15.0 # 10 + 5
    # The buy price should be an average or the new price, let's define it as a simple average for now
    assert manager.portfolio.iloc[0]['purchase_price'] == pytest.approx((10*150.0 + 5*160.0) / 15.0)
    assert manager.portfolio.iloc[0]['purchase_date'] == "2023-01-15"

def test_update_holding_successfully_quantity():
    manager = PortfolioManager()
    manager.add_holding("AAPL", 10.0, 150.0, "2023-01-15")
    manager.update_holding("AAPL", "2023-01-15", new_quantity=15.0)

    assert len(manager.portfolio) == 1
    assert manager.portfolio.iloc[0]['symbol'] == "AAPL"
    assert manager.portfolio.iloc[0]['quantity'] == 15.0
    assert manager.portfolio.iloc[0]['purchase_price'] == 150.0 # Price should not change unless new_price is provided

def test_update_holding_successfully_price():
    manager = PortfolioManager()
    manager.add_holding("GOOG", 5.0, 100.0, "2022-05-20")
    manager.update_holding("GOOG", "2022-05-20", new_buy_price=110.0)

    assert len(manager.portfolio) == 1
    assert manager.portfolio.iloc[0]['symbol'] == "GOOG"
    assert manager.portfolio.iloc[0]['quantity'] == 5.0
    assert manager.portfolio.iloc[0]['purchase_price'] == 110.0

def test_update_holding_not_found():
    manager = PortfolioManager()
    manager.add_holding("MSFT", 20.0, 250.0, "2023-02-01")
    with pytest.raises(ValueError, match="Holding for MSFT on 2023-02-02 not found."):
        manager.update_holding("MSFT", "2023-02-02", new_quantity=25.0)

def test_update_holding_invalid_new_quantity():
    manager = PortfolioManager()
    manager.add_holding("TSLA", 2.0, 700.0, "2022-10-01")
    with pytest.raises(ValueError, match="New quantity must be a positive number if provided."):
        manager.update_holding("TSLA", "2022-10-01", new_quantity=-1.0)

def test_update_holding_invalid_new_price():
    manager = PortfolioManager()
    manager.add_holding("AMZN", 3.0, 120.0, "2023-04-05")
    with pytest.raises(ValueError, match="New buy price must be a positive number if provided."):
        manager.update_holding("AMZN", "2023-04-05", new_buy_price=0.0)

def test_update_holding_no_changes():
    manager = PortfolioManager()
    manager.add_holding("NVDA", 7.0, 400.0, "2023-06-10")
    # No new_quantity or new_price provided
    manager.update_holding("NVDA", "2023-06-10") 
    
    assert manager.portfolio.iloc[0]['quantity'] == 7.0
    assert manager.portfolio.iloc[0]['purchase_price'] == 400.0
    # No explicit message for no changes, just no error

def test_delete_holding_successfully():
    manager = PortfolioManager()
    manager.add_holding("AAPL", 10.0, 150.0, "2023-01-15")
    manager.add_holding("MSFT", 5.0, 200.0, "2023-02-20")
    
    manager.delete_holding("AAPL", "2023-01-15")
    
    assert len(manager.portfolio) == 1
    assert manager.portfolio.iloc[0]['symbol'] == "MSFT"
    
    # Verify file content
    data = pd.read_csv(PORTFOLIO_FILE)
    assert len(data) == 1
    assert data.iloc[0]['symbol'] == "MSFT"

def test_delete_holding_not_found():
    manager = PortfolioManager()
    manager.add_holding("GOOG", 3.0, 100.0, "2023-03-01")
    with pytest.raises(ValueError, match="Holding for TSLA on 2023-04-01 not found."):
        manager.delete_holding("TSLA", "2023-04-01")
    assert len(manager.portfolio) == 1 # Portfolio should remain unchanged

def test_clear_portfolio_successfully():
    manager = PortfolioManager()
    manager.add_holding("AAPL", 10.0, 150.0, "2023-01-15")
    manager.add_holding("MSFT", 5.0, 200.0, "2023-02-20")
    
    manager.clear_portfolio()
    
    assert len(manager.portfolio) == 0
    
    # Verify file content
    data = pd.read_csv(PORTFOLIO_FILE)
    assert len(data) == 0

def test_clear_empty_portfolio():
    manager = PortfolioManager()
    manager.clear_portfolio() # Clearing an already empty portfolio
    assert len(manager.portfolio) == 0

from pandas import DataFrame # Needed for mocking adaptive_fetch_data

@patch('portfolio_manager.adaptive_fetch_data')
def test_display_portfolio_with_data(mock_adaptive_fetch_data, capsys):
    manager = PortfolioManager()
    manager.add_holding("AAPL", 10.0, 150.0, "2023-01-15")
    manager.add_holding("MSFT", 5.0, 200.0, "2023-02-20")

    # Mock the return value of adaptive_fetch_data
    mock_adaptive_fetch_data.return_value = [
        DataFrame([{'code': 'AAPL', 'close': 160.0, 'date': '2024-07-20'}]),
        DataFrame([{'code': 'MSFT', 'close': 210.0, 'date': '2024-07-20'}])
    ]

    manager.display_portfolio()
    captured = capsys.readouterr()
    output = captured.out

    assert output == """--- 当前投资组合 ---
| 代码 | 数量 | 买入价 | 当前价 | 买入日期 | 当前价值 | 盈亏 (%) |
|:--   -:|:------:|:-------:|:-------:|:--         -:|:--------:|:-------:|
| AAPL | 10.00 | 150.00 | 160.00 | 2023-01-15 | 1600.00 |   6.67 |
| MSFT |  5.00 | 200.00 | 210.00 | 2023-02-20 | 1050.00 |   5.00 |
总投资价值: 2,650.00
总盈亏: 150.00
总盈亏 (%): 6.00
"""
@patch('portfolio_manager.adaptive_fetch_data')
def test_display_portfolio_empty(mock_adaptive_fetch_data, capsys):
    manager = PortfolioManager() # Empty portfolio
    manager.display_portfolio()
    captured = capsys.readouterr()
    output = captured.out

    assert "--- 当前投资组合 ---" in output
    assert "投资组合为空。" in output
    mock_adaptive_fetch_data.assert_not_called() # Should not call if portfolio is empty

@patch('portfolio_manager.adaptive_fetch_data')
def test_display_portfolio_missing_realtime_price(mock_adaptive_fetch_data, capsys):
    manager = PortfolioManager()
    manager.add_holding("AAPL", 10.0, 150.0, "2023-01-15")
    manager.add_holding("UNKNOWN", 5.0, 100.0, "2023-03-01") # Simulate a stock that won't get real-time data

    mock_adaptive_fetch_data.return_value = [
        DataFrame([{'code': 'AAPL', 'close': 160.0, 'date': '2024-07-20'}]) # Only AAPL data
    ]

    manager.display_portfolio()
    captured = capsys.readouterr()
    output = captured.out

    assert output == """--- 当前投资组合 ---
| 代码 | 数量 | 买入价 | 当前价 | 买入日期 | 当前价值 | 盈亏 (%) |
|:--      -:|:------:|:-------:|:-------:|:--         -:|:--------:|:-------:|
| AAPL    | 10.00 | 150.00 | 160.00 | 2023-01-15 | 1600.00 |   6.67 |
| UNKNOWN |  5.00 | 100.00 |    N/A | 2023-03-01 |     N/A |    N/A |
总投资价值: 1,600.00
总盈亏: 100.00
总盈亏 (%): 6.67
警告: 未能获取所有持仓的实时价格。
"""
