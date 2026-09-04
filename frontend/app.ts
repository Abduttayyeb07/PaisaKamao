type TradeAction = 'BUY_STZIG' | 'SELL_STZIG';

type Trade = {
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

type Snapshot = {
  generatedAt: string;
  startedAt: string;
  status: 'connected' | 'reconnecting' | 'offline' | 'booting' | 'degraded';
  latestPrice?: number;
  latestRawPrice?: number;
  lastEventAt?: string;
  lastEventLabel: string;
  reserves: { stzig?: string; uzig?: string };
  config: {
    poolContract: string;
    wsUrl: string;
    lowerTarget: number;
    upperTarget: number;
    cooldownMs: number;
    walletAddress?: string;
    zones: Array<{ label: string; min: number; max: number; sizeZig: number; orderId: string }>;
  };
  summary: {
    zigSpent: number;
    zigReceived: number;
    netZigFlow: number;
    stzigBought: number;
    stzigSold: number;
    stzigBalance: number;
    realizedPnl: number;
    unrealizedPnl: number;
    netPnl: number;
    transactionCount: number;
    buyCount: number;
    sellCount: number;
    feesExcluded: boolean;
  };
  lastTrade?: Trade;
  trades: Trade[];
  priceHistory: Array<{ timestamp: string; price: number }>;
  recentErrors: Array<{ timestamp: string; source: string; message: string }>;
};

type Zone = Snapshot['config']['zones'][number];
type TriggerState = 'inside' | 'below' | 'above' | 'waiting';
type TriggerWatch = { zone: Zone; state: TriggerState; distance?: number; boundary?: number };
const $ = <T extends Element>(selector: string): T => document.querySelector(selector) as T;
// Null-safe variant for optional markup that may not be present in index.html
const $opt = <T extends Element>(selector: string): T | null => document.querySelector(selector) as T | null;
let lastSnapshot: Snapshot | undefined;
let loading = false;

const numberFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatAmount(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 1000000) return (value / 1000000).toFixed(2) + 'M';
  if (abs >= 1000) return (value / 1000).toFixed(2) + 'K';
  return formatAmount(value);
}

function formatPrice(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '' : value.toFixed(6);
}

function formatTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function signed(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  return (value >= 0 ? '+' : '') + formatAmount(value, digits);
}

function pnlClass(value: number | undefined): string {
  return value !== undefined && value >= 0 ? 'positive' : 'negative';
}

function shortHash(hash?: string): string {
  return hash ? hash.slice(0, 7) + '..' + hash.slice(-5) : '';
}

function elapsed(startedAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return days + 'd ' + hours + 'h';
  if (hours) return hours + 'h ' + minutes + 'm';
  return minutes + 'm';
}

function renderChart(snapshot: Snapshot): string {
  const width = 900;
  const height = 290;
  const left = 54;
  const right = 18;
  const top = 22;
  const bottom = 34;
  const points = snapshot.priceHistory.slice(-180);
  const current = snapshot.latestPrice ?? (points.length ? points[points.length - 1].price : undefined);
  const values = points.map((point) => point.price).concat([
    snapshot.config.lowerTarget,
    snapshot.config.upperTarget,
  ]);
  if (current !== undefined) values.push(current);
  const minValue = Math.min.apply(null, values.length ? values : [0.98]);
  const maxValue = Math.max.apply(null, values.length ? values : [1.05]);
  const padding = Math.max((maxValue - minValue) * 0.16, 0.001);
  const min = minValue - padding;
  const max = maxValue + padding;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const x = (index: number) => left + (points.length <= 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
  const y = (value: number) => top + ((max - value) / (max - min)) * innerHeight;
  const linePoints = points.map((point, index) => x(index).toFixed(1) + ',' + y(point.price).toFixed(1)).join(' ');
  const bandY = y(snapshot.config.upperTarget);
  const bandHeight = Math.max(1, y(snapshot.config.lowerTarget) - bandY);
  const gridLines = [0, 1, 2, 3].map((index) => {
    const gridY = top + (index / 3) * innerHeight;
    const value = max - (index / 3) * (max - min);
    return '<line x1="' + left + '" y1="' + gridY.toFixed(1) + '" x2="' + (width - right) + '" y2="' + gridY.toFixed(1) + '" class="chart-grid"/>' +
      '<text x="' + (left - 10) + '" y="' + (gridY + 4).toFixed(1) + '" text-anchor="end" class="chart-label">' + value.toFixed(4) + '</text>';
  }).join('');
  const targetLabels =
    '<text x="' + (width - right - 2) + '" y="' + (bandY - 7).toFixed(1) + '" text-anchor="end" class="chart-target upper">upper ' + snapshot.config.upperTarget.toFixed(4) + '</text>' +
    '<text x="' + (width - right - 2) + '" y="' + (bandY + bandHeight + 16).toFixed(1) + '" text-anchor="end" class="chart-target lower">lower ' + snapshot.config.lowerTarget.toFixed(4) + '</text>';
  const empty = points.length === 0
    ? '<text x="' + width / 2 + '" y="' + height / 2 + '" text-anchor="middle" class="chart-empty">Waiting for live pool events</text>'
    : '';
  return '<svg class="ratio-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Live stZIG to ZIG ratio chart">' +
    '<rect x="' + left + '" y="' + bandY.toFixed(1) + '" width="' + innerWidth + '" height="' + bandHeight.toFixed(1) + '" class="target-band"/>' +
    gridLines +
    '<polyline points="' + linePoints + '" class="ratio-line"/>' +
    (current !== undefined ? '<circle cx="' + x(Math.max(points.length - 1, 0)).toFixed(1) + '" cy="' + y(current).toFixed(1) + '" r="4.5" class="ratio-dot"/>' : '') +
    targetLabels + empty +
    '</svg>';
}

function classifyZone(zone: Zone): { action: string; tone: 'buy' | 'sell' } {
  if (zone.label.indexOf('BUY_STZIG') === 0) return { action: 'Buy stZIG', tone: 'buy' };
  return { action: 'Buy ZIG', tone: 'sell' };
}

function getTriggerWatch(snapshot: Snapshot): TriggerWatch | undefined {
  const zones = snapshot.config.zones;
  if (!zones.length) return undefined;
  const price = snapshot.latestPrice;
  if (price === undefined || !Number.isFinite(price)) {
    return { zone: zones[0], state: 'waiting' };
  }
  return zones
    .map((zone) => {
      if (price >= zone.min && price <= zone.max) {
        return { zone, state: 'inside' as const, distance: 0, boundary: price };
      }
      if (price < zone.min) {
        return { zone, state: 'below' as const, distance: zone.min - price, boundary: zone.min };
      }
      return { zone, state: 'above' as const, distance: price - zone.max, boundary: zone.max };
    })
    .sort((left, right) => left.distance - right.distance)[0];
}

function formatDistance(distance: number | undefined, current: number | undefined): string {
  if (distance === undefined || !Number.isFinite(distance)) return '--';
  if (distance === 0) return '0.000000 (ready)';
  const percent = current && Number.isFinite(current) ? (distance / current) * 100 : 0;
  return distance.toFixed(6) + ' (' + percent.toFixed(3) + '%)';
}

function updateTriggerWatch(snapshot: Snapshot): void {
  const watch = getTriggerWatch(snapshot);
  const current = snapshot.latestPrice;
  if (!watch) {
    $('#watchStatus').textContent = 'No zones';
    $('#watchStatus').className = 'watch-status waiting';
    $('#watchActionLabel').textContent = 'No active trigger';
    $('#watchActionLabel').className = 'watch-action-label';
    $('#watchZone').textContent = '--';
    $('#watchReason').textContent = 'No trading zones are configured.';
    $('#watchDistance').textContent = '--';
    $('#watchSize').textContent = '--';
    $('#watchBoundary').textContent = '--';
    $('#watchOrder').textContent = '--';
    return;
  }
  const meta = classifyZone(watch.zone);
  const isReady = watch.state === 'inside';
  const status = watch.state === 'waiting' ? 'Waiting' : isReady ? 'Ready' : 'Watching';
  const reason = watch.state === 'waiting'
    ? 'Waiting for a live pool ratio before selecting the nearest trigger.'
    : isReady
      ? 'Current ratio is inside this configured trigger zone.'
      : watch.state === 'below'
        ? 'Current ratio is below this zone. Watching the lower boundary.'
        : 'Current ratio is above this zone. Watching the upper boundary.';

  $('#watchStatus').textContent = status;
  $('#watchStatus').className = 'watch-status ' + (isReady ? 'ready' : watch.state === 'waiting' ? 'waiting' : 'watching');
  $('#watchActionLabel').textContent = meta.action;
  $('#watchActionLabel').className = 'watch-action-label ' + meta.tone;
  $('#watchZone').textContent = watch.zone.min.toFixed(4) + ' - ' + watch.zone.max.toFixed(4);
  $('#watchReason').textContent = reason;
  $('#watchDistance').textContent = formatDistance(watch.distance, current);
  $('#watchSize').textContent = formatAmount(watch.zone.sizeZig, 0) + ' ZIG';
  $('#watchBoundary').textContent = watch.boundary === undefined ? '--' : watch.boundary.toFixed(6);
  $('#watchOrder').textContent = watch.zone.orderId;
}
function renderZones(snapshot: Snapshot): string {
  const nearest = getTriggerWatch(snapshot);
  if (!snapshot.config.zones.length) {
    return '<div class="empty-copy">No trading zones configured.</div>';
  }
  return snapshot.config.zones.map((zone) => {
    const isBuyStzig = zone.label.indexOf('BUY_STZIG') === 0;
    const stateClass = nearest?.zone.orderId === zone.orderId ? ' nearest ' + nearest.state : '';
    return '<div class="zone-row' + stateClass + '">' +
      '<span class="zone-swatch ' + (isBuyStzig ? 'buy' : 'sell') + '"></span>' +
      '<div class="zone-copy"><strong>' + escapeHtml(zone.label) + '</strong><span>Order ' + escapeHtml(zone.orderId) + '</span></div>' +
      '<div class="zone-size">' + formatAmount(zone.sizeZig, 0) + '<small> ZIG</small></div>' +
      '</div>';
  }).join('');
}

function renderTrades(snapshot: Snapshot): string {
  if (!snapshot.trades.length) {
    return '<tr><td colspan="6"><div class="empty-state compact"><div class="empty-icon"></div><strong>No confirmed trades yet</strong><span>Successful swaps will appear here as the bot runs.</span></div></td></tr>';
  }
  return snapshot.trades.slice(0, 5).map((trade) => {
    const isBuy = trade.action === 'BUY_STZIG';
    const actionLabel = isBuy ? 'Buy stZIG' : 'Sell stZIG';
    const counter = formatAmount(trade.receivedAmount) + ' ' + trade.receivedAsset;
    return '<tr>' +
      '<td><div class="trade-action"><span class="action-icon ' + (isBuy ? 'buy' : 'sell') + '">' + (isBuy ? 'B' : 'S') + '</span><div><strong>' + actionLabel + '</strong><small>' + escapeHtml(trade.range) + '</small></div></div></td>' +
      '<td class="mono">' + formatPrice(trade.price) + '</td>' +
      '<td class="mono">' + formatAmount(trade.offerAmount) + ' ' + trade.offerAsset + '</td>' +
      '<td class="mono">' + counter + '</td>' +
      '<td><a class="hash-link" href="' + (trade.txHash ? 'https://www.zigscan.org/tx/' + encodeURIComponent(trade.txHash) : '#') + '" target="_blank" rel="noreferrer">' + shortHash(trade.txHash) + '</a></td>' +
      '<td class="muted">' + formatDateTime(trade.timestamp) + (trade.estimated ? '<span class="estimate-tag">est.</span>' : '') + '</td>' +
      '</tr>';
  }).join('');
}

function renderActivity(snapshot: Snapshot): string {
  const events: Array<{ icon: string; tone: string; title: string; detail: string }> = [];
  for (const error of snapshot.recentErrors.slice(0, 2)) {
    events.push({
      icon: '!',
      tone: 'error',
      title: error.source,
      detail: formatDateTime(error.timestamp) + ' · ' + error.message,
    });
  }
  if (snapshot.lastTrade) {
    events.push({
      icon: snapshot.lastTrade.action === 'BUY_STZIG' ? 'B' : 'S',
      tone: snapshot.lastTrade.action === 'BUY_STZIG' ? 'buy' : 'sell',
      title: snapshot.lastTrade.action === 'BUY_STZIG' ? 'stZIG purchase confirmed' : 'stZIG sale confirmed',
      detail: formatDateTime(snapshot.lastTrade.timestamp),
    });
  }
  if (snapshot.lastEventAt) {
    events.push({ icon: 'R', tone: 'live', title: snapshot.lastEventLabel, detail: formatDateTime(snapshot.lastEventAt) });
  }
  events.push({ icon: 'O', tone: 'neutral', title: 'Bot session started', detail: formatDateTime(snapshot.startedAt) });
  return events.slice(0, 4).map((event) =>
    '<div class="activity-row"><span class="activity-icon ' + escapeHtml(event.tone) + '">' + escapeHtml(event.icon) + '</span><div><strong>' + escapeHtml(event.title) + '</strong><span>' + escapeHtml(event.detail) + '</span></div></div>'
  ).join('');
}
function updateStrategyProgress(snapshot: Snapshot): void {
  const price = snapshot.latestPrice;
  const lower = snapshot.config.lowerTarget;
  const upper = snapshot.config.upperTarget;
  const marker = $('#strategyMarker') as HTMLElement;
  const fill = $('#strategyFill') as HTMLElement;
  if (price === undefined || !Number.isFinite(price) || upper <= lower) {
    marker.style.left = '50%';
    fill.style.width = '50%';
    marker.classList.add('waiting');
    return;
  }
  const percent = Math.max(0, Math.min(100, ((price - lower) / (upper - lower)) * 100));
  const position = percent.toFixed(2) + '%';
  marker.style.left = position;
  fill.style.width = position;
  marker.classList.remove('waiting');
}
function render(snapshot: Snapshot): void {
  lastSnapshot = snapshot;
  const summary = snapshot.summary;
  const statusLabel = snapshot.status === 'connected' ? 'Live' : snapshot.status === 'reconnecting' ? 'Reconnecting' : snapshot.status === 'booting' ? 'Starting' : snapshot.status === 'degraded' ? 'Degraded' : 'Offline';
  const pnl = summary.netPnl;
  const price = snapshot.latestPrice;
  const range = snapshot.config.lowerTarget.toFixed(4) + '  ' + snapshot.config.upperTarget.toFixed(4);

  $('#statusLabel').textContent = statusLabel;
  $('#statusDot').className = 'status-dot ' + snapshot.status;
  $('#sessionAge').textContent = 'Session ' + elapsed(snapshot.startedAt);
  $('#lastUpdated').textContent = 'Updated ' + formatTime(snapshot.generatedAt);
  $('#priceValue').textContent = formatPrice(price);
  $('#rawPrice').textContent = 'raw ' + formatPrice(snapshot.latestRawPrice);
  $('#triggerBand').textContent = range;
  updateStrategyProgress(snapshot);
  $('#pnlValue').textContent = signed(pnl) + ' ZIG';
  $('#pnlValue').className = 'metric-value ' + pnlClass(pnl);
  $('#pnlRealizedTop').textContent = signed(summary.realizedPnl) + ' ZIG';
  $('#pnlRealizedTop').className = pnlClass(summary.realizedPnl);
  $('#pnlUnrealizedTop').textContent = signed(summary.unrealizedPnl) + ' ZIG';
  $('#pnlUnrealizedTop').className = pnlClass(summary.unrealizedPnl);
  $('#zigBought').textContent = formatCompact(summary.zigSpent) + ' ZIG';
  $('#zigBoughtSub').textContent = summary.buyCount + ' buy ' + (summary.buyCount === 1 ? 'transaction' : 'transactions');
  $('#stzigBought').textContent = formatCompact(summary.stzigBought) + ' stZIG';
  $('#stzigBoughtSub').textContent = formatAmount(summary.stzigBalance) + ' stZIG estimated balance';
  $('#transactions').textContent = numberFormat.format(summary.transactionCount);
  $('#transactionsSub').textContent = summary.buyCount + ' buys  ' + summary.sellCount + ' sells';
  const glancePnl = $opt('#glancePnl');
  if (glancePnl) {
    glancePnl.textContent = signed(pnl) + ' ZIG';
    glancePnl.className = 'mono ' + pnlClass(pnl);
  }
  const glanceTrades = $opt('#glanceTrades');
  if (glanceTrades) glanceTrades.textContent = numberFormat.format(summary.transactionCount);
  const glanceRatio = $opt('#glanceRatio');
  if (glanceRatio) glanceRatio.textContent = formatPrice(price) || '--';
  $('#chartPrice').textContent = formatPrice(price);
  $('#chartUpdated').textContent = snapshot.lastEventAt ? 'Last event ' + formatDateTime(snapshot.lastEventAt) : 'Waiting for pool event';
  $('#ratioChart').innerHTML = renderChart(snapshot);
  $('#zoneRows').innerHTML = renderZones(snapshot);
  updateTriggerWatch(snapshot);
  $('#tradeRows').innerHTML = renderTrades(snapshot);
  $('#activityRows').innerHTML = renderActivity(snapshot);
  $('#positionBalance').textContent = formatAmount(summary.stzigBalance) + ' stZIG';
  $('#positionValue').textContent = formatAmount(summary.stzigBalance * (price ?? 0)) + ' ZIG mark value';
  $('#zigSpent').textContent = formatAmount(summary.zigSpent) + ' ZIG';
  $('#zigReceived').textContent = formatAmount(summary.zigReceived) + ' ZIG';
  $('#realizedPnl').textContent = signed(summary.realizedPnl) + ' ZIG';
  $('#unrealizedPnl').textContent = signed(summary.unrealizedPnl) + ' ZIG';
  $('#reserveStzig').textContent = snapshot.reserves.stzig ? formatCompact(Number(snapshot.reserves.stzig) / 1000000) : '';
  $('#reserveUzig').textContent = snapshot.reserves.uzig ? formatCompact(Number(snapshot.reserves.uzig) / 1000000) : '';
  $('#walletAddress').textContent = snapshot.config.walletAddress || 'Not configured';
  $('#poolAddress').textContent = snapshot.config.poolContract ? snapshot.config.poolContract.slice(0, 12) + '' : '';
  $('#feesNote').textContent = summary.feesExcluded ? 'Network fees are excluded from PnL' : 'Fees included';
  $('#emptyOverlay').classList.toggle('visible', snapshot.status !== 'connected' && !snapshot.latestPrice);
}

async function loadSnapshot(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    let snapshot: Snapshot;
    try {
      const response = await fetch('/api/snapshot', { cache: 'no-store' });
      if (!response.ok) throw new Error('Snapshot request failed with HTTP ' + response.status);
      snapshot = (await response.json()) as Snapshot;
    } catch (error) {
      // The API really is unreachable / returned a bad response.
      document.body.classList.add('api-error');
      $('#statusLabel').textContent = 'Dashboard unavailable';
      $('#statusDot').className = 'status-dot offline';
      console.error('[dashboard] snapshot request failed:', error);
      return;
    }
    // The data arrived fine; a failure past this point is a rendering bug,
    // not an API outage, so don't mislabel it as one.
    document.body.classList.remove('api-error');
    try {
      render(snapshot);
    } catch (error) {
      console.error('[dashboard] render failed:', error);
    }
  } finally {
    loading = false;
  }
}

document.querySelectorAll<HTMLAnchorElement>('[data-scroll]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    document.getElementById(link.dataset.scroll || '')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('[data-scroll]').forEach((item) => item.classList.remove('active'));
    link.classList.add('active');
  });
});

$('#refreshButton').addEventListener('click', () => {
  const button = $('#refreshButton') as HTMLButtonElement;
  button.classList.add('spinning');
  void loadSnapshot().finally(() => window.setTimeout(() => button.classList.remove('spinning'), 500));
});

window.setInterval(() => void loadSnapshot(), 5000);
window.setInterval(() => {
  if (lastSnapshot) $('#sessionAge').textContent = 'Session ' + elapsed(lastSnapshot.startedAt);
}, 30000);
void loadSnapshot();
