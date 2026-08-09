// Локальный статический сервер: node server.js. Без зависимостей.
//
// Ходить в API Dorna отсюда больше не нужно — данные лежат готовыми в data/
// (собирает build.js). Сервер нужен только потому, что страница собрана из
// ES-модулей, а их не отдать через file://.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

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
    // ETag, чтобы файлы data/ переживали перезагрузку страницы: они не мелкие,
    // а меняются только после пересборки.
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
  .createServer(serveFile)
  .listen(PORT, () => console.log(`Паддок открыт: http://localhost:${PORT}`));
