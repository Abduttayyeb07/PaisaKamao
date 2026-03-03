// Minimal Telegram bot helper: long polling + push notifications + subscribers CSV
// Env:
//  - TELEGRAM_BOT_TOKEN
//  - TELEGRAM_CHAT_ID (optional default chat)
//  - SUBSCRIBERS_FILE (optional path; defaults to subscribers.csv)

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
let DEFAULT_CHAT_ID: string | undefined = process.env.TELEGRAM_CHAT_ID;
const SUBSCRIBERS_FILE = process.env.SUBSCRIBERS_FILE || 'subscribers.csv';

// Resolve fetch, supporting Node < 18 via dynamic import of node-fetch
type FetchLike = (input: string, init?: any) => Promise<any>;
let fetchRef: FetchLike | null = null;
async function getFetch(): Promise<FetchLike> {
  if (fetchRef) return fetchRef;
  const gf = (globalThis as any).fetch as FetchLike | undefined;
  if (gf) {
    fetchRef = gf;
    return fetchRef;
  }
  try {
    const mod = await import('node-fetch');
    // @ts-ignore
    fetchRef = (mod.default || mod) as FetchLike;
    return fetchRef;
  } catch (e) {
    throw new Error('No fetch available. Use Node 18+ or install node-fetch.');
  }
}

async function ensureDirFor(filePath: string) {
  const { dirname } = await import('path');
  const { promises: fsp } = await import('fs');
  const dir = dirname(filePath);
  if (!dir || dir === '.' || dir === '') return;
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {}
}

async function appendSubscriber(chatId: string, username?: string) {
  try {
    const { promises: fsp } = await import('fs');
    // Read existing file to dedupe
    let existing = '';
    try {
      existing = await fsp.readFile(SUBSCRIBERS_FILE, 'utf8');
    } catch {}
    if (existing.split(/\r?\n/).some((l) => l.split(',')[0] === chatId)) return;
    await ensureDirFor(SUBSCRIBERS_FILE);
    const ts = new Date().toISOString();
    const line = `${chatId},${username || ''},${ts}\n`;
    await fsp.appendFile(SUBSCRIBERS_FILE, line, 'utf8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[tg] failed to append subscriber:', e instanceof Error ? e.message : e);
  }
}

async function removeSubscriber(chatId: string) {
  try {
    const { promises: fsp } = await import('fs');
    let existing = '';
    try {
      existing = await fsp.readFile(SUBSCRIBERS_FILE, 'utf8');
    } catch {}
    const lines = existing
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0 && l.split(',')[0] !== chatId);
    await ensureDirFor(SUBSCRIBERS_FILE);
    await fsp.writeFile(SUBSCRIBERS_FILE, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    // Clear default if it matches
    if (DEFAULT_CHAT_ID === chatId) DEFAULT_CHAT_ID = undefined;
  } catch (e) {
    console.error('[tg] failed to remove subscriber:', e instanceof Error ? e.message : e);
  }
}

async function postJson(url: string, body: any): Promise<any> {
  const fetchFn = await getFetch();
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.ok === false)) {
    const desc = (data && (data.description || data.error)) || res.statusText;
    throw new Error(`Telegram API error: ${desc}`);
  }
  return data;
}

async function loadAllChatIds(): Promise<string[]> {
  const ids = new Set<string>();
  if (DEFAULT_CHAT_ID) ids.add(DEFAULT_CHAT_ID);
  try {
    const { promises: fsp } = await import('fs');
    const content = await fsp.readFile(SUBSCRIBERS_FILE, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const cid = line.trim().split(',')[0];
      if (cid) ids.add(cid);
    }
  } catch {}
  return [...ids];
}

export async function notifyTrade(
  text: string,
  opts?: { chatId?: string; txHash?: string }
): Promise<void> {
  try {
    if (!BOT_TOKEN) return;

    // If a specific chatId is provided (e.g. /start reply), send only to that
    // Otherwise broadcast to ALL subscribers + DEFAULT_CHAT_ID
    const targets: string[] = opts?.chatId
      ? [opts.chatId]
      : await loadAllChatIds();

    if (targets.length === 0) {
      console.warn('[tg] no subscribers to notify');
      return;
    }

    console.log(`[tg] broadcasting to ${targets.length} chat(s): ${targets.join(', ')}`);

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const replyMarkup = opts?.txHash
      ? {
          inline_keyboard: [
            [
              {
                text: 'View on Zigscan',
                url: `https://www.zigscan.org/tx/${opts.txHash}`,
              },
            ],
          ],
        }
      : undefined;

    for (const cid of targets) {
      try {
        const payload: any = { chat_id: cid, text };
        if (replyMarkup) payload.reply_markup = replyMarkup;
        await postJson(url, payload);
      } catch (e) {
        console.error(`[tg] failed to send to ${cid}:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[tg] notify failed:', e instanceof Error ? e.message : e);
  }
}

export function startTelegramBot(getLatest: () => number | undefined, thresholdGetter?: () => string | number | undefined) {
  if (!BOT_TOKEN) {
    console.log('[tg] BOT token not set; notifications disabled');
    return;
  }
  let offset = 0;
  let consecutiveErrors = 0;
  let lastErrorMsg = '';

  // switch to long polling by deleting webhook if present
  (async () => {
    try {
      const fetchFn = await getFetch();
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`;
      await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drop_pending_updates: true }) });
      console.log('[tg] Webhook cleared; using long polling');
    } catch (e) {
      console.error('[tg] failed to delete webhook:', e instanceof Error ? e.message : e);
      console.warn('[tg] ⚠ Cannot reach api.telegram.org — check VPN/proxy/network');
    }
  })();

  async function pollOnce() {
    try {
      const fetchFn = await getFetch();
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
      const qs = new URLSearchParams({ timeout: '30', offset: String(offset + 1) }).toString();
      const res = await fetchFn(`${url}?${qs}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || 'getUpdates failed');

      // Reset error tracking on success
      if (consecutiveErrors > 0) {
        console.log(`[tg] ✅ Telegram API reconnected after ${consecutiveErrors} failures`);
      }
      consecutiveErrors = 0;
      lastErrorMsg = '';

      const updates: any[] = data.result || [];
      for (const u of updates) {
        offset = Math.max(offset, u.update_id || 0);
        const msg = u.message || u.edited_message || undefined;
        if (!msg) continue;
        const chatId = String(msg.chat?.id);
        const text: string = (msg.text || '').trim();
        const username: string | undefined = msg.from?.username || msg.chat?.username || undefined;

        // record chat id for future notifications
        DEFAULT_CHAT_ID = DEFAULT_CHAT_ID || chatId;

        if (text === '/start' || text === 'start' || text === 'Start') {
          // persist subscriber
          await appendSubscriber(chatId, username);
          const allIds = await loadAllChatIds();
          console.log(`[tg] 📥 Subscriber registered: ${chatId} (${username || 'no username'}) — total: ${allIds.length}`);
          const p = getLatest();
          const thr = thresholdGetter ? thresholdGetter() : undefined;
          const thrLine = thr ? `\nTrigger band: ${thr}` : '';
          const body = p
            ? `Bot online. Current ratio (uzig/stzig): ${p.toFixed(6)}${thrLine}`
            : 'Bot online. No ratio yet — waiting for first pool event.';
          await notifyTrade(body, { chatId });
        } else if (text === '/stop' || text.toLowerCase() === 'stop') {
          await removeSubscriber(chatId);
          console.log(`[tg] 📤 Subscriber removed: ${chatId}`);
          await notifyTrade('Notifications stopped. Send /start to resume.', { chatId });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      consecutiveErrors++;

      if (msg.includes('terminated by other getUpdates request')) {
        console.warn('[tg] concurrent poll avoided');
      } else if (msg !== lastErrorMsg || consecutiveErrors === 1) {
        // Only log on first occurrence or when error message changes
        console.error(`[tg] polling error: ${msg} (will retry in ${Math.min(consecutiveErrors * 5, 60)}s)`);
        if (consecutiveErrors === 1) {
          console.warn('[tg] ⚠ If this persists, Telegram API may be blocked — try VPN or deploy to a VPS');
        }
        lastErrorMsg = msg;
      } else if (consecutiveErrors % 20 === 0) {
        // Periodic reminder every ~20 failures
        console.warn(`[tg] still failing (${consecutiveErrors} consecutive errors): ${msg}`);
      }
    }
  }

  // Single in-flight long-poll loop with exponential backoff
  let polling = false;
  const loop = async () => {
    if (polling) return;
    polling = true;
    try {
      await pollOnce();
    } finally {
      polling = false;
      // Backoff: 500ms normally, up to 60s on consecutive errors
      const backoff = consecutiveErrors > 0
        ? Math.min(consecutiveErrors * 5000, 60_000)
        : 500;
      setTimeout(loop, backoff);
    }
  };
  void loop();
  console.log('[tg] Telegram bot started. Waiting for /start in DM...');
}
