import { describe, it, expect } from 'vitest';
import { Portfolio, MarketContext } from './types';

// 模拟决策函数
function evaluateTradeAction(portfolio: Portfolio, context: MarketContext) {
  // 核心逻辑：防御优先
  if (portfolio.risk_parameters.defense_first) {
    // 如果 PCE 通胀高于警告值，挂起所有买入
    if (context.last_pce_rate > portfolio.risk_parameters.pce_threshold_warning) {
      return { action: 'HOLD', reason: 'High PCE Inflation (Defense First)' };
    }
  }

  // 标普 500 触发位：6500
  if (context.spx_price <= 6500) {
    return { action: 'BUY_PROBING', amount: portfolio.cash_reserve * 0.20 };
  }

  return { action: 'WAIT', reason: 'Market not at signal point' };
}

describe('JIMS 投资决策逻辑测试 (防御优先)', () => {
  const samplePortfolio: Portfolio = {
    last_updated: '2026-03-23T14:00:00Z',
    currency: 'USD',
    assets: [],
    cash_reserve: 1000,
    risk_parameters: {
      defense_first: true,
      max_drawdown_tolerance: 0.20,
      pce_threshold_warning: 0.027
    }
  };

  it('当 SPX 跌到 6500 但 PCE 爆表时，应执行 HOLD (防御优先)', () => {
    const marketContext: MarketContext = {
      spx_price: 6490, // 触碰到加仓点
      last_pce_rate: 0.028, // PCE 爆表 (高于 0.027)
      vix_index: 25,
      is_major_event_pending: false
    };

    const result = evaluateTradeAction(samplePortfolio, marketContext);
    expect(result.action).toBe('HOLD');
    expect(result.reason).toContain('High PCE');
  });

  it('当 SPX 跌到 6500 且 PCE 正常时，应执行 BUY_PROBING (左侧试探)', () => {
    const marketContext: MarketContext = {
      spx_price: 6490,
      last_pce_rate: 0.024, // PCE 正常
      vix_index: 25,
      is_major_event_pending: false
    };

    const result = evaluateTradeAction(samplePortfolio, marketContext);
    expect(result.action).toBe('BUY_PROBING');
    expect(result.amount).toBe(200);
  });
});
