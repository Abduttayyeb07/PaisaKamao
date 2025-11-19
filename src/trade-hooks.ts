import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { SigningCosmWasmClient, CosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { GasPrice, coins } from '@cosmjs/stargate';
import { notifyTrade } from './telegram';
import { promises as fs, readFileSync } from 'fs';
import { dirname, resolve } from 'path';

export type TradeContext = {
  priceUzigPerStzig: number;
  rawPriceUzigPerStzig?: number;
  lowerTarget: number;
  upperTarget: number;
  stzig: bigint;
  uzig: bigint;
  walletAddress?: string;
  tradeIntent?: 'buyZig' | 'buyStzig';
  rangeLabel?: string;
  desiredZigAmount?: number;
  orderId?: string;
};

const HTTP_RPC = process.env.HTTP_RPC || 'https://zigchain-mainnet-rpc-sanatry-01.wickhub.cc';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '';
const FEE_DENOM = process.env.FEE_DENOM || 'uzig';
const GAS_PRICE = Number(process.env.GAS_PRICE || '0.025');

const POOL_CONTRACT =
  process.env.POOL_CONTRACT || 'zig1h72z8ptvcdqvuvy2lqanupwtextjmjmktj2ejgne2padxk0z8zds48shzq';
const STZIG_DENOM =
  process.env.STZIG_DENOM ||
  'coin.zig109f7g2rzl2aqee7z6gffn8kfe9cpqx0mjkk7ethmx8m2hq4xpe9snmaam2.stzig';
const UZIG_DENOM = process.env.UZIG_DENOM || 'uzig';

const STZIG_EXP = Number(process.env.STZIG_EXP || '6');
const UZIG_EXP = Number(process.env.UZIG_EXP || '6');

const RAW_UPPER_TARGET = Number(process.env.UPPER_TARGET || '1.01');
const RAW_LOWER_TARGET = Number(process.env.LOWER_TARGET || '0.99');
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
const NORMALIZED_BAND = normalizeBand(RAW_LOWER_TARGET, RAW_UPPER_TARGET);
const PRICE_CENTER = (NORMALIZED_BAND.lower + NORMALIZED_BAND.upper) / 2;
const MAX_SLIPPAGE = Number(process.env.MAX_SLIPPAGE || process.env.MAX_SPREAD || '0.002');
const MAX_SPREAD = Math.min(Math.max(MAX_SLIPPAGE, 0), 1);
const USE_SIM_SIZING = String(process.env.USE_SIM_SIZING || 'true').toLowerCase() === 'true';
const DEBUG_SIM = String(process.env.DEBUG_SIM || 'false').toLowerCase() === 'true';
const FIXED_TRADE_ZIG = Number(process.env.FIXED_TRADE_ZIG || '1');
const TRADE_LOG_FILE = process.env.TRADE_LOG_FILE || 'trade-history.log';
const TRADE_CSV_FILE = process.env.TRADE_CSV_FILE || 'trade-actions.csv';
const ZONE_STATE_FILE = process.env.ZONE_STATE_FILE || 'zone-state.json';
const ZONE_STATE_PATH = resolve(process.cwd(), ZONE_STATE_FILE);
const zoneExecutionHours: Record<string, string> = {};

function loadZoneState() {
  try {
    const data = readFileSync(ZONE_STATE_PATH, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object') Object.assign(zoneExecutionHours, parsed);
  } catch {
    // ignore missing file
  }
}
loadZoneState();
type BalanceFetchLike = (input: string, init?: any) => Promise<any>;
let balanceFetchRef: BalanceFetchLike | null = null;
async function getBalanceFetch(): Promise<BalanceFetchLike> {
  if (balanceFetchRef) return balanceFetchRef;
  const gf = (globalThis as any).fetch as BalanceFetchLike | undefined;
  if (gf) {
    balanceFetchRef = gf;
    return gf;
  }
  const mod = await import('node-fetch');
  balanceFetchRef = (mod.default || mod) as BalanceFetchLike;
  return balanceFetchRef;
}

function getHourBucket(date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  return `${year}-${month}-${day}T${hour}`;
}

function splitBucket(bucket: string) {
  const [date, time] = bucket.split('T');
  return { date: date || bucket, slot: time ? `T${time}` : '' };
}

function checkZoneAllowed(zoneLabel?: string) {
  const bucket = getHourBucket();
  if (!zoneLabel) return { allowed: true, bucket };
  return { allowed: zoneExecutionHours[zoneLabel] !== bucket, bucket };
}

async function persistZoneState() {
  try {
    await fs.mkdir(dirname(ZONE_STATE_PATH), { recursive: true });
    await fs.writeFile(ZONE_STATE_PATH, JSON.stringify(zoneExecutionHours), 'utf8');
  } catch {
    // ignore
  }
}

async function markZoneExecuted(zoneLabel: string | undefined, bucket: string) {
  if (!zoneLabel) return;
  zoneExecutionHours[zoneLabel] = bucket;
  await persistZoneState();
}

type TradeLogEntry = {
  timestamp: string;
  bucket: string;
  zone: string;
  intent: string;
  price: number;
  amount: string;
  txHash?: string;
};

async function appendTradeLog(entry: TradeLogEntry) {
  try {
    const fullPath = resolve(process.cwd(), TRADE_LOG_FILE);
    await fs.mkdir(dirname(fullPath), { recursive: true });
    const line = `${entry.timestamp},${entry.bucket},${entry.zone},${entry.intent},${entry.price},${entry.amount},${entry.txHash ?? ''}\n`;
    await fs.appendFile(fullPath, line, 'utf8');
  } catch (e) {
    console.warn('[trade-hooks] failed to write trade log:', e instanceof Error ? e.message : e);
  }
}

async function appendActionCsv(action: string, range: string, price: number, txHash: string) {
  try {
    const fullPath = resolve(process.cwd(), TRADE_CSV_FILE);
    await fs.mkdir(dirname(fullPath), { recursive: true });
    let needHeader = false;
    try {
      const stat = await fs.stat(fullPath);
      if (stat.size === 0) needHeader = true;
    } catch {
      needHeader = true;
    }
    if (needHeader) {
      await fs.appendFile(fullPath, 'Action,Range,Price,Tx\n', 'utf8');
    }
    const line = `"${action}","${range}",${price.toFixed(6)},"https://www.zigscan.org/tx/${txHash}"\n`;
    await fs.appendFile(fullPath, line, 'utf8');
  } catch (e) {
    console.warn('[trade-hooks] failed to write action csv:', e instanceof Error ? e.message : e);
  }
}

let signerClientPromise: Promise<{
  client: SigningCosmWasmClient;
  address: string;
}> | null = null;
let queryClientPromise: Promise<CosmWasmClient> | null = null;

function ensurePkHex(pk: string): string {
  const v = pk.startsWith('0x') ? pk.slice(2) : pk;
  if (!/^[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error('PRIVATE_KEY must be 32-byte hex string');
  }
  return v;
}

async function getClient(): Promise<{ client: SigningCosmWasmClient; address: string }> {
  if (!signerClientPromise) {
    signerClientPromise = (async () => {
      if (!PRIVATE_KEY) throw new Error('Missing PRIVATE_KEY in env');
      const pk = ensurePkHex(PRIVATE_KEY);
      const wallet = await DirectSecp256k1Wallet.fromKey(Buffer.from(pk, 'hex'), 'zig');
      const [{ address }] = await wallet.getAccounts();
      const gasPrice = GasPrice.fromString(`${GAS_PRICE}${FEE_DENOM}`);
      const client = await SigningCosmWasmClient.connectWithSigner(HTTP_RPC, wallet, { gasPrice });
      return { client, address };
    })();
  }
  return signerClientPromise;
}

async function getQueryClient(): Promise<CosmWasmClient> {
  if (!queryClientPromise) {
    queryClientPromise = CosmWasmClient.connect(HTTP_RPC);
  }
  return queryClientPromise;
}

function formatZigAmount(amountStr: string, decimals: number): string {
  const amount = BigInt(amountStr);
  const scale = 10n ** BigInt(decimals);
  const integer = amount / scale;
  const fraction = amount % scale;
  if (fraction === 0n) return integer.toString();
  let frac = fraction.toString().padStart(decimals, '0');
  frac = frac.replace(/0+$/g, '');
  return `${integer.toString()}.${frac}`;
}

function toBaseUnits(amount: number, decimals: number): string {
  const scaled = Math.round(amount * 10 ** decimals);
  return String(scaled);
}

async function executeSwap(offerDenom: string, offerAmount: string) {
  if (!POOL_CONTRACT) throw new Error('Missing POOL_CONTRACT');
  const { client, address } = await getClient();

  const msg = {
    swap: {
      max_spread: MAX_SPREAD.toFixed(3),
      offer_asset: {
        amount: offerAmount,
        info: { native_token: { denom: offerDenom } },
      },
      to: address,
    },
  } as const;

  const funds = coins(offerAmount, offerDenom);
  const res = await client.execute(address, POOL_CONTRACT, msg, 'auto', undefined, funds);
  return res.transactionHash;
}

type SimResult = { return_amount: string } | { returnAmount: string };

async function simulateSwapQuery(offerDenom: string, offerAmount: string): Promise<bigint> {
  const qc = await getQueryClient();
  const msg = {
    simulation: {
      offer_asset: {
        amount: offerAmount,
        info: { native_token: { denom: offerDenom } },
      },
    },
  } as const;
  // @ts-ignore dynamic type
  const res: SimResult = await qc.queryContractSmart(POOL_CONTRACT, msg);
  const val = (res as any).return_amount ?? (res as any).returnAmount;
  if (!val) throw new Error('simulation missing return_amount');
  return BigInt(val);
}

function clamp(n: bigint, lo: bigint, hi: bigint): bigint {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toUnits(n: number, decimals: number): bigint {
  return BigInt(Math.round(n * 10 ** decimals));
}

function fromUnits(n: bigint, decimals: number): number {
  return Number(n) / 10 ** decimals;
}

async function simulateProjection(
  side: 'sell' | 'buy',
  ctx: TradeContext,
  offerAmount: bigint
): Promise<number | undefined> {
  try {
    if (side === 'sell') {
      const dy = await simulateSwapQuery(STZIG_DENOM, offerAmount.toString());
      const denomSt = ctx.stzig + offerAmount;
      if (denomSt === 0n) return undefined;
      return Number(ctx.uzig - dy) / Number(denomSt);
    }
    const stzigReceived = await simulateSwapQuery(UZIG_DENOM, offerAmount.toString());
    const denomSt = ctx.stzig - stzigReceived;
    if (denomSt === 0n) return undefined;
    return Number(ctx.uzig + offerAmount) / Number(denomSt);
  } catch (e) {
    if (DEBUG_SIM) {
      console.warn('[sim] projection failed:', e instanceof Error ? e.message : String(e));
    }
    return undefined;
  }
}

export async function onBuy(ctx: TradeContext): Promise<void> {
  // Buy STZIG with UZIG (offer = uzig)
  const desiredZig = ctx.desiredZigAmount ?? FIXED_TRADE_ZIG;
  if (desiredZig <= 0) {
    console.warn('[BUY] desired zig amount must be >0');
    return;
  }
  const desiredUnits = toUnits(desiredZig, UZIG_EXP);
  const zoneLabel = ctx.rangeLabel ?? 'unknown';
  const { allowed, bucket } = checkZoneAllowed(zoneLabel);
  if (!allowed) {
    console.log(`[BUY] skipping ${zoneLabel}; already traded in bucket ${bucket}`);
    return;
  }
  const { date: bucketDate, slot: bucketSlot } = splitBucket(bucket);
  const rangeNote = ctx.rangeLabel ? ` zone=${ctx.rangeLabel}` : '';
  const offerAmount = desiredUnits.toString();
  let simPrice: number | undefined;
  let note = '';
  if (USE_SIM_SIZING) {
    simPrice = await simulateProjection('buy', ctx, desiredUnits);
    if (!simPrice) {
      note = 'Sim projection unavailable; executing desired amount';
    }
  }
  console.log(
    `[BUY] price=${ctx.priceUzigPerStzig.toFixed(6)}${rangeNote} offer ${offerAmount} UZIG`
  );
  if (!PRIVATE_KEY) {
    console.log('[BUY] dry run: missing PRIVATE_KEY, swap skipped.');
    return;
  }
  try {
    const tx = await executeSwap(UZIG_DENOM, offerAmount);
    console.log(`[BUY] submitted tx=${tx}`);
    const { slot: slotLabel } = splitBucket(bucket);
    const detailLines = [
      `📈 BUY STZIG — Order ${ctx.orderId ?? '??'} (${ctx.rangeLabel ?? 'unknown'})`,
      `Live: ${ctx.priceUzigPerStzig.toFixed(6)}`,
      simPrice ? `Sim: ~${simPrice.toFixed(6)}` : undefined,
      `Offer: ${formatZigAmount(offerAmount, UZIG_EXP)} ZIG`,
      `Slot: ${slotLabel} — ${bucketDate}`,
      `Tx: https://www.zigscan.org/tx/${tx}`,
    ]
      .filter(Boolean)
      .join('\n');
    await notifyTrade(detailLines, { txHash: tx });
    markZoneExecuted(zoneLabel, bucket);
    await appendTradeLog({
      timestamp: new Date().toISOString(),
      bucket,
      zone: zoneLabel,
      intent: ctx.tradeIntent ?? 'buyStzig',
      price: ctx.priceUzigPerStzig,
      amount: formatZigAmount(offerAmount, UZIG_EXP),
      txHash: tx,
    });
    await appendActionCsv(
      `✅ BUY STZIG Signal (Order ${ctx.orderId ?? '??'})`,
      ctx.rangeLabel ?? 'unknown',
      ctx.priceUzigPerStzig,
      tx
    );
  } catch (e) {
    console.error('[BUY] failed:', e instanceof Error ? e.message : e);
    const errLine = [
      `❌ BUY failed (Order ${ctx.orderId ?? '??'})`,
      `Price: ${ctx.priceUzigPerStzig.toFixed(6)}${rangeNote}`,
      `Date: ${bucketDate}`,
      bucketSlot ? `Time slot: ${bucketSlot}` : undefined,
      `Offer: ${formatZigAmount(offerAmount, UZIG_EXP)} ZIG`,
      `Error: ${e instanceof Error ? e.message : String(e)}`,
    ]
      .filter(Boolean)
      .join('\n');
    await notifyTrade(errLine);
  }
}

export async function onSell(ctx: TradeContext): Promise<void> {
  // Sell STZIG for UZIG (offer = stzig)
  const desiredZig = ctx.desiredZigAmount ?? FIXED_TRADE_ZIG;
  if (desiredZig <= 0) {
    console.warn('[SELL] desired zig amount must be >0');
    return;
  }
  const desiredUnits = toUnits(desiredZig, STZIG_EXP);
  const zoneLabel = ctx.rangeLabel ?? 'unknown';
  const { allowed, bucket } = checkZoneAllowed(zoneLabel);
  if (!allowed) {
    console.log(`[SELL] skipping ${zoneLabel}; already traded in bucket ${bucket}`);
    return;
  }
  const { date: bucketDate, slot: bucketSlot } = splitBucket(bucket);
  const rangeNote = ctx.rangeLabel ? ` zone=${ctx.rangeLabel}` : '';
  const offerAmount = desiredUnits.toString();
  let simPrice: number | undefined;
  let note = '';
  if (USE_SIM_SIZING) {
    simPrice = await simulateProjection('sell', ctx, desiredUnits);
    if (!simPrice) {
      note = 'Sim projection unavailable; executing desired amount';
    }
  }
  console.log(
    `[SELL] price=${ctx.priceUzigPerStzig.toFixed(6)}${rangeNote} offer ${offerAmount} STZIG`
  );
  if (!PRIVATE_KEY) {
    console.log('[SELL] dry run: missing PRIVATE_KEY, swap skipped.');
    return;
  }
  try {
    const tx = await executeSwap(STZIG_DENOM, offerAmount);
    console.log(`[SELL] submitted tx=${tx}`);
    const { slot: slotLabel } = splitBucket(bucket);
    const detailLines = [
      `📉 SELL STZIG — Order ${ctx.orderId ?? '??'} (${ctx.rangeLabel ?? 'unknown'})`,
      `Live: ${ctx.priceUzigPerStzig.toFixed(6)}`,
      simPrice ? `Sim: ~${simPrice.toFixed(6)}` : undefined,
      `Offer: ${formatZigAmount(offerAmount, STZIG_EXP)} ZIG`,
      `Slot: ${slotLabel} — ${bucketDate}`,
      `Tx: https://www.zigscan.org/tx/${tx}`,
    ]
      .filter(Boolean)
      .join('\n');
    await notifyTrade(detailLines, { txHash: tx });
    await markZoneExecuted(zoneLabel, bucket);
    await appendTradeLog({
      timestamp: new Date().toISOString(),
      bucket,
      zone: zoneLabel,
      intent: ctx.tradeIntent ?? 'buyZig',
      price: ctx.priceUzigPerStzig,
      amount: formatZigAmount(offerAmount, STZIG_EXP),
      txHash: tx,
    });
    await appendActionCsv(
      `✅ SELL STZIG Signal (Order ${ctx.orderId ?? '??'})`,
      ctx.rangeLabel ?? 'unknown',
      ctx.priceUzigPerStzig,
      tx
    );
  } catch (e) {
    console.error('[SELL] failed:', e instanceof Error ? e.message : e);
    const errLine = [
      `❌ SELL failed (Order ${ctx.orderId ?? '??'})`,
      `Price: ${ctx.priceUzigPerStzig.toFixed(6)}${rangeNote}`,
      `Date: ${bucketDate}`,
      bucketSlot ? `Time slot: ${bucketSlot}` : undefined,
      `Offer: ${formatZigAmount(offerAmount, STZIG_EXP)} ZIG`,
      `Error: ${e instanceof Error ? e.message : String(e)}`,
    ]
      .filter(Boolean)
      .join('\n');
    await notifyTrade(errLine);
  }
}
