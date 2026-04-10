import fs from 'fs';
import path from 'path';
import { Portfolio, MarketContext, Asset } from './types';

export class PortfolioService {
  private portfolioPath: string;

  constructor(baseDir: string) {
    this.portfolioPath = path.join(baseDir, 'investing', 'portfolio.json');
  }

  loadPortfolio(): Portfolio {
    const rawData = fs.readFileSync(this.portfolioPath, 'utf8');
    return JSON.parse(rawData);
  }

  generateAdvice(context: MarketContext): string {
    const portfolio = this.loadPortfolio();
    let advice = `--- JIMS 投资决策报告 [${new Date().toISOString()}] ---\n`;
    
    // 1. 防御审查 (Defense First)
    if (portfolio.risk_parameters.defense_first && context.last_pce_rate > portfolio.risk_parameters.pce_threshold_warning) {
      return advice + `[警告] 防御优先机制已触发！PCE 通胀率 (${(context.last_pce_rate * 100).toFixed(1)}%) 高于阈值。建议暂停所有加仓操作，保持现金观察。`;
    }

    // 2. 标配检视
    advice += `[当前市场] SPX: ${context.spx_price.toFixed(2)} | VIX: ${context.vix_index}\n`;
    
    // 3. 2:5:3 阶梯逻辑分析
    const actions: string[] = [];
    
    // SPX 触发点逻辑 (假设基准 6700)
    if (context.spx_price <= 6500) {
      actions.push(`[买入指令] SPX 触及 6500 点关键位。根据 2:5:3 策略，建议执行第一笔试探性买入 (20% 剩余资金)。`);
    } else {
      actions.push(`[观望] 标普 500 尚未触及 6500 点加仓红线，当前持币观望。`);
    }

    // 卫星仓位特种逻辑 (以 Visa 为例)
    const visa = portfolio.assets.find(a => a.ticker === 'V');
    if (visa && context.spx_price < 6650) { // 简单模拟 Visa 在大盘弱势时的吸引力
        actions.push(`[特别关注] Visa 目前处于 52 周低点附近，作为卫星仓位可优先考虑。`);
    }

    return advice + actions.join('\n');
  }
}
