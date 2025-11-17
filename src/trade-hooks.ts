import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { SigningCosmWasmClient, CosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { GasPrice, coins } from '@cosmjs/stargate';
import { notifyTrade } from './telegram';

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

const SIZE_TIERS = (process.env.SIZE_TIERS || '1,2,3')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);

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
const WALLET_MAX_RATIO = Math.max(0, Number(process.env.WALLET_MAX_RATIO || '0.02'));
const POOL_MAX_RATIO = Math.max(0, Number(process.env.POOL_MAX_RATIO || '0.015'));
const MAX_SLIPPAGE = Number(process.env.MAX_SLIPPAGE || process.env.MAX_SPREAD || '0.002');
const MAX_SPREAD = Math.min(Math.max(MAX_SLIPPAGE, 0), 1);
const USE_SIM_SIZING = String(process.env.USE_SIM_SIZING || 'true').toLowerCase() === 'true';
const MAX_POOL_IMPACT_BPS = Number(process.env.MAX_POOL_IMPACT_BPS || '500'); // 5%
const DEBUG_SIM = String(process.env.DEBUG_SIM || 'false').toLowerCase() === 'true';
const RATIO_SCALE = 1_000_000n;
const FIXED_TRADE_ZIG = Number(process.env.FIXED_TRADE_ZIG || '1');
const SCALE_FLOAT = Number(RATIO_SCALE);
const WALLET_RATIO_SCALE =
  WALLET_MAX_RATIO > 0 ? BigInt(Math.max(1, Math.round(WALLET_MAX_RATIO * SCALE_FLOAT))) : 0n;
const POOL_RATIO_SCALE =
  POOL_MAX_RATIO > 0 ? BigInt(Math.max(1, Math.round(POOL_MAX_RATIO * SCALE_FLOAT))) : 0n;
const WALLET_BALANCE_API = (process.env.WALLET_BALANCE_API ||
  'https://zigchain-mainnet-api.wickhub.cc/cosmos/bank/v1beta1/balances').replace(/\/+$/, '');
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

type WalletBalances = { stzig: bigint; uzig: bigint };

function toBigInt(value?: string): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

async function fetchBalancesFromApi(address: string): Promise<WalletBalances | null> {
  if (!address || !WALLET_BALANCE_API) return null;
  try {
    const fetchFn = await getBalanceFetch();
    const res = await fetchFn(`${WALLET_BALANCE_API}/${address}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`status ${res.status}`);
    }
    const data = await res.json();
    const list: Array<{ denom: string; amount: string }> = Array.isArray(data?.balances) ? data.balances : [];
    const st = toBigInt(list.find((b) => b.denom === STZIG_DENOM)?.amount);
    const uz = toBigInt(list.find((b) => b.denom === UZIG_DENOM)?.amount);
    const found = list.some((b) => b.denom === STZIG_DENOM || b.denom === UZIG_DENOM);
    if (!found) return null;
    return { stzig: st, uzig: uz };
  } catch (e) {
    console.warn('[trade-hooks] wallet balance REST fetch failed:', e instanceof Error ? e.message : e);
    return null;
  }
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

async function getWalletBalances(): Promise<WalletBalances> {
  const fallback = {
    stzig: toUnits(Number(process.env.WALLET_STZIG || '0'), STZIG_EXP),
    uzig: toUnits(Number(process.env.WALLET_UZIG || '0'), UZIG_EXP),
  };
  const address = WALLET_ADDRESS;
  if (address) {
    const apiBalances = await fetchBalancesFromApi(address);
    if (apiBalances) return apiBalances;
  }
  try {
    if (!PRIVATE_KEY) return fallback;
    const { client, address: signerAddress } = await getClient();
    const [st, uz] = await Promise.all([
      client.getBalance(signerAddress, STZIG_DENOM).catch(() => ({ amount: '0' })),
      client.getBalance(signerAddress, UZIG_DENOM).catch(() => ({ amount: '0' })),
    ]);
    return {
      stzig: toBigInt(st.amount) || fallback.stzig,
      uzig: toBigInt(uz.amount) || fallback.uzig,
    };
  } catch (e) {
    console.warn('[trade-hooks] wallet balance fetch failed:', e instanceof Error ? e.message : e);
  }
  return fallback;
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

function minPositive(...vals: bigint[]): bigint {
  const candidates = vals.filter((n) => n > 0n);
  if (!candidates.length) return 0n;
  return candidates.reduce((prev, curr) => (curr < prev ? curr : prev));
}

function computeRatioCap(side: 'sell' | 'buy', ctx: TradeContext, walletBalances: WalletBalances): bigint {
  if (WALLET_RATIO_SCALE <= 0n || POOL_RATIO_SCALE <= 0n) return 0n;
  const denomBalance = side === 'sell' ? ctx.stzig : ctx.uzig;
  const walletBalance = side === 'sell' ? walletBalances.stzig : walletBalances.uzig;
  const poolCap = (denomBalance * POOL_RATIO_SCALE) / RATIO_SCALE;
  const walletCap = (walletBalance * WALLET_RATIO_SCALE) / RATIO_SCALE;
  const cap = poolCap < walletCap ? poolCap : walletCap;
  return cap > 0n ? cap : 0n;
}

function impactCapForSide(side: 'sell' | 'buy', ctx: TradeContext): bigint {
  if (MAX_POOL_IMPACT_BPS <= 0) return 0n;
  const denomBalance = side === 'sell' ? ctx.stzig : ctx.uzig;
  return (denomBalance * BigInt(MAX_POOL_IMPACT_BPS)) / 10000n;
}

function capOffer(
  side: 'sell' | 'buy',
  ctx: TradeContext,
  walletBalances: WalletBalances,
  amount: bigint
): bigint {
  if (amount <= 0n) return 0n;
  const ratioCap = computeRatioCap(side, ctx, walletBalances);
  const impactCap = impactCapForSide(side, ctx);
  if (ratioCap <= 0n || impactCap <= 0n) return 0n;
  const safeCap = ratioCap < impactCap ? ratioCap : impactCap;
  return amount > safeCap ? safeCap : amount;
}

async function sizeWithSimulation(
  side: 'sell' | 'buy',
  ctx: TradeContext,
  walletBalances: WalletBalances,
  desiredAmount?: bigint
): Promise<{ offerAmount: string; projectedPrice: number } | null> {
  const target = side === 'sell' ? ctx.upperTarget : ctx.lowerTarget;
  if (!Number.isFinite(target)) return null;
  const eps = 1e-5;

  const minTier = SIZE_TIERS[0] || 50;
  const maxTier = SIZE_TIERS[SIZE_TIERS.length - 1] || minTier;
  let minAmt = side === 'sell' ? toUnits(minTier, STZIG_EXP) : toUnits(minTier, UZIG_EXP);
  const maxTierAmt = side === 'sell' ? toUnits(maxTier, STZIG_EXP) : toUnits(maxTier, UZIG_EXP);
  const ratioCap = computeRatioCap(side, ctx, walletBalances);
  const impactCap = impactCapForSide(side, ctx);
  if (ratioCap <= 0n || impactCap <= 0n) return null;
  const limit = desiredAmount && desiredAmount > 0n
    ? minPositive(maxTierAmt, ratioCap, impactCap, desiredAmount)
    : minPositive(maxTierAmt, ratioCap, impactCap);
  if (limit <= 0n) return null;
  if (desiredAmount && desiredAmount > 0n && desiredAmount < minAmt) minAmt = desiredAmount;

  const effectiveMin = desiredAmount && desiredAmount > 0n && desiredAmount < minAmt ? desiredAmount : minAmt;
  let lo = effectiveMin <= limit ? effectiveMin : limit;
  let hi = limit;
  let best = lo;
  let bestProj = Number.POSITIVE_INFINITY;
  let bestDist = Number.POSITIVE_INFINITY;
  let sawValid = false;

  for (let i = 0; i < 14 && lo <= hi; i++) {
    const mid = (lo + hi) / 2n;
    const offer = mid === 0n ? 1n : clamp(mid, lo, hi);
    let proj: number;
    try {
      if (side === 'sell') {
        const dy = await simulateSwapQuery(STZIG_DENOM, offer.toString());
        proj = Number(ctx.uzig - dy) / Number(ctx.stzig + offer);
        if (Number.isNaN(proj) || !isFinite(proj)) throw new Error('bad proj');
        if (proj > target) {
          lo = offer + 1n;
        } else {
          hi = offer - 1n;
        }
      } else {
        const s = await simulateSwapQuery(UZIG_DENOM, offer.toString());
        proj = Number(ctx.uzig + offer) / Number(ctx.stzig - s);
        if (Number.isNaN(proj) || !isFinite(proj)) throw new Error('bad proj');
        if (proj < target) {
          lo = offer + 1n;
        } else {
          hi = offer - 1n;
        }
      }
      sawValid = true;
      const dist = Math.abs(proj - target);
      if (dist < bestDist) {
        bestDist = dist;
        bestProj = proj;
        best = offer;
      }
      if (DEBUG_SIM) {
        console.log(`[sim] side=${side} offer=${offer.toString()} proj=${proj.toFixed(6)} target=${target}`);
      }
      if (Math.abs(proj - target) <= eps) {
        best = offer;
        bestProj = proj;
        break;
      }
    } catch (e) {
      if (DEBUG_SIM) {
        console.warn(`[sim] step error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }
  }

  if (!sawValid || !isFinite(bestProj)) {
    if (DEBUG_SIM) {
      console.warn('[sim] no valid projection; will fall back to tier sizing');
    }
    return null;
  }
  const clamped = clamp(best, minAmt, limit);
  if (clamped <= 0n) return null;
  return { offerAmount: clamped.toString(), projectedPrice: bestProj };
}

export async function onBuy(ctx: TradeContext): Promise<void> {
  // Buy STZIG with UZIG (offer = uzig)
  const walletBalances = await getWalletBalances();
  const desiredZig = ctx.desiredZigAmount ?? FIXED_TRADE_ZIG;
  const desiredUnits = toUnits(desiredZig, UZIG_EXP);
  let offerAmount: string | undefined;
  let simPrice: number | undefined;
  let fallbackReason = '';
  const rangeNote = ctx.rangeLabel ? ` zone=${ctx.rangeLabel}` : '';
  if (USE_SIM_SIZING) {
    const sized = await sizeWithSimulation('buy', ctx, walletBalances, desiredUnits);
    if (sized && isFinite(sized.projectedPrice) && sized.offerAmount) {
      offerAmount = sized.offerAmount;
      simPrice = sized.projectedPrice;
    }
  }
  if (!offerAmount) {
    const capped = capOffer('buy', ctx, walletBalances, desiredUnits);
    if (capped <= 0n) {
      console.warn('[BUY] skipped; capped offer is 0 (wallet or pool ratio limit)');
      return;
    }
    offerAmount = capped.toString();
    fallbackReason = 'sim not available; using fixed size';
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
    const displayOfferZig = formatZigAmount(offerAmount, UZIG_EXP);
    const detailLines = [
      `✅ BUY STZIG Signal (Zone: ${ctx.rangeLabel ?? 'unknown'})`,
      `Price: ${ctx.priceUzigPerStzig.toFixed(6)}`,
      simPrice ? `Sim Price: ~${simPrice.toFixed(6)}` : undefined,
      fallbackReason ? `Note: ${fallbackReason}` : undefined,
      `Offer: ${displayOfferZig} ZIG`,
      `Tx: ${tx}`,
    ]
      .filter(Boolean)
      .join('\n');
    await notifyTrade(detailLines, { txHash: tx });
  } catch (e) {
    console.error('[BUY] failed:', e instanceof Error ? e.message : e);
    const errLine = [
      '❌ BUY failed',
      `Price: ${ctx.priceUzigPerStzig.toFixed(6)}${rangeNote}`,
      `Offer: ${formatZigAmount(offerAmount, UZIG_EXP)} ZIG`,
      `Error: ${e instanceof Error ? e.message : String(e)}`,
    ].join('\n');
    await notifyTrade(errLine);
  }
}

export async function onSell(ctx: TradeContext): Promise<void> {
  // Sell STZIG for UZIG (offer = stzig)
  const walletBalances = await getWalletBalances();
  const desiredZig = ctx.desiredZigAmount ?? FIXED_TRADE_ZIG;
  const desiredUnits = toUnits(desiredZig, STZIG_EXP);
  let offerAmount: string | undefined;
  let simPrice: number | undefined;
  let fallbackReason = '';
  const rangeNote = ctx.rangeLabel ? ` zone=${ctx.rangeLabel}` : '';
  if (USE_SIM_SIZING) {
    const sized = await sizeWithSimulation('sell', ctx, walletBalances, desiredUnits);
    if (sized && isFinite(sized.projectedPrice) && sized.offerAmount) {
      offerAmount = sized.offerAmount;
      simPrice = sized.projectedPrice;
    }
  }
  if (!offerAmount) {
    const capped = capOffer('sell', ctx, walletBalances, desiredUnits);
    if (capped <= 0n) {
      console.warn('[SELL] skipped; capped offer is 0 (wallet or pool ratio limit)');
      return;
    }
    offerAmount = capped.toString();
    fallbackReason = 'sim not available; using fixed size';
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
    const displayOfferZig = formatZigAmount(offerAmount, STZIG_EXP);
    const detailLines = [
      `✅ SELL STZIG Signal (Zone: ${ctx.rangeLabel ?? 'unknown'})`,
      `Price: ${ctx.priceUzigPerStzig.toFixed(6)}`,
      simPrice ? `Sim Price: ~${simPrice.toFixed(6)}` : undefined,
      fallbackReason ? `Note: ${fallbackReason}` : undefined,
      `Offer: ${displayOfferZig} ZIG`,
      `Tx: ${tx}`,
    ]
      .filter(Boolean)
      .join('\n');
    await notifyTrade(detailLines, { txHash: tx });
  } catch (e) {
    console.error('[SELL] failed:', e instanceof Error ? e.message : e);
    const errLine = [
      '❌ SELL failed',
      `Price: ${ctx.priceUzigPerStzig.toFixed(6)}${rangeNote}`,
      `Offer: ${formatZigAmount(offerAmount, STZIG_EXP)} ZIG`,
      `Error: ${e instanceof Error ? e.message : String(e)}`,
    ].join('\n');
    await notifyTrade(errLine);
  }
}
