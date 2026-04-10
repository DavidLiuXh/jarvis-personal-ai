import { PortfolioService } from './portfolioService';
import { MarketContext } from './types';
import path from 'path';

async function run() {
  const service = new PortfolioService(process.cwd());
  
  // 模拟/抓取的实时市场数据 (基于 3/23 开盘前数据)
  const context: MarketContext = {
    spx_price: 6582.10, // 上周五收盘
    last_pce_rate: 0.028, // 上周五发布的最新 PCE (高于 0.027 阈值)
    vix_index: 24.5,
    is_major_event_pending: false
  };

  const advice = service.generateAdvice(context);
  console.log(advice);
}

run().catch(console.error);
