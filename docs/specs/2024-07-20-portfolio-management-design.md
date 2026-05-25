# Design Document: Portfolio Management Module

**Date:** 2024-07-20

**Author:** Jarvis

**Status:** Approved

## 1. Overview

This document outlines the design for a new Portfolio Management Module for the Personalized Investment Decision System. This module will provide functionalities to initialize, manage, and view a user's stock portfolio.

## 2. Requirements

- The system must allow users to manage their stock portfolio.
- Portfolio data must be persistently stored.
- The module should support the following operations:
    - **Add (add)** a new holding.
    - **Update (update)** an existing holding.
    - **Delete (delete)** an existing holding.
    - **View (view/display)** the current portfolio, including real-time valuation and profit/loss.
    - **Clear (clear)** all holdings from the portfolio.
- The module should be accessible via a command-line interface.

## 3. Design & Architecture

### 3.1. Architecture and Components

1.  **File Structure:**
    *   A new Python script, `portfolio_manager.py`, will be created to encapsulate all portfolio management logic.
    *   Portfolio data will be stored in a JSON file named `portfolio.json` in the project's root directory.

2.  **Core Components:**
    *   **`PortfolioManager` Class:** This class will be the core of the module.
        *   It will handle loading (`load_portfolio()`) and saving (`save_portfolio()`) the `portfolio.json` file.
        *   It will provide methods for all CRUD operations: `add_holding()`, `update_holding()`, `delete_holding()`, and `clear_portfolio()`.
        *   It will include a `display_portfolio()` method for viewing the portfolio status.
    *   **Data Fetching Integration:**
        *   The `PortfolioManager` will integrate with the existing `get_market_data` module to fetch real-time prices for the holdings, enabling the calculation of current value and profit/loss.

3.  **Command-Line Interface (CLI):**
    *   `portfolio_manager.py` will be executable from the command line.
    *   It will use Python's `argparse` library to handle commands and arguments (e.g., `python portfolio_manager.py add --code AAPL ...`).

### 3.2. Data Structure and Flow

1.  **`portfolio.json` Structure:**
    *   The file will contain a JSON array of holding objects.
    *   Each object will have the following structure:
        ```json
        {
            "code": "string",      // Stock/Index Ticker
            "quantity": "float",   // Number of shares
            "buy_price": "float",  // Price per share at purchase
            "buy_date": "string"   // Purchase date in "YYYY-MM-DD" format
        }
        ```

2.  **Data Flow:**
    *   **Initialization:** On startup, `PortfolioManager` loads data from `portfolio.json`. If the file doesn't exist, an empty portfolio is created in memory.
    *   **Modification (Add/Update/Delete/Clear):** Operations modify the in-memory portfolio data, and then the `save_portfolio()` method is immediately called to persist the changes to `portfolio.json`.
    *   **Display:** The `display_portfolio()` method will:
        1.  Get the list of tickers from the in-memory portfolio.
        2.  Call `get_market_data.adaptive_fetch_data()` to get the latest prices for these tickers.
        3.  Calculate the current value, profit/loss for each holding.
        4.  Format and print a summary table to the console.

### 3.3. Error Handling and Testing

1.  **Error Handling:**
    *   **File I/O:** Robust `try-except` blocks will manage file-related errors (`FileNotFoundError`, `json.JSONDecodeError`), providing user-friendly messages.
    *   **User Input Validation:** All CLI inputs (e.g., numbers for quantity/price, date format) will be validated.
    *   **Record Management:** Checks will be in place to prevent updating or deleting non-existent holdings.
    *   **API Errors:** The system will gracefully handle failures in fetching real-time price data, displaying "N/A" for the affected holdings without crashing.

2.  **Testing Strategy:**
    *   Unit tests will be written for each method in the `PortfolioManager` class.
    *   The `unittest.mock` library will be used to mock file system operations and API calls to `get_market_data` to ensure tests are isolated and repeatable.
    *   Tests will cover edge cases such as empty portfolios, invalid inputs, and boundary conditions.
