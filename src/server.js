import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CONFIG, ROOT_DIR } from './config.js';
import { SessionStorage } from './services/storage.js';
import { runSessionPipeline, pipelineEvents, isSessionRunning } from './services/pipeline.js';

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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('JSON payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function decodeHeaderValue(val) {
  if (!val) return '';
  try {
    return decodeURIComponent(String(val));
  } catch {
    return String(val);
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = urlObj.pathname;

      // Health & config status endpoint
      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          hasApiKey: Boolean(CONFIG.geminiApiKey),
          keyTier: 'Free Tier (Safe Default)',
          chunkTargetSec: CONFIG.chunkTargetSec,
          supportedFormats: Array.from(CONFIG.supportedExtensions)
        });
      }

      // List all sessions
      if (req.method === 'GET' && pathname === '/api/sessions') {
        const sessions = SessionStorage.listSessions();
        return sendJson(res, 200, { sessions });
      }

      // Create session via local file binary stream upload (supports .mp3, .aac, .m4a, .wav, etc. of any size)
      if (req.method === 'POST' && pathname === '/api/sessions/upload') {
        const rawFileName = decodeHeaderValue(req.headers['x-file-name']) || 'lecture_recording.mp3';
        const title =
          decodeHeaderValue(req.headers['x-title']) ||
          path.basename(rawFileName, path.extname(rawFileName)).replace(/[_-]+/g, ' ');
        const topic = decodeHeaderValue(req.headers['x-topic']) || '';
        const chunkTargetSec = Number(req.headers['x-chunk-sec'] || CONFIG.chunkTargetSec);

        const ext = path.extname(rawFileName).toLowerCase() || '.mp3';
        const safeFileName = rawFileName.replace(/[^a-zA-Z0-9._-]/g, '_');

        const session = SessionStorage.createSession({
          title,
          topic,
          sourceType: 'upload',
          originalFileName: safeFileName
        });

        const sessionDir = SessionStorage.getSessionDir(session.id);
        const destFilePath = path.join(sessionDir, 'source', `original${ext}`);
        const writeStream = fs.createWriteStream(destFilePath);

        await pipeline(req, writeStream);

        session.sourceFilePath = destFilePath;
        SessionStorage.saveSession(session);

        // Kick off background pipeline asynchronously
        runSessionPipeline(session.id, { chunkTargetSec }).catch((err) => {
          console.error(`[Pipeline Error] Session ${session.id}:`, err.message);
        });

        return sendJson(res, 201, { session });
      }

      // Create session via Google Drive link or File ID
      if (req.method === 'POST' && pathname === '/api/sessions/gdrive') {
        const body = await readJsonBody(req);
        const gdriveUrl = (body.gdriveUrl || '').trim();
        if (!gdriveUrl) {
          return sendJson(res, 400, { error: 'Please provide a Google Drive link or File ID.' });
        }

        const title = (body.title || '').trim() || 'Google Drive Audio Import';
        const topic = (body.topic || '').trim();
        const chunkTargetSec = Number(body.chunkTargetSec || CONFIG.chunkTargetSec);

        const session = SessionStorage.createSession({
          title,
          topic,
          sourceType: 'gdrive',
          originalFileName: 'Google Drive Stream',
          gdriveUrl
        });

        // Kick off background download + chunking + transcription + notes pipeline
        runSessionPipeline(session.id, { chunkTargetSec }).catch((err) => {
          console.error(`[Pipeline Error] Session ${session.id}:`, err.message);
        });

        return sendJson(res, 201, { session });
      }

      // Match /api/sessions/:id routes
      const sessionMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_-]+))?(?:\/([a-zA-Z0-9_.-]+))?$/);
      if (sessionMatch) {
        const sessionId = sessionMatch[1];
        const subRoute = sessionMatch[2] || '';
        const subParam = sessionMatch[3] || '';

        // GET /api/sessions/:id
        if (req.method === 'GET' && !subRoute) {
          const session = SessionStorage.getSession(sessionId);
          if (!session) return sendJson(res, 404, { error: 'Session not found' });
          return sendJson(res, 200, {
            session,
            isRunning: isSessionRunning(sessionId),
            fullTranscriptMarkdown: SessionStorage.getFullTranscriptMarkdown(sessionId),
            comprehensiveNotesMarkdown: SessionStorage.getComprehensiveNotesMarkdown(sessionId)
          });
        }

        // DELETE /api/sessions/:id
        if (req.method === 'DELETE' && !subRoute) {
          const deleted = SessionStorage.deleteSession(sessionId);
          return sendJson(res, 200, { deleted });
        }

        // POST /api/sessions/:id/resume
        if (req.method === 'POST' && subRoute === 'resume') {
          const session = SessionStorage.getSession(sessionId);
          if (!session) return sendJson(res, 404, { error: 'Session not found' });

          runSessionPipeline(sessionId).catch((err) => {
            console.error(`[Resume Error] Session ${sessionId}:`, err.message);
          });

          return sendJson(res, 200, { ok: true, message: 'Resumed session pipeline.' });
        }

        // POST /api/sessions/:id/regenerate-notes
        if (req.method === 'POST' && subRoute === 'regenerate-notes') {
          const session = SessionStorage.getSession(sessionId);
          if (!session) return sendJson(res, 404, { error: 'Session not found' });

          runSessionPipeline(sessionId, { forceRegenerateNotes: true }).catch((err) => {
            console.error(`[Regenerate Notes Error] Session ${sessionId}:`, err.message);
          });

          return sendJson(res, 200, { ok: true, message: 'Regenerating comprehensive lecture notes...' });
        }

        // GET /api/sessions/:id/events (Server-Sent Events for live UI updates)
        if (req.method === 'GET' && subRoute === 'events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
          });
          res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

          const listener = (eventPayload) => {
            res.write(`data: ${JSON.stringify(eventPayload)}\n\n`);
          };

          pipelineEvents.on(`session:${sessionId}`, listener);

          const heartbeat = setInterval(() => {
            res.write(`: heartbeat\n\n`);
          }, 15000);

          req.on('close', () => {
            clearInterval(heartbeat);
            pipelineEvents.off(`session:${sessionId}`, listener);
          });
          return;
        }

        // GET /api/sessions/:id/export/:type
        if (req.method === 'GET' && subRoute === 'export') {
          const session = SessionStorage.getSession(sessionId);
          if (!session) return sendJson(res, 404, { error: 'Session not found' });
          const safeBase = session.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) || sessionId;

          if (subParam === 'notes.md') {
            const content = SessionStorage.getComprehensiveNotesMarkdown(sessionId);
            res.writeHead(200, {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': `attachment; filename="${safeBase}_comprehensive_notes.md"`
            });
            return res.end(content);
          }

          if (subParam === 'transcript.md') {
            const content = SessionStorage.getFullTranscriptMarkdown(sessionId);
            res.writeHead(200, {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': `attachment; filename="${safeBase}_verbatim_transcript.md"`
            });
            return res.end(content);
          }

          if (subParam === 'transcript.txt') {
            const sessionDir = SessionStorage.getSessionDir(sessionId);
            const txtPath = path.join(sessionDir, 'full_transcript.txt');
            const content = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : '';
            res.writeHead(200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Content-Disposition': `attachment; filename="${safeBase}_verbatim_transcript.txt"`
            });
            return res.end(content);
          }
        }
      }

      // Serve static frontend files from public/
      let relPath = pathname === '/' ? '/index.html' : pathname;
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

// Start server if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve( ROOT_DIR, 'src', 'server.js')) {
  const server = createServer();
  server.listen(CONFIG.port, () => {
    console.log(`\n========================================================`);
    console.log(`  RecordNote Server running at http://localhost:${CONFIG.port}`);
    console.log(`  Active Key Mode : Free Tier (Rate-Limit Paced)`);
    console.log(`  Sessions Dir    : ${CONFIG.sessionsDir}`);
    console.log(`========================================================\n`);
  });
}
