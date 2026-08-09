// Статика + прокси к api.motogp.pulselive.com. Без зависимостей: node server.js.
//
// Прокси тут не для красоты. API Dorna проверяет заголовок Origin и всему, что
// не https://www.motogp.com, отвечает 403 «Invalid CORS request» — из браузера
// напрямую не сходить. С сервера Origin не отправляется, и тот же запрос
// проходит, поэтому страницу и API отдаёт один процесс: /api/* уезжает наверх,
// остальное — файлы проекта.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8000;
const UPSTREAM = 'https://api.motogp.pulselive.com/motogp/v1/results';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Ответы Dorna неизменны для прошедших сессий, но кэш в памяти всё равно нужен:
// сезон — это под сотню запросов, и на перезагрузке страницы они повторяются.
const cache = new Map();

async function proxy(req, res) {
  const url = UPSTREAM + req.url.slice('/api'.length);
  if (cache.has(url)) return send(res, 200, TYPES['.json'], cache.get(url));
  try {
    const upstream = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (upstream.ok) cache.set(url, body); // ошибки не кэшируем — дадим шанс повтору
    send(res, upstream.status, TYPES['.json'], body);
  } catch (e) {
    send(res, 502, TYPES['.json'], JSON.stringify({ error: String(e.message || e) }));
  }
}

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
  res.end(body);
}

async function serveFile(req, res) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Путь всегда собираем от корня проекта и проверяем результат: без этого
  // «/../..» отдал бы наружу что угодно с диска.
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    return send(res, 403, TYPES['.html'], 'Forbidden');
  }
  try {
    const stat = await fs.stat(file);
    // ETag тут не ради экономии трафика на localhost, а ради того, чтобы
    // браузер отличал обычный F5 от Ctrl+F5: при F5 он ревалидирует и получает
    // 304 с пустым телом, при Ctrl+F5 — полный ответ. По этому и только по
    // этому признаку страница понимает, что кэш данных пора сбросить (см.
    // purgeOnHardReload в src/motogp.js). Без ETag любой F5 выглядел как
    // жёсткая перезагрузка, и сезон каждый раз загружался заново.
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      return send(res, 304, TYPES[path.extname(file)] || 'text/plain', null, { ETag: etag });
    }
    const body = await fs.readFile(file);
    send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', body, { ETag: etag });
  } catch {
    send(res, 404, TYPES['.html'], 'Not found');
  }
}

http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/')) return proxy(req, res);
    return serveFile(req, res);
  })
  .listen(PORT, () => console.log(`Paddock открыт: http://localhost:${PORT}`));
