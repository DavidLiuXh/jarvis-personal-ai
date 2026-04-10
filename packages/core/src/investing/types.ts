export interface Asset {
  ticker: string;
  name: string;
  shares: number;
  cost_basis: number;
  target_weight: number;
  type: 'core' | 'satellite';
}

export interface Portfolio {
  last_updated: string;
  currency: string;
  assets: Asset[];
  cash_reserve: number;
  risk_parameters: {
    defense_first: boolean;
    max_drawdown_tolerance: number;
    pce_threshold_warning: number;
  };
}

export interface MarketContext {
  spx_price: number;
  last_pce_rate: number;
  vix_index: number;
  is_major_event_pending: boolean;
}
