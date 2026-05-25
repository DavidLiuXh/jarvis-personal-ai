# Portfolio Management Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个独立的投资组合管理模块 (`portfolio_manager.py`)，支持添加、更新、删除、显示和清空持仓记录，数据以 JSON 格式持久化存储，并在显示时获取实时价格。

**Architecture:** 该模块将包含一个 `PortfolioManager` 类，封装所有投资组合操作，并集成 `get_market_data` 模块以获取实时价格。通过命令行接口 (CLI) 提供所有功能。

**Tech Stack:** Python 3, `json` 模块, `argparse` 模块, `get_market_data` (现有模块)。

---

### Task 1: 创建 `portfolio_manager.py` 和初始 `PortfolioManager` 类

**Files:**
- Create: `portfolio_manager.py`
- Test: `tests/test_portfolio_manager.py` (稍后创建，本任务不涉及测试文件)

- [ ] **Step 1: 创建 `portfolio_manager.py` 文件并定义 `PortfolioManager` 类结构**

```python
# portfolio_manager.py
import json
import os
import argparse
from datetime import datetime

# Assuming get_market_data is available in the same project structure
from get_market_data import adaptive_fetch_data # We will need this for display_portfolio

PORTFOLIO_FILE = 'portfolio.json'

class PortfolioManager:
    def __init__(self):
        self.portfolio = self._load_portfolio()

    def _load_portfolio(self):
        if not os.path.exists(PORTFOLIO_FILE) or os.stat(PORTFOLIO_FILE).st_size == 0:
            return []
        with open(PORTFOLIO_FILE, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                print(f"Warning: {PORTFOLIO_FILE} is corrupted or invalid JSON. Starting with an empty portfolio.")
                return []

    def _save_portfolio(self):
        with open(PORTFOLIO_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.portfolio, f, indent=4, ensure_ascii=False)

    def add_holding(self, code, quantity, buy_price, buy_date):
        # Implementation for adding a holding
        pass

    def update_holding(self, code, buy_date, new_quantity=None, new_buy_price=None):
        # Implementation for updating a holding
        pass

    def delete_holding(self, code, buy_date):
        # Implementation for deleting a holding
        pass

    def display_portfolio(self):
        # Implementation for displaying the portfolio with real-time prices
        pass

    def clear_portfolio(self):n        # Implementation for clearing the portfolio
        pass

def main():
    parser = argparse.ArgumentParser(description="Manage your investment portfolio.")
    # Add subparsers for different commands
    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # Add command parser
    add_parser = subparsers.add_parser('add', help='Add a new stock holding')
    add_parser.add_argument('--code', required=True, help='Stock ticker symbol')
    add_parser.add_argument('--quantity', type=float, required=True, help='Number of shares')
    add_parser.add_argument('--price', type=float, required=True, help='Buy price per share')
    add_parser.add_argument('--date', required=True, help='Buy date (YYYY-MM-DD)')

    # Update command parser
    update_parser = subparsers.add_parser('update', help='Update an existing stock holding')
    update_parser.add_argument('--code', required=True, help='Stock ticker symbol')
    update_parser.add_argument('--date', required=True, help='Buy date (YYYY-MM-DD) of the holding to update')
    update_parser.add_argument('--new_quantity', type=float, help='New number of shares')
    update_parser.add_argument('--new_price', type=float, help='New buy price per share')

    # Delete command parser
    delete_parser = subparsers.add_parser('delete', help='Delete a stock holding')
    delete_parser.add_argument('--code', required=True, help='Stock ticker symbol')
    delete_parser.add_argument('--date', required=True, help='Buy date (YYYY-MM-DD) of the holding to delete')

    # Display command parser
    display_parser = subparsers.add_parser('display', help='Display current portfolio holdings with real-time data')

    # Clear command parser
    clear_parser = subparsers.add_parser('clear', help='Clear all holdings from the portfolio')

    args = parser.parse_args()

    manager = PortfolioManager()

    if args.command == 'add':
        manager.add_holding(args.code.upper(), args.quantity, args.price, args.date)
    elif args.command == 'update':
        manager.update_holding(args.code.upper(), args.date, args.new_quantity, args.new_price)
    elif args.command == 'delete':
        manager.delete_holding(args.code.upper(), args.date)
    elif args.command == 'display':
        manager.display_portfolio()
    elif args.command == 'clear':
        manager.clear_portfolio()
    else:
        parser.print_help()

if __name__ == '__main__':
    main()

```

- [ ] **Step 2: 提交**

```bash
git add portfolio_manager.py
git commit -m "feat: setup portfolio_manager.py with basic class structure and CLI"
```

### Task 2: 实现 `add_holding` 功能和相关输入验证

**Files:**
- Modify: `portfolio_manager.py`
- Create: `tests/test_portfolio_manager.py`

- [ ] **Step 1: 编写 `add_holding` 的 failing test**

```python
# tests/test_portfolio_manager.py
import pytest
import os
import json
from unittest.mock import patch
from datetime import datetime, timedelta

# Import the class under test
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
    assert manager.portfolio[0]['code'] == "AAPL"
    assert manager.portfolio[0]['quantity'] == 10.0
    assert manager.portfolio[0]['buy_price'] == 150.50
    assert manager.portfolio[0]['buy_date'] == "2023-01-15"
    
    # Verify it's saved to file
    with open(PORTFOLIO_FILE, 'r') as f:
        data = json.load(f)
        assert len(data) == 1
        assert data[0]['code'] == "AAPL"

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
    assert manager.portfolio[0]['code'] == "AAPL"
    assert manager.portfolio[0]['quantity'] == 15.0 # 10 + 5
    # The buy price should be an average or the new price, let's define it as a simple average for now
    assert manager.portfolio[0]['buy_price'] == pytest.approx((10*150.0 + 5*160.0) / 15.0)
    assert manager.portfolio[0]['buy_date'] == "2023-01-15"

```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_portfolio_manager.py -v`
Expected: FAIL (because `add_holding` is not implemented yet, or `timedelta` is not imported). Specifically, `test_add_holding_successfully` will fail due to `add_holding` not doing anything, and others will fail if `timedelta` is not imported or validation is missing.

- [ ] **Step 3: 编写 `add_holding` 最小实现**

```python
# portfolio_manager.py (修改内容)

import json
import os
import argparse
from datetime import datetime, timedelta # Import timedelta

PORTFOLIO_FILE = 'portfolio.json'

class PortfolioManager:
    # ... (previous code) ...

    def add_holding(self, code, quantity, buy_price, buy_date):
        # Input validation
        if not isinstance(quantity, (int, float)) or quantity <= 0:
            raise ValueError("Quantity must be a positive number.")
        if not isinstance(buy_price, (int, float)) or buy_price <= 0:
            raise ValueError("Buy price must be a positive number.")
        try:
            parsed_date = datetime.strptime(buy_date, "%Y-%m-%d").date()
            if parsed_date > datetime.now().date():
                raise ValueError("Buy date cannot be in the future.")
        except ValueError:
            raise ValueError("Invalid date format. Please use YYYY-MM-DD.")

        new_holding = {
            "code": code.upper(),
            "quantity": quantity,
            "buy_price": buy_price,
            "buy_date": buy_date
        }

        # Check for existing holding with same code and buy_date
        found = False
        for i, holding in enumerate(self.portfolio):
            if holding['code'] == code.upper() and holding['buy_date'] == buy_date:
                # Update existing holding: new average price and total quantity
                total_value_old = holding['quantity'] * holding['buy_price']
                total_quantity_new = holding['quantity'] + quantity
                total_value_new = total_value_old + (quantity * buy_price)
                
                holding['quantity'] = total_quantity_new
                holding['buy_price'] = total_value_new / total_quantity_new if total_quantity_new > 0 else 0
                print(f"Holding for {code.upper()} on {buy_date} updated. New quantity: {holding['quantity']:.2f}, Avg Price: {holding['buy_price']:.2f}")
                found = True
                break
        
        if not found:
            self.portfolio.append(new_holding)
            print(f"Added holding: {code.upper()} {quantity} shares at {buy_price:.2f} on {buy_date}")
        
        self._save_portfolio()

    # ... (rest of the class and main function) ...

```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_portfolio_manager.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add portfolio_manager.py tests/test_portfolio_manager.py
git commit -m "feat: implement add_holding with input validation and duplicate handling"
```

### Task 3: 实现 `update_holding` 功能

**Files:**
- Modify: `portfolio_manager.py`
- Modify: `tests/test_portfolio_manager.py`

- [ ] **Step 1: 编写 `update_holding` 的 failing test**

```python
# tests/test_portfolio_manager.py (追加内容)

def test_update_holding_successfully_quantity():
    manager = PortfolioManager()
    manager.add_holding("AAPL", 10.0, 150.0, "2023-01-15")
    manager.update_holding("AAPL", "2023-01-15", new_quantity=15.0)

    assert len(manager.portfolio) == 1
    assert manager.portfolio[0]['code'] == "AAPL"
    assert manager.portfolio[0]['quantity'] == 15.0
    assert manager.portfolio[0]['buy_price'] == 150.0 # Price should not change unless new_price is provided

def test_update_holding_successfully_price():
    manager = PortfolioManager()
    manager.add_holding("GOOG", 5.0, 100.0, "2022-05-20")
    manager.update_holding("GOOG", "2022-05-20", new_buy_price=110.0)

    assert len(manager.portfolio) == 1
    assert manager.portfolio[0]['code'] == "GOOG"
    assert manager.portfolio[0]['quantity'] == 5.0
    assert manager.portfolio[0]['buy_price'] == 110.0

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
    
    assert manager.portfolio[0]['quantity'] == 7.0
    assert manager.portfolio[0]['buy_price'] == 400.0
    # No explicit message for no changes, just no error

```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_portfolio_manager.py -v`
Expected: FAIL (because `update_holding` is not implemented yet).

- [ ] **Step 3: 编写 `update_holding` 最小实现**

```python
# portfolio_manager.py (修改内容)

import json
import os
import argparse
from datetime import datetime, timedelta

PORTFOLIO_FILE = 'portfolio.json'

class PortfolioManager:
    # ... (previous code) ...

    def update_holding(self, code, buy_date, new_quantity=None, new_buy_price=None):
        found = False
        for holding in self.portfolio:
            if holding['code'] == code.upper() and holding['buy_date'] == buy_date:
                found = True
                if new_quantity is not None:
                    if not isinstance(new_quantity, (int, float)) or new_quantity <= 0:
                        raise ValueError("New quantity must be a positive number if provided.")
                    holding['quantity'] = new_quantity
                    print(f"Holding for {code.upper()} on {buy_date} updated: quantity to {new_quantity:.2f}")
                
                if new_buy_price is not None:
                    if not isinstance(new_buy_price, (int, float)) or new_buy_price <= 0:
                        raise ValueError("New buy price must be a positive number if provided.")
                    holding['buy_price'] = new_buy_price
                    print(f"Holding for {code.upper()} on {buy_date} updated: buy price to {new_buy_price:.2f}")
                
                if new_quantity is None and new_buy_price is None:
                    print(f"No update parameters provided for {code.upper()} on {buy_date}. No changes made.")
                break
        
        if not found:
            raise ValueError(f"Holding for {code.upper()} on {buy_date} not found.")
        
        self._save_portfolio()

    # ... (rest of the class and main function) ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_portfolio_manager.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add portfolio_manager.py tests/test_portfolio_manager.py
git commit -m "feat: implement update_holding with validation"
```

### Task 4: 实现 `delete_holding` 和 `clear_portfolio` 功能

**Files:**
- Modify: `portfolio_manager.py`
- Modify: `tests/test_portfolio_manager.py`

- [ ] **Step 1: 编写 `delete_holding` 和 `clear_portfolio` 的 failing test**

```python
# tests/test_portfolio_manager.py (追加内容)

def test_delete_holding_successfully():
    manager = PortfolioManager()
    manager.add_holding("AAPL", 10.0, 150.0, "2023-01-15")
    manager.add_holding("MSFT", 5.0, 200.0, "2023-02-20")
    
    manager.delete_holding("AAPL", "2023-01-15")
    
    assert len(manager.portfolio) == 1
    assert manager.portfolio[0]['code'] == "MSFT"
    
    # Verify file content
    with open(PORTFOLIO_FILE, 'r') as f:
        data = json.load(f)
        assert len(data) == 1
        assert data[0]['code'] == "MSFT"

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
    with open(PORTFOLIO_FILE, 'r') as f:
        data = json.load(f)
        assert len(data) == 0

def test_clear_empty_portfolio():
    manager = PortfolioManager()
    manager.clear_portfolio() # Clearing an already empty portfolio
    assert len(manager.portfolio) == 0

```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_portfolio_manager.py -v`
Expected: FAIL (because `delete_holding` and `clear_portfolio` are not implemented yet).

- [ ] **Step 3: 编写 `delete_holding` 和 `clear_portfolio` 最小实现**

```python
# portfolio_manager.py (修改内容)

import json
import os
import argparse
from datetime import datetime, timedelta

PORTFOLIO_FILE = 'portfolio.json'

class PortfolioManager:
    # ... (previous code) ...

    def delete_holding(self, code, buy_date):
        initial_len = len(self.portfolio)
        self.portfolio = [
            h for h in self.portfolio 
            if not (h['code'] == code.upper() and h['buy_date'] == buy_date)
        ]
        
        if len(self.portfolio) == initial_len:
            raise ValueError(f"Holding for {code.upper()} on {buy_date} not found.")
        
        print(f"Deleted holding for {code.upper()} on {buy_date}")
        self._save_portfolio()

    def clear_portfolio(self):
        if not self.portfolio:
            print("Portfolio is already empty.")
            return

        self.portfolio = []
        self._save_portfolio()
        print("All holdings cleared from the portfolio.")

    # ... (rest of the class and main function) ...

```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_portfolio_manager.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add portfolio_manager.py tests/test_portfolio_manager.py
git commit -m "feat: implement delete_holding and clear_portfolio"
```

### Task 5: 实现 `display_portfolio` 功能

**Files:**
- Modify: `portfolio_manager.py`
- Modify: `tests/test_portfolio_manager.py` (需要模拟 `adaptive_fetch_data` )

- [ ] **Step 1: 编写 `display_portfolio` 的 failing test**

```python
# tests/test_portfolio_manager.py (追加内容)

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

    assert "--- 当前投资组合 ---" in output
    assert "代码    数量    买入价    当前价    买入日期    当前价值    盈亏 (%)" in output
    assert "AAPL    10.00    150.00    160.00    2023-01-15    1600.00    6.67" in output
    assert "MSFT     5.00    200.00    210.00    2023-02-20    1050.00    5.00" in output
    assert "总投资价值:" in output
    assert "总盈亏:" in output
    assert "总盈亏 (%):" in output
    
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

    assert "AAPL    10.00    150.00    160.00    2023-01-15    1600.00    6.67" in output
    assert "UNKNOWN     5.00    100.00    N/A         2023-03-01    N/A        N/A" in output
    assert "警告: 未能获取所有持仓的实时价格。" in output
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_portfolio_manager.py -v`
Expected: FAIL (because `display_portfolio` is not implemented yet).

- [ ] **Step 3: 编写 `display_portfolio` 最小实现**

```python
# portfolio_manager.py (修改内容)

import json
import os
import argparse
from datetime import datetime, timedelta
from tabulate import tabulate # For pretty printing tables - need to add import

# Assuming get_market_data is available in the same project structure
from get_market_data import adaptive_fetch_data

PORTFOLIO_FILE = 'portfolio.json'

class PortfolioManager:
    # ... (previous code) ...

    def display_portfolio(self):
        print("--- 当前投资组合 ---")
        if not self.portfolio:
            print("投资组合为空。")
            return

        tickers = [holding['code'] for holding in self.portfolio]
        realtime_data_frames = {}
        try:
            fetched_data = adaptive_fetch_data(tickers)
            for df in fetched_data:
                if not df.empty:
                    code = df['code'].iloc[0]
                    realtime_data_frames[code] = df.iloc[-1]['close'] # Get the latest close price
        except Exception as e:
            print(f"警告: 获取实时价格时发生错误 - {e}. 将使用买入价格进行部分计算。")
            realtime_data_frames = {} # Clear any partial data if there was an error


        table_data = []
        total_current_value = 0.0
        total_buy_value = 0.0
        missing_price_warning = False

        for holding in self.portfolio:
            code = holding['code']
            quantity = holding['quantity']
            buy_price = holding['buy_price']
            buy_date = holding['buy_date']

            current_price = realtime_data_frames.get(code)
            
            if current_price is None:
                current_price_str = "N/A"
                current_value = "N/A"
                profit_loss_percent = "N/A"
                profit_loss_abs = "N/A"
                missing_price_warning = True
            else:
                current_value = quantity * current_price
                buy_value = quantity * buy_price
                profit_loss_abs = current_value - buy_value
                profit_loss_percent = (profit_loss_abs / buy_value) * 100 if buy_value > 0 else 0
                
                total_current_value += current_value
                total_buy_value += buy_value

                current_price_str = f"{current_price:.2f}"
                current_value = f"{current_value:.2f}"
                profit_loss_percent = f"{profit_loss_percent:.2f}"
            
            table_data.append([
                code,
                f"{quantity:.2f}",
                f"{buy_price:.2f}",
                current_price_str,
                buy_date,
                current_value,
                profit_loss_percent
            ])
        
        headers = ["代码", "数量", "买入价", "当前价", "买入日期", "当前价值", "盈亏 (%)"]
        print(tabulate(table_data, headers=headers, tablefmt="grid", numalign="right"))

        if missing_price_warning:
            print("警告: 未能获取所有持仓的实时价格。")

        # Display totals if all prices were fetched
        if not missing_price_warning:
            total_profit_loss_abs = total_current_value - total_buy_value
            total_profit_loss_percent = (total_profit_loss_abs / total_buy_value) * 100 if total_buy_value > 0 else 0
            
            print(f"
总投资价值: {total_current_value:.2f}")
            print(f"总盈亏: {total_profit_loss_abs:.2f}")
            print(f"总盈亏 (%): {total_profit_loss_percent:.2f}%")

    # ... (rest of the class and main function) ...
```
**注意：** 上述实现中需要添加 `from tabulate import tabulate`。因此，还需要在环境中安装 `tabulate` 库：`pip install tabulate`。这将在下一步中通过 `run_shell_command` 进行。

- [ ] **Step 4: 安装 `tabulate` 库**

Run: `pip install tabulate`

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_portfolio_manager.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add portfolio_manager.py tests/test_portfolio_manager.py
git commit -m "feat: implement display_portfolio with real-time prices and totals"
```

