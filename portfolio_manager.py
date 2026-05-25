import pandas as pd
from datetime import datetime
import os

PORTFOLIO_FILE = 'portfolio.csv'


def adaptive_fetch_data(symbols):
    # This will be mocked in tests
    pass

class PortfolioManager:
    def __init__(self, portfolio_file=PORTFOLIO_FILE):
        self.portfolio_file = portfolio_file
        self.portfolio = self._load_portfolio()

    def _load_portfolio(self):
        if os.path.exists(self.portfolio_file):
            try:
                return pd.read_csv(self.portfolio_file)
            except pd.errors.EmptyDataError:
                # Handle case where CSV exists but is empty
                return pd.DataFrame(columns=['symbol', 'quantity', 'purchase_price', 'purchase_date'])
        return pd.DataFrame(columns=['symbol', 'quantity', 'purchase_price', 'purchase_date'])

    def _save_portfolio(self):
        self.portfolio.to_csv(self.portfolio_file, index=False)

    def add_holding(self, symbol, quantity, purchase_price, purchase_date):
        # Validate inputs
        if not isinstance(quantity, (int, float)) or quantity <= 0:
            raise ValueError("Quantity must be a positive number.")
        if not isinstance(purchase_price, (int, float)) or purchase_price <= 0:
            raise ValueError("Buy price must be a positive number.")
        try:
            datetime.strptime(purchase_date, "%Y-%m-%d")
        except ValueError:
            raise ValueError("Invalid date format. Please use YYYY-MM-DD.")
        if datetime.strptime(purchase_date, "%Y-%m-%d").date() > datetime.now().date():
            raise ValueError("Buy date cannot be in the future.")

        existing_holding_index = self.portfolio[(self.portfolio['symbol'] == symbol) & (self.portfolio['purchase_date'] == purchase_date)].index

        if not existing_holding_index.empty:
            # Update existing holding
            idx = existing_holding_index[0]
            old_quantity = self.portfolio.loc[idx, 'quantity']
            old_purchase_price = self.portfolio.loc[idx, 'purchase_price']

            total_value_old = old_quantity * old_purchase_price
            total_value_new = quantity * purchase_price

            new_total_quantity = old_quantity + quantity
            new_average_price = (total_value_old + total_value_new) / new_total_quantity

            self.portfolio.loc[idx, 'quantity'] = new_total_quantity
            self.portfolio.loc[idx, 'purchase_price'] = new_average_price
        else:
            # Add new holding
            new_holding = pd.DataFrame([{
                'symbol': symbol,
                'quantity': quantity,
                'purchase_price': purchase_price,
                'purchase_date': purchase_date
            }])
            self.portfolio = pd.concat([self.portfolio, new_holding], ignore_index=True)

        self._save_portfolio()

    def delete_holding(self, symbol, purchase_date):
        initial_len = len(self.portfolio)
        self.portfolio = self.portfolio[~((self.portfolio['symbol'] == symbol) & (self.portfolio['purchase_date'] == purchase_date))]
        if len(self.portfolio) == initial_len:
            raise ValueError(f"Holding for {symbol} on {purchase_date} not found.")
        self._save_portfolio()

    def update_holding(self, symbol, purchase_date, new_quantity=None, new_buy_price=None):
        holding_found = False
        for idx, row in self.portfolio.iterrows():
            if row['symbol'] == symbol and row['purchase_date'] == purchase_date:
                holding_found = True
                
                if new_quantity is not None:
                    if not isinstance(new_quantity, (int, float)) or new_quantity <= 0:
                        raise ValueError("New quantity must be a positive number if provided.")
                    self.portfolio.loc[idx, 'quantity'] = new_quantity
                
                if new_buy_price is not None:
                    if not isinstance(new_buy_price, (int, float)) or new_buy_price <= 0:
                        raise ValueError("New buy price must be a positive number if provided.")
                    self.portfolio.loc[idx, 'purchase_price'] = new_buy_price
                break
        
        if not holding_found:
            raise ValueError(f"Holding for {symbol} on {purchase_date} not found.")
            
        self._save_portfolio()

    def clear_portfolio(self):
        self.portfolio = pd.DataFrame(columns=['symbol', 'quantity', 'purchase_price', 'purchase_date'])
        self._save_portfolio()

    def get_portfolio_value(self, current_prices):
        total_value = 0
        for _, row in self.portfolio.iterrows():
            symbol = row['symbol']
            quantity = row['quantity']
            if symbol in current_prices:
                total_value += quantity * current_prices[symbol]
        return total_value

    def display_portfolio(self):
        output_lines = []
        output_lines.append("--- 当前投资组合 ---")
        if self.portfolio.empty:
            output_lines.append("投资组合为空。")
            final_output_str = NEWLINE.join(output_lines)
            print(final_output_str)
            with open("debug_display_output.txt", "w", encoding="utf-8") as f:
                f.write(final_output_str)
            return

        symbols = self.portfolio['symbol'].unique().tolist()
        fetched_data_list = adaptive_fetch_data(symbols) # This will be mocked

        current_prices = {}
        for df in fetched_data_list:
            if not df.empty:
                for _, row in df.iterrows():
                    current_prices[row['code']] = row['close']

        display_data = []
        total_market_value = 0
        total_profit_loss = 0
        total_purchase_value = 0

        for _, row in self.portfolio.iterrows():
            symbol = row['symbol']
            quantity = row['quantity']
            purchase_price = row['purchase_price']
            purchase_date = row['purchase_date']

            current_price = current_prices.get(symbol)
            
            if current_price is not None:
                market_value = quantity * current_price
                profit_loss = (current_price - purchase_price) * quantity
                profit_loss_pct = (profit_loss / (quantity * purchase_price) * 100) if (quantity * purchase_price) else 0
                
                total_market_value += market_value
                total_profit_loss += profit_loss
                total_purchase_value += (quantity * purchase_price)

                display_data.append([
                    symbol,
                    f"{quantity:.2f}",
                    f"{purchase_price:.2f}",
                    f"{current_price:.2f}",
                    purchase_date,
                    f"{market_value:.2f}",
                    f"{profit_loss_pct:.2f}"
                ])
            else:
                display_data.append([
                    symbol,
                    f"{quantity:.2f}",
                    f"{purchase_price:.2f}",
                    "N/A",
                    purchase_date,
                    "N/A",
                    "N/A"
                ])

        # Manually construct markdown table
        headers = ['代码', '数量', '买入价', '当前价', '买入日期', '当前价值', '盈亏 (%)']
        
        # Determine column widths for proper markdown table alignment
        col_widths = [len(header) for header in headers]
        for row in display_data:
            for i, item in enumerate(row):
                col_widths[i] = max(col_widths[i], len(str(item)))

        # Header line
        header_line = "| " + " | ".join(headers) + " |"
        output_lines.append(header_line)

        # Separator line (align left for strings, right for numbers)
        separator_parts = []
        for i, header in enumerate(headers):
            if i in [1, 2, 3, 5, 6]: # Quantity, prices, values, profit/loss are numbers, align right
                separator_parts.append(f":-{'':->{col_widths[i]}}:")
            else: # Other columns (Symbol, Date) align left
                separator_parts.append(f":-{'-':<{col_widths[i]}}-:")
        output_lines.append("|" + "|".join(separator_parts) + "|")

        # Data rows
        for row in display_data:
            formatted_row = []
            for i, item in enumerate(row):
                if i in [1, 2, 3, 5, 6]: # Numbers, align right
                    formatted_row.append(f"{item:>{col_widths[i]}}")
                else: # Strings, align left
                    formatted_row.append(f"{item:<{col_widths[i]}}")
            output_lines.append("| " + " | ".join(formatted_row) + " |")

        total_profit_loss_percentage = (total_profit_loss / total_purchase_value * 100) if total_purchase_value else 0

        output_lines.append(f"总投资价值: {total_market_value:,.2f}")
        output_lines.append(f"总盈亏: {total_profit_loss:,.2f}")
        output_lines.append(f"总盈亏 (%): {total_profit_loss_percentage:,.2f}")

        if len(current_prices) < len(symbols):
            output_lines.append("警告: 未能获取所有持仓的实时价格。")
        
        final_output_str = NEWLINE.join(output_lines)
        print(final_output_str)

        with open("debug_display_output.txt", "w", encoding="utf-8") as f:
            f.write(final_output_str)

    def get_portfolio_summary(self, current_prices):
        summary = []
        total_portfolio_value = 0
        for _, row in self.portfolio.iterrows():
            symbol = row['symbol']
            quantity = row['quantity']
            purchase_price = row['purchase_price']
            purchase_date = row['purchase_date']

            current_price = current_prices.get(symbol, purchase_price) # Use purchase price if current not available
            market_value = quantity * current_price
            profit_loss = (current_price - purchase_price) * quantity
            
            total_portfolio_value += market_value

            summary.append({
                'Symbol': symbol,
                'Quantity': quantity,
                'Purchase Price': f"${purchase_price:,.2f}",
                'Current Price': f"${current_price:,.2f}",
                'Market Value': f"${market_value:,.2f}",
                'Profit/Loss': f"${profit_loss:,.2f}"
            })
        
        df_summary = pd.DataFrame(summary)
        
        # Add total portfolio value
        if not df_summary.empty:
            total_row = pd.DataFrame([['Total', '', '', '', f"${total_portfolio_value:,.2f}", '']], columns=df_summary.columns)
            df_summary = pd.concat([df_summary, total_row], ignore_index=True)
            
        return df_summary
