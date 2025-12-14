import 'dotenv/config';
import WebSocket from 'ws';
import { onBuy, onSell } from './trade-hooks';
import { startTelegramBot } from './telegram';

// ---------- CONFIG ----------
const RPC_BASE = process.env.RPC_BASE || 'wss://zigchain-mainnet-rpc-sanatry-01.wickhub.cc';
const WS_URL = RPC_BASE.endsWith('/websocket') ? RPC_BASE : `${RPC_BASE}/websocket`;

const POOL_CONTRACT =
  process.env.POOL_CONTRACT ||
  'zig1h72z8ptvcdqvuvy2lqanupwtextjmjmktj2ejgne2padxk0z8zds48shzq';

const STZIG_DENOM =
  process.env.STZIG_DENOM ||
  'coin.zig109f7g2rzl2aqee7z6gffn8kfe9cpqx0mjkk7ethmx8m2hq4xpe9snmaam2.stzig';

const UZIG_DENOM = process.env.UZIG_DENOM || 'uzig';

// Query: Tx events from this contract with action=swap
const QUERY = `tm.event='Tx' AND wasm._contract_address='${POOL_CONTRACT}' AND wasm.action='swap'`;

// Optional extras for triggering
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || undefined;
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || '10000');
const PRICE_SMOOTHING_ALPHA = Number(process.env.PRICE_SMOOTHING_ALPHA || '0.25');
const SMOOTHING_ALPHA =
  Number.isFinite(PRICE_SMOOTHING_ALPHA) && PRICE_SMOOTHING_ALPHA >= 0
    ? Math.min(PRICE_SMOOTHING_ALPHA, 1)
    : 0.25;


const BUY_ZIG_TO = Number(process.env.BUY_ZIG_TO || '1.038');
const SELL_STZIG_FROM = Number(process.env.SELL_STZIG_FROM || '0.991');
const TRADE_UNIT = Number(process.env.TRADE_UNIT || '1');
const TRADE_UNIT_SCALE = Number.isFinite(TRADE_UNIT) && TRADE_UNIT > 0 ? TRADE_UNIT : 1;

const BAND_EPSILON = 0.0001;
function normalizeBand(lower: number, upper: number) {
  const safeUpper = Number.isFinite(upper) ? upper : 1.01;
  const safeLower = Number.isFinite(lower) ? lower : 0.99;
  let hi = safeUpper;
  let lo = safeLower;
  if (!(hi > lo)) {
    const mid = (hi + lo) / 2;
    hi = mid + 0.0005;
    lo = mid - 0.0005;
  }
  if (lo < 0) lo = 0;
  if (hi <= lo) hi = lo + BAND_EPSILON;
  return { lower: lo, upper: hi };
}

const { lower: LOWER_TARGET, upper: UPPER_TARGET } = normalizeBand(SELL_STZIG_FROM, BUY_ZIG_TO);

type TradeIntent = 'buyZig' | 'buyStzig';
type TradeZone = {
  min: number;
  max: number;
  sizeZig: number;
  label: string;
  orderId: string;
};

const BUY_ZIG_ZONES: TradeZone[] = [
  { min: 1.020, max: 1.021, sizeZig: 10000, label: 'BUY_ZIG 1.020-1.021', orderId: 'O1' },
  { min: 1.021, max: 1.022, sizeZig: 10001, label: 'BUY_ZIG 1.021-1.022', orderId: 'O2' },
  { min: 1.022, max: 1.023, sizeZig: 15002, label: 'BUY_ZIG 1.022-1.023', orderId: 'O3' },
  { min: 1.023, max: 1.024, sizeZig: 15003, label: 'BUY_ZIG 1.023-1.024', orderId: 'P' },
  { min: 1.024, max: 1.025, sizeZig: 25004, label: 'BUY_ZIG 1.024-1.025', orderId: 'Q' },
  { min: 1.025, max: 1.026, sizeZig: 25005, label: 'BUY_ZIG 1.025-1.026', orderId: 'R' },
  { min: 1.026, max: 1.027, sizeZig: 25006, label: 'BUY_ZIG 1.026-1.027', orderId: 'S' },
  { min: 1.027, max: 1.028, sizeZig: 25007, label: 'BUY_ZIG 1.027-1.028', orderId: 'T' },
  { min: 1.028, max: 1.029, sizeZig: 30008, label: 'BUY_ZIG 1.028-1.029', orderId: 'U' },
  { min: 1.029, max: 1.030, sizeZig: 30009, label: 'BUY_ZIG 1.029-1.030', orderId: 'V' },
  { min: 1.030, max: 1.040, sizeZig: 50009, label: 'BUY_ZIG 1.030-1.040', orderId: 'X1' },
  { min: 1.040, max: 1.060, sizeZig: 80009, label: 'BUY_ZIG 1.040-1.060', orderId: 'X2' },
  { min: 1.060, max: 1.090, sizeZig: 90009, label: 'BUY_ZIG 1.060-1.090', orderId: 'X3' },
  { min: 1.090, max: 1.200, sizeZig: 99009, label: 'BUY_ZIG 1.090-1.200', orderId: 'X4' },
];


const BUY_STZIG_ZONES: TradeZone[] = [
  { min: 1.016, max: 1.017, sizeZig: 10000, label: 'BUY_STZIG 1.016-1.017', orderId: 'N5' },
  { min: 1.015, max: 1.016, sizeZig: 10000, label: 'BUY_STZIG 1.015-1.016', orderId: 'N4' },
  { min: 1.014, max: 1.015, sizeZig: 10000, label: 'BUY_STZIG 1.014-1.015', orderId: 'N3' },
  { min: 1.013, max: 1.014, sizeZig: 10000, label: 'BUY_STZIG 1.013-1.014', orderId: 'N2' },
  { min: 1.012, max: 1.013, sizeZig: 10000, label: 'BUY_STZIG 1.012-1.013', orderId: 'N1' },

  { min: 1.0116, max: 1.012, sizeZig: 10000, label: 'BUY_STZIG 1.0116-1.0120', orderId: 'A' },
  { min: 1.0101, max: 1.011, sizeZig: 25000, label: 'BUY_STZIG 1.0101-1.0110', orderId: 'B' },
  { min: 1.009, max: 1.010, sizeZig: 26000, label: 'BUY_STZIG 1.0090-1.0100', orderId: 'C' },
  { min: 1.007, max: 1.008, sizeZig: 27000, label: 'BUY_STZIG 1.0070-1.0080', orderId: 'D' },
  { min: 1.006, max: 1.007, sizeZig: 28000, label: 'BUY_STZIG 1.0060-1.0070', orderId: 'E' },
  { min: 1.005, max: 1.006, sizeZig: 29000, label: 'BUY_STZIG 1.0050-1.0060', orderId: 'F' },
  { min: 1.004, max: 1.005, sizeZig: 30000, label: 'BUY_STZIG 1.0040-1.0050', orderId: 'G' },
  { min: 1.003, max: 1.004, sizeZig: 32000, label: 'BUY_STZIG 1.0030-1.0040', orderId: 'H' },
  { min: 1.002, max: 1.003, sizeZig: 35000, label: 'BUY_STZIG 1.0020-1.0030', orderId: 'I' },
  { min: 1.001, max: 1.002, sizeZig: 38000, label: 'BUY_STZIG 1.0010-1.0020', orderId: 'J' },
  { min: 1.000, max: 1.001, sizeZig: 42000, label: 'BUY_STZIG 1.0000-1.0010', orderId: 'K' },

  { min: 0.990, max: 1.000, sizeZig: 45000, label: 'BUY_STZIG 0.990-1.000', orderId: 'L' },
  { min: 0.900, max: 0.990, sizeZig: 50000, label: 'BUY_STZIG 0.900-0.990', orderId: 'M' },
  { min: 0.810, max: 0.900, sizeZig: 100000, label: 'BUY_STZIG 0.810-0.900', orderId: 'M2' },
];

const EPSILON = 1e-9;

function zoneContains(price: number, zone: TradeZone): boolean {
  return price + EPSILON >= zone.min && price - EPSILON <= zone.max;
}

function determineTradeZone(price: number):
  | { type: TradeIntent; index: number; zone: TradeZone }
  | undefined {
  for (let i = 0; i < BUY_ZIG_ZONES.length; i++) {
    if (zoneContains(price, BUY_ZIG_ZONES[i])) {
      return { type: 'buyZig', index: i, zone: BUY_ZIG_ZONES[i] };
    }
  }
  for (let i = 0; i < BUY_STZIG_ZONES.length; i++) {
    if (zoneContains(price, BUY_STZIG_ZONES[i])) {
      return { type: 'buyStzig', index: i, zone: BUY_STZIG_ZONES[i] };
    }
  }
  return undefined;
}

// ---------- UTIL ----------
function b64ToStr(b64: string): string {
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return b64;
  }
}
function looksBase64(s: string): boolean {
  return /^[A-Za-z0-9+/=]+$/.test(s) && !s.includes(':') && s.length % 4 === 0;
}

// Parse "denomA:amountA,denomB:amountB"
function parseReserves(resStr: string): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const part of resStr.split(',')) {
    const [denom, amt] = part.split(':');
    if (!denom || !amt) continue;
    out[denom.trim()] = BigInt(amt.trim());
  }
  return out;
}

// Compute a/b with integer precision scaling
function ratio(a: bigint, b: bigint, scale = 1_000_000n): number {
  if (b === 0n) return NaN;
  const scaled = (a * scale) / b;
  return Number(scaled) / Number(scale);
}

// Extract "wasm.reserves" attribute from multiple Tendermint shapes
function extractReservesFromMsg(msg: any): string | undefined {
  // Shape 1: result.events (Tendermint WS plain)
  const events = msg?.result?.events;
  if (events && typeof events === 'object') {
    const vals: string[] | undefined = events['wasm.reserves'];
    if (vals && vals.length) {
      const raw = vals[vals.length - 1];
      return looksBase64(raw) ? b64ToStr(raw) : raw;
    }
  }

  // Shape 2: result.data.value.TxResult.result.events (attributes base64)
  const evArr = msg?.result?.data?.value?.TxResult?.result?.events;
  if (Array.isArray(evArr)) {
    for (const ev of evArr) {
      if (ev?.type === 'wasm' && Array.isArray(ev.attributes)) {
        for (const attr of ev.attributes) {
          const k = b64ToStr(attr.key ?? '');
          const v = b64ToStr(attr.value ?? '');
          if (k === 'reserves') return v;
        }
      }
    }
  }
  return undefined;
}

// ---------- WS CLIENT ----------
type PendingReq = { id: string; description: string; sentAt: number };

class TendermintWS {
  private ws?: WebSocket;
  private nextId = 1;
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private connected = false;
  private pending: Map<string, PendingReq> = new Map();
  private lastTradeAt = 0;
  private latestPrice: number | undefined = undefined;
  private smoothedPrice: number | undefined = undefined;
  private lastLoggedPrice: number | undefined = undefined;
  private readonly smoothingAlpha = SMOOTHING_ALPHA;
  private lastZone: { type: TradeIntent; index: number } | undefined = undefined;

  constructor(private url: string) {}

  start() {
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.on('error', (err) => this.onError(err));
    this.ws.on('close', () => this.onClose());
  }

  private onOpen() {
    this.connected = true;
    console.log('Connected:', this.url);
    this.subscribe(QUERY);
    this.startHeartbeat();
  }

  private onMessage(data: WebSocket.RawData) {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.id && this.pending.has(String(msg.id))) {
      this.pending.delete(String(msg.id));
    }

    const reservesStr = extractReservesFromMsg(msg);
    if (reservesStr) {
      this.handleReserves(reservesStr);
    }
  }

  private onError(err: any) {
    console.error('WS error:', err?.message || err);
  }

  private onClose() {
    this.connected = false;
    this.stopHeartbeat();
    console.log('Disconnected. Reconnecting in 2s...');
    clearTimeout(this.reconnectTimer as any);
    this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }

  private send(obj: any, description = 'request') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = String(this.nextId++);
    const payload = { jsonrpc: '2.0', id, ...obj };
    this.ws.send(JSON.stringify(payload));
    this.pending.set(id, { id, description, sentAt: Date.now() });
  }

  private subscribe(query: string) {
    console.log('Subscribing:', query);
    this.send({ method: 'subscribe', params: { query } }, 'subscribe');
  }

  private startHeartbeat() {
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      this.send({ method: 'subscribe', params: { query: "tm.event='NewBlock'" } }, 'heartbeat');
      const now = Date.now();
      for (const [id, p] of this.pending) {
        if (now - p.sentAt > 10_000) this.pending.delete(id);
      }
    }, 15_000);
  }

  private stopHeartbeat() {
    clearInterval(this.pingTimer as any);
  }

  private applySmoothing(value: number): number {
    if (!Number.isFinite(value)) return value;
    if (this.smoothedPrice === undefined || this.smoothingAlpha <= 0) {
      this.smoothedPrice = value;
    } else {
      this.smoothedPrice += this.smoothingAlpha * (value - this.smoothedPrice);
    }
    return this.smoothedPrice;
  }

  private handleReserves(reservesStr: string) {
    try {
      const m = parseReserves(reservesStr);
      const stzigAmt = m[STZIG_DENOM] ?? m['stzig'] ?? Object.entries(m).find(([k]) => k.endsWith('.stzig'))?.[1];
      const uzigAmt = m[UZIG_DENOM] ?? m['uzig'];

      if (stzigAmt === undefined || uzigAmt === undefined) {
        console.log('Reserves (unparsed):', reservesStr);
        return;
      }

      const rawPrice = ratio(uzigAmt, stzigAmt);
      if (!Number.isFinite(rawPrice)) {
        console.warn('Invalid price:', rawPrice);
        return;
      }
      const filteredPrice = this.applySmoothing(rawPrice);
      this.latestPrice = filteredPrice;

      const shouldLog =
        this.lastLoggedPrice === undefined || Math.abs(filteredPrice - this.lastLoggedPrice) >= 0.00001;
      if (shouldLog) {
        this.lastLoggedPrice = filteredPrice;
        console.log(
          `[swap] stzig=${stzigAmt.toString()} | uzig=${uzigAmt.toString()} | price raw=${rawPrice.toFixed(
            6
          )} filtered=${filteredPrice.toFixed(6)}`
        );
      }

      const now = Date.now();
      const zone = determineTradeZone(filteredPrice);
      if (!zone) {
        this.lastZone = undefined;
        return;
      }
      if (this.lastZone && this.lastZone.type === zone.type && this.lastZone.index === zone.index) {
        return;
      }
      if (COOLDOWN_MS > 0 && now - this.lastTradeAt < COOLDOWN_MS) return;

      const ctx = {
        priceUzigPerStzig: filteredPrice,
        rawPriceUzigPerStzig: rawPrice,
        lowerTarget: LOWER_TARGET,
        upperTarget: UPPER_TARGET,
        stzig: stzigAmt,
        uzig: uzigAmt,
        walletAddress: WALLET_ADDRESS,
        tradeIntent: zone.type,
        rangeLabel: zone.zone.label,
        desiredZigAmount: zone.zone.sizeZig * TRADE_UNIT_SCALE,
        orderId: zone.zone.orderId,
      };

      this.lastTradeAt = now;
      this.lastZone = { type: zone.type, index: zone.index };

      if (zone.type === 'buyZig') {
        void Promise.resolve(onSell(ctx)).catch((e) => console.error('onSell error:', e));
      } else {
        void Promise.resolve(onBuy(ctx)).catch((e) => console.error('onBuy error:', e));
      }
    } catch (e) {
      console.error('Parse error:', e, 'raw=', reservesStr);
    }
  }
}

// ---------- RUN ----------
console.log('RPC WS:', WS_URL);
console.log('POOL:', POOL_CONTRACT);
console.log('DENOMS:', { STZIG_DENOM, UZIG_DENOM });

const bot = new TendermintWS(WS_URL);
// start telegram polling, provide live ratio getter and threshold getter
startTelegramBot(
  () => (bot as any).latestPrice as number | undefined,
  () => `${LOWER_TARGET.toFixed(6)} - ${UPPER_TARGET.toFixed(6)}`
);
bot.start();
