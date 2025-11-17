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

export async function notifyTrade(
  text: string,
  opts?: { chatId?: string; txHash?: string }
): Promise<void> {
  try {
    if (!BOT_TOKEN) return;
    let cid = opts?.chatId || DEFAULT_CHAT_ID;
    // Try to load first subscriber if no default chat id yet
    if (!cid) {
      try {
        const { promises: fsp } = await import('fs');
        const content = await fsp.readFile(SUBSCRIBERS_FILE, 'utf8');
        const first = content.split(/\r?\n/).find((l) => l.trim().length > 0);
        if (first) cid = first.split(',')[0];
      } catch {}
    }
    if (!cid) return; // no destination yet
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload: any = {
      chat_id: cid,
      text,
    };
    if (opts?.txHash) {
      payload.reply_markup = {
        inline_keyboard: [
          [
            {
              text: 'View on Zigscan',
              url: `https://www.zigscan.org/tx/${opts.txHash}`,
            },
          ],
        ],
      };
    }
    await postJson(url, payload);
  } catch (e) {
    // silent to avoid crashing trading loop
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
  // switch to long polling by deleting webhook if present
  (async () => {
    try {
      const fetchFn = await getFetch();
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`;
      await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drop_pending_updates: true }) });
      console.log('[tg] Webhook cleared; using long polling');
    } catch (e) {
      console.error('[tg] failed to delete webhook:', e instanceof Error ? e.message : e);
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
          const p = getLatest();
          const thr = thresholdGetter ? thresholdGetter() : undefined;
          const thrLine = thr ? `\nTrigger band: ${thr}` : '';
          const body = p
            ? `Bot online. Current ratio (uzig/stzig): ${p.toFixed(6)}${thrLine}`
            : 'Bot online. No ratio yet — waiting for first pool event.';
          await notifyTrade(body, { chatId });
        } else if (text === '/stop' || text.toLowerCase() === 'stop') {
          await removeSubscriber(chatId);
          await notifyTrade('Notifications stopped. Send /start to resume.', { chatId });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('terminated by other getUpdates request')) {
        // Another in-flight request from this process; will retry after backoff
        console.warn('[tg] concurrent poll avoided');
      } else {
        console.error('[tg] polling error:', msg);
      }
    }
  }
  // Single in-flight long-poll loop
  let polling = false;
  const loop = async () => {
    if (polling) return; // avoid overlap
    polling = true;
    try {
      await pollOnce();
    } finally {
      polling = false;
      setTimeout(loop, 500); // small backoff between polls
    }
  };
  void loop();
  console.log('[tg] Telegram bot started. Waiting for /start in DM...');
}
