import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, statSync } from 'fs';
import { extname, join, resolve } from 'path';
import { getDashboardSnapshot, recordRuntimeError } from './metrics';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const publicRoot = resolve(process.cwd(), 'public');
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = resolve(publicRoot, requested);

  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + '\\')) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error('Not a file');
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream');
    // Local dev console: always revalidate so edits to app.js/styles.css show up
    // on a plain reload instead of being served from a stale browser cache.
    res.setHeader('Cache-Control', 'no-cache');
    res.end(readFileSync(filePath));
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

export function startDashboardServer(): void {
  const port = Number(process.env.DASHBOARD_PORT || '3030');
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method || 'GET';
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;

      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.end();
        return;
      }

      if (pathname === '/api/snapshot') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        sendJson(res, 200, getDashboardSnapshot());
        return;
      }

      if (pathname === '/api/health') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const snapshot = getDashboardSnapshot();
        sendJson(res, 200, {
          ok: true,
          status: snapshot.status,
          generatedAt: snapshot.generatedAt,
          recentErrors: snapshot.recentErrors,
        });
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'API route not found' });
        return;
      }

      serveStatic(res, pathname);
    } catch (error) {
      recordRuntimeError('Dashboard request failed', error);
      console.error('[dashboard] request failed:', error instanceof Error ? error.message : error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Dashboard request failed' });
      } else {
        res.end();
      }
    }
  });

  server.on('error', (error) => {
    console.error('[dashboard] server error:', error instanceof Error ? error.message : error);
  });

  server.listen(port, host, () => {
    console.log('[dashboard] running at http://' + host + ':' + port);
  });
}
