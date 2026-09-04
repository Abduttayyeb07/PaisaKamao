import { readFileSync } from 'fs';
import { resolve } from 'path';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline' | 'booting' | 'degraded';

export type TradeAction = 'BUY_STZIG' | 'SELL_STZIG';

export type DashboardTrade = {
  id: string;
  timestamp: string;
  action: TradeAction;
  intent: string;
  range: string;
  price: number;
  offerAsset: 'UZIG' | 'STZIG';
  offerAmount: number;
  receivedAsset: 'STZIG' | 'UZIG';
  receivedAmount: number;
  txHash?: string;
  estimated: boolean;
};

export type PricePoint = {
  timestamp: string;
  price: number;
};

type MetricsConfig = {
  poolContract: string;
  wsUrl: string;
  lowerTarget: number;
  upperTarget: number;
  cooldownMs: number;
  walletAddress?: string;
  zones: Array<{ label: string; min: number; max: number; sizeZig: number; orderId: string }>;
};

const MAX_TRADES = 250;
const MAX_PRICE_POINTS = 300;
const startedAt = new Date().toISOString();
const trades: DashboardTrade[] = [];
const priceHistory: PricePoint[] = [];
let config: MetricsConfig = {
  poolContract: '',
  wsUrl: '',
  lowerTarget: 0.99,
  upperTarget: 1.01,
  cooldownMs: 10000,
  zones: [],
};
let status: ConnectionStatus = 'booting';
let latestPrice: number | undefined;
let latestRawPrice: number | undefined;
let lastEventAt: string | undefined;
let lastEventLabel = 'Waiting for the first pool event';
let lastStzigReserve: string | undefined;
let lastUzigReserve: string | undefined;
let historyLoaded = false;
let tradeSequence = 0;
type RuntimeError = { timestamp: string; source: string; message: string };
const recentErrors: RuntimeError[] = [];

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normaliseHistoricalIntent(intent: string): TradeAction | undefined {
  if (intent === 'buyStzig') return 'BUY_STZIG';
  if (intent === 'buyZig') return 'SELL_STZIG';
  return undefined;
}

export function loadPersistedTradeHistory(): void {
  if (historyLoaded) return;
  historyLoaded = true;
  const configuredFile = process.env.TRADE_LOG_FILE || 'trade-history.log';
  const logPath = resolve(process.cwd(), configuredFile);

  try {
    const raw = readFileSync(logPath, 'utf8');
    const rows = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const row of rows) {
      const parts = row.split(',');
      if (parts.length < 6) continue;

      const action = normaliseHistoricalIntent(parts[3]);
      const price = parseNumber(parts[4]);
      const amount = parseNumber(parts[5]);
      if (!action || price <= 0 || amount <= 0) continue;

      const isBuy = action === 'BUY_STZIG';
      trades.push({
        id: 'history-' + String(++tradeSequence),
        timestamp: parts[0] || new Date(0).toISOString(),
        action,
        intent: parts[3],
        range: parts[2] || 'unknown',
        price,
        offerAsset: isBuy ? 'UZIG' : 'STZIG',
        offerAmount: amount,
        receivedAsset: isBuy ? 'STZIG' : 'UZIG',
        receivedAmount: isBuy ? amount / price : amount * price,
        txHash: parts[6] || undefined,
        estimated: true,
      });
    }
    trades.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    while (trades.length > MAX_TRADES) trades.shift();
  } catch {
    // A missing trade log is normal on first run.
  }
}

export function configureMetrics(next: MetricsConfig): void {
  config = next;
  loadPersistedTradeHistory();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function recordRuntimeError(source: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  const message = errorMessage(error);
  recentErrors.unshift({ timestamp, source, message });
  while (recentErrors.length > 10) recentErrors.pop();
  lastEventAt = timestamp;
  lastEventLabel = source + ': ' + message;
}

export function setConnectionStatus(next: ConnectionStatus): void {
  status = next;
  lastEventAt = new Date().toISOString();
  lastEventLabel =
    next === 'connected'
      ? 'Connected to Zigchain'
      : next === 'reconnecting'
        ? 'RPC connection lost; reconnecting'
        : next === 'offline'
          ? 'Dashboard is offline'
          : next === 'degraded'
            ? 'Bot is running with recent errors'
            : 'Starting bot';
}

export function recordPoolUpdate(input: {
  price: number;
  rawPrice: number;
  stzig: bigint;
  uzig: bigint;
}): void {
  latestPrice = input.price;
  latestRawPrice = input.rawPrice;
  lastStzigReserve = input.stzig.toString();
  lastUzigReserve = input.uzig.toString();
  lastEventAt = new Date().toISOString();
  lastEventLabel = 'Pool swap event received';
  priceHistory.push({ timestamp: lastEventAt, price: input.price });
  while (priceHistory.length > MAX_PRICE_POINTS) priceHistory.shift();
}

export function recordTrade(input: {
  action: TradeAction;
  intent: string;
  range: string;
  price: number;
  offerAsset: 'UZIG' | 'STZIG';
  offerAmount: number;
  receivedAsset: 'STZIG' | 'UZIG';
  receivedAmount: number;
  txHash: string;
  estimated?: boolean;
}): void {
  trades.push({
    id: 'live-' + String(++tradeSequence),
    timestamp: new Date().toISOString(),
    estimated: input.estimated ?? true,
    ...input,
  });
  while (trades.length > MAX_TRADES) trades.shift();
  lastEventAt = new Date().toISOString();
  lastEventLabel = input.action === 'BUY_STZIG' ? 'stZIG purchase confirmed' : 'stZIG sale confirmed';
}

function buildSummary() {
  let zigSpent = 0;
  let zigReceived = 0;
  let stzigBought = 0;
  let stzigSold = 0;
  let stzigBalance = 0;
  let costBasis = 0;
  let realizedPnl = 0;

  for (const trade of trades) {
    if (trade.action === 'BUY_STZIG') {
      zigSpent += trade.offerAmount;
      stzigBought += trade.receivedAmount;
      stzigBalance += trade.receivedAmount;
      costBasis += trade.offerAmount;
    } else {
      const averageCost = stzigBalance > 0 ? costBasis / stzigBalance : 0;
      zigReceived += trade.receivedAmount;
      stzigSold += trade.offerAmount;
      realizedPnl += trade.receivedAmount - trade.offerAmount * averageCost;
      stzigBalance -= trade.offerAmount;
      costBasis -= trade.offerAmount * averageCost;
      if (stzigBalance < 0) {
        stzigBalance = 0;
        costBasis = 0;
      }
    }
  }

  const markPrice = latestPrice ?? 0;
  const unrealizedPnl = stzigBalance * markPrice - costBasis;
  const feesExcluded = true;

  return {
    zigSpent,
    zigReceived,
    netZigFlow: zigReceived - zigSpent,
    stzigBought,
    stzigSold,
    stzigBalance,
    realizedPnl,
    unrealizedPnl,
    netPnl: realizedPnl + unrealizedPnl,
    transactionCount: trades.length,
    buyCount: trades.filter((trade) => trade.action === 'BUY_STZIG').length,
    sellCount: trades.filter((trade) => trade.action === 'SELL_STZIG').length,
    feesExcluded,
  };
}

export function getDashboardSnapshot() {
  loadPersistedTradeHistory();
  const summary = buildSummary();
  return {
    generatedAt: new Date().toISOString(),
    startedAt,
    status,
    latestPrice,
    latestRawPrice,
    lastEventAt,
    lastEventLabel,
    reserves: {
      stzig: lastStzigReserve,
      uzig: lastUzigReserve,
    },
    config: {
      ...config,
      walletAddress: config.walletAddress
        ? config.walletAddress.slice(0, 10) + '...' + config.walletAddress.slice(-6)
        : undefined,
    },
    summary,
    lastTrade: trades[trades.length - 1],
    trades: [...trades].reverse(),
    priceHistory: [...priceHistory],
    recentErrors: [...recentErrors],
  };
}
