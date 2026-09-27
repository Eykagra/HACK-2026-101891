/**
 * HTTP plumbing: routing, body limits, rate limiting, static files, logging.
 *
 * Built on `node:http` directly. That is a deliberate trade — a framework would
 * save perhaps 120 lines here, at the cost of a dependency tree that cannot be
 * audited in an afternoon. The pieces a framework would have given us are all
 * present and all small: a trie-free matcher, a JSON body reader with a hard
 * cap, a token-bucket limiter, and one error funnel.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { AppError, rateLimited } from '../errors.ts';
import type { Config } from '../config.ts';
import { toProblem } from './problem.ts';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
  /** Reads and parses the JSON body once, enforcing `MAX_BODY_BYTES`. */
  body: <T = unknown>() => Promise<T>;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

export interface Route {
  method: string;
  /** Pattern such as `/api/tasks/:id/move`. */
  pattern: string;
  handler: Handler;
  /** Requests per minute for this route. Omitted means unlimited. */
  limitPerMinute?: number;
}

interface CompiledRoute extends Route {
  segments: string[];
}

const compile = (route: Route): CompiledRoute => ({
  ...route,
  segments: route.pattern.split('/').filter(Boolean),
});

function match(route: CompiledRoute, method: string, path: string): Record<string, string> | null {
  if (route.method !== method) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== route.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i += 1) {
    const expected = route.segments[i]!;
    const actual = parts[i]!;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

/**
 * Fixed-window counter, keyed by client and route.
 *
 * In-memory on purpose: a single-instance deployment needs nothing more, and
 * pretending otherwise would mean shipping a Redis dependency this app does not
 * use. The limit that actually matters is on the AI routes, which cost money
 * per call; the read routes are generous.
 */
class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  check(key: string, limitPerMinute: number): void {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    entry.count += 1;
    if (entry.count > limitPerMinute) {
      throw rateLimited(Math.ceil((entry.resetAt - now) / 1000));
    }
  }

  /** Called on an interval so a long-running process does not grow unbounded. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now > entry.resetAt) this.hits.delete(key);
    }
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  config: Config;
  routes: Route[];
  /** Directory served for non-API paths. */
  staticDir: string;
}

function clientKey(req: IncomingMessage): string {
  // Behind the documented Caddy reverse proxy, the real client is in
  // X-Forwarded-For. Only the first hop is trusted, and only for rate limiting
  // — it never grants authorisation.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function readJsonBody<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AppError('PAYLOAD_TOO_LARGE', 413, `Request body exceeds ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolvePromise({} as T);
        return;
      }
      try {
        resolvePromise(JSON.parse(raw) as T);
      } catch {
        reject(new AppError('VALIDATION_FAILED', 400, 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(
  res: ServerResponse,
  staticDir: string,
  urlPath: string,
): Promise<boolean> {
  const rootDir = resolve(staticDir);
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  // normalize + prefix check: the classic `../../etc/passwd` traversal.
  const candidate = resolve(join(rootDir, normalize(requested)));
  if (candidate !== rootDir && !candidate.startsWith(rootDir + '/')) return false;

  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    const ext = extname(candidate);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': info.size,
      // The demo is meant to be re-deployed and re-loaded constantly; a stale
      // cached bundle during judging would be an unforced error.
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    });
    createReadStream(candidate).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, requestId: string): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': status >= 400 ? 'application/problem+json' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-request-id': requestId,
  });
  res.end(body);
}

/** Headers that cost nothing and remove whole classes of browser attack. */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // No inline handlers and no remote assets anywhere in the frontend, so the
  // policy can stay this tight. 'unsafe-inline' is needed for style attributes
  // used to position the SVG graph nodes.
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function createApp(options: ServerOptions): Server {
  const { config } = options;
  const routes = options.routes.map(compile);
  const limiter = new RateLimiter();
  const sweeper = setInterval(() => limiter.sweep(), 60_000);
  sweeper.unref();

  const log = (level: 'debug' | 'info' | 'error', fields: Record<string, unknown>): void => {
    if (config.logLevel === 'silent' && level !== 'error') return;
    if (config.logLevel === 'info' && level === 'debug') return;
    // One JSON object per line: greppable in `docker logs`, parseable by
    // CloudWatch, and free of anything secret.
    process.stdout.write(`${JSON.stringify({ level, ts: new Date().toISOString(), ...fields })}\n`);
  };

  const server = createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    for (const [header, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(header, value);
    res.setHeader('x-request-id', requestId);

    try {
      for (const route of routes) {
        const params = match(route, method, url.pathname);
        if (!params) continue;

        if (route.limitPerMinute !== undefined) {
          limiter.check(`${clientKey(req)}|${route.method} ${route.pattern}`, route.limitPerMinute);
        }

        let bodyPromise: Promise<unknown> | null = null;
        const result = await route.handler({
          req,
          res,
          params,
          query: url.searchParams,
          requestId,
          body: <T>() => {
            bodyPromise ??= readJsonBody<T>(req, config.maxBodyBytes);
            return bodyPromise as Promise<T>;
          },
        });

        if (!res.headersSent) {
          if (result === undefined || result === null) {
            res.writeHead(204).end();
          } else {
            // A handler may have set 201 for a creation; honour it.
            sendJson(res, res.statusCode, result, requestId);
          }
        }
        log('info', {
          requestId,
          method,
          path: url.pathname,
          status: res.statusCode,
          ms: Date.now() - started,
        });
        return;
      }

      // Unmatched /api is a 404 in problem+json; everything else may be static.
      if (!url.pathname.startsWith('/api/')) {
        const served = await serveStatic(res, options.staticDir, url.pathname);
        if (served) return;
        // SPA-style fallback so a deep link still boots the app.
        if (method === 'GET' && !extname(url.pathname)) {
          const index = await serveStatic(res, options.staticDir, '/index.html');
          if (index) return;
        }
      }

      sendJson(
        res,
        404,
        toProblem(
          new AppError('NOT_FOUND', 404, `No route for ${method} ${url.pathname}.`),
          requestId,
        ),
        requestId,
      );
    } catch (error) {
      const problem = toProblem(error, requestId);
      if (problem.status >= 500) {
        log('error', {
          requestId,
          method,
          path: url.pathname,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
      } else {
        log('info', {
          requestId,
          method,
          path: url.pathname,
          status: problem.status,
          code: problem.code,
          ms: Date.now() - started,
        });
      }
      if (!res.headersSent) sendJson(res, problem.status, problem, requestId);
      else res.end();
    }
  });

  return server;
}
