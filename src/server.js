import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, ROOT_DIR } from './config.js';
import { initDatabase } from './db/postgres.js';
import { SessionStorage } from './services/storage.js';
import { handleSubjectRoutes } from './routes/subjects.routes.js';
import { handleChunkRoutes } from './routes/chunks.routes.js';
import { handleLectureRoutes } from './routes/lectures.routes.js';
import { sendJson } from './utils/http.js';

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac'
};

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = urlObj.pathname;

      // Health & PostgreSQL status endpoint
      if (req.method === 'GET' && pathname === '/api/health') {
        await initDatabase();
        const subjects = await SessionStorage.listSubjects();
        return sendJson(res, 200, {
          ok: true,
          database: 'PostgreSQL (Connected)',
          subjectCount: subjects.length,
          hasApiKey: Boolean(CONFIG.geminiApiKey),
          keyTier: 'Paid Tier Primary (High-Speed)',
          defaultChunkModel: CONFIG.defaultChunkModel,
          retryHeavyModel: CONFIG.retryHeavyModel,
          availableTranscriberModels: CONFIG.availableTranscriberModels,
          chunkTargetSec: CONFIG.chunkTargetSec,
          supportedFormats: Array.from(CONFIG.supportedExtensions)
        });
      }

      // Dispatch modular API routes
      if (await handleSubjectRoutes(req, res, pathname)) return;
      if (await handleChunkRoutes(req, res, pathname)) return;
      if (await handleLectureRoutes(req, res, urlObj)) return;

      // Serve static frontend files from public/
      const relPath = pathname === '/' ? '/index.html' : pathname;
      const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.join(PUBLIC_DIR, safePath);

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(fullPath).pipe(res);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[Server Error]:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: err.message || 'Internal Server Error' });
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT_DIR, 'src', 'server.js')) {
  initDatabase()
    .then(() => {
      const server = createServer();
      server.listen(CONFIG.port, () => {
        console.log(`\n========================================================`);
        console.log(`  RecordNote Server running at http://localhost:${CONFIG.port}`);
        console.log(`  Database        : PostgreSQL (${CONFIG.pg.host}:${CONFIG.pg.port}/${CONFIG.pg.database})`);
        console.log(`  Active Key Mode : Paid Tier Primary (High-Speed)`);
        console.log(`========================================================\n`);
      });
    })
    .catch((err) => {
      console.error('Failed to initialize PostgreSQL database:', err.message);
      process.exit(1);
    });
}
