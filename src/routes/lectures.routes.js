import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CONFIG } from '../config.js';
import { resetLectureProcessingState } from '../db/postgres.js';
import { SessionStorage } from '../services/storage.js';
import { parseTimestampToSeconds } from '../services/audio.js';
import { runSessionPipeline, pipelineEvents, isSessionRunning } from '../services/pipeline.js';
import { sendJson, readJsonBody } from '../utils/http.js';
import { decodeHeaderValue } from '../utils/format.js';

export async function handleLectureRoutes(req, res, urlObj) {
  const pathname = urlObj.pathname;

  // GET /api/sessions
  if (req.method === 'GET' && pathname === '/api/sessions') {
    const subjectId = urlObj.searchParams.get('subjectId') || '';
    const sessions = await SessionStorage.listSessions(subjectId);
    sendJson(res, 200, { sessions });
    return true;
  }

  // POST /api/sessions/upload
  if (req.method === 'POST' && pathname === '/api/sessions/upload') {
    const rawFileName = decodeHeaderValue(req.headers['x-file-name']) || 'lecture_recording.mp3';
    const subjectId = decodeHeaderValue(req.headers['x-subject-id']) || '';
    const newSubjectName = decodeHeaderValue(req.headers['x-new-subject-name']) || '';
    const newSubjectCode = decodeHeaderValue(req.headers['x-new-subject-code']) || '';
    const title =
      decodeHeaderValue(req.headers['x-title']) ||
      path.basename(rawFileName, path.extname(rawFileName)).replace(/[_-]+/g, ' ');
    const topic = decodeHeaderValue(req.headers['x-topic']) || '';
    const chunkTargetSec = Number(req.headers['x-chunk-sec'] || CONFIG.chunkTargetSec);
    const trimStartSec = parseTimestampToSeconds(decodeHeaderValue(req.headers['x-trim-start']));
    const trimEndSec = parseTimestampToSeconds(decodeHeaderValue(req.headers['x-trim-end']));

    if (trimStartSec !== null && trimEndSec !== null && trimEndSec <= trimStartSec) {
      sendJson(res, 400, { error: 'End timestamp must be greater than Start timestamp.' });
      return true;
    }

    const ext = path.extname(rawFileName).toLowerCase() || '.mp3';
    const safeFileName = rawFileName.replace(/[^a-zA-Z0-9._-]/g, '_');

    let session = await SessionStorage.createSession({
      subjectId,
      newSubjectName,
      newSubjectCode,
      title,
      topic,
      sourceType: 'upload',
      originalFileName: safeFileName,
      trimStartSec,
      trimEndSec
    });

    const sessionDir = SessionStorage.getSessionDir(session.id);
    const destFilePath = path.join(sessionDir, 'source', `original${ext}`);
    const writeStream = fs.createWriteStream(destFilePath);

    await pipeline(req, writeStream);

    session = await SessionStorage.updateLectureFields(session.id, {
      sourceFilePath: destFilePath
    });

    runSessionPipeline(session.id, { chunkTargetSec }).catch((err) => {
      console.error(`[Pipeline Error] Lecture ${session.code} (${session.id}):`, err.message);
    });

    sendJson(res, 201, { session });
    return true;
  }

  // POST /api/sessions/gdrive
  if (req.method === 'POST' && pathname === '/api/sessions/gdrive') {
    const body = await readJsonBody(req);
    const gdriveUrl = (body.gdriveUrl || '').trim();
    if (!gdriveUrl) {
      sendJson(res, 400, { error: 'Please provide a Google Drive link or File ID.' });
      return true;
    }

    const subjectId = (body.subjectId || '').trim();
    const newSubjectName = (body.newSubjectName || '').trim();
    const newSubjectCode = (body.newSubjectCode || '').trim();
    const title = (body.title || '').trim() || 'Google Drive Audio Import';
    const topic = (body.topic || '').trim();
    const chunkTargetSec = Number(body.chunkTargetSec || CONFIG.chunkTargetSec);
    const trimStartSec = parseTimestampToSeconds(body.trimStart);
    const trimEndSec = parseTimestampToSeconds(body.trimEnd);

    if (trimStartSec !== null && trimEndSec !== null && trimEndSec <= trimStartSec) {
      sendJson(res, 400, { error: 'End timestamp must be greater than Start timestamp.' });
      return true;
    }

    const session = await SessionStorage.createSession({
      subjectId,
      newSubjectName,
      newSubjectCode,
      title,
      topic,
      sourceType: 'gdrive',
      originalFileName: 'Google Drive Stream',
      gdriveUrl,
      trimStartSec,
      trimEndSec
    });

    runSessionPipeline(session.id, { chunkTargetSec }).catch((err) => {
      console.error(`[Pipeline Error] Lecture ${session.code} (${session.id}):`, err.message);
    });

    sendJson(res, 201, { session });
    return true;
  }

  // Match /api/sessions/:id(?:/subRoute)(?:/subParam)
  const sessionMatch = pathname.match(
    /^\/api\/sessions\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_-]+))?(?:\/([a-zA-Z0-9_.-]+))?$/
  );
  if (!sessionMatch) return false;

  const sessionId = sessionMatch[1];
  const subRoute = sessionMatch[2] || '';
  const subParam = sessionMatch[3] || '';

  if (req.method === 'GET' && !subRoute) {
    let session = await SessionStorage.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Lecture not found' });
      return true;
    }

    const running = isSessionRunning(session.id);
    if (
      !running &&
      ((session.chunks || []).some((c) => c.status === 'transcribing') ||
        (session.noteSections || []).some((n) => n.status === 'generating') ||
        ['transcribing', 'generating_notes', 'chunking', 'downloading'].includes(session.status))
    ) {
      await resetLectureProcessingState(session.id);
      session = await SessionStorage.getSession(session.id);
    }

    sendJson(res, 200, {
      session,
      isRunning: running,
      fullTranscriptMarkdown: await SessionStorage.getFullTranscriptMarkdown(session.id),
      comprehensiveNotesMarkdown: await SessionStorage.getComprehensiveNotesMarkdown(session.id)
    });
    return true;
  }

  if (req.method === 'DELETE' && !subRoute) {
    const deleted = await SessionStorage.deleteSession(sessionId);
    sendJson(res, 200, { deleted });
    return true;
  }

  if (req.method === 'POST' && subRoute === 'reset-state') {
    const session = await SessionStorage.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Lecture not found' });
      return true;
    }
    await resetLectureProcessingState(session.id);
    sendJson(res, 200, { ok: true, message: 'Lecture & chunk processing states unlocked.' });
    return true;
  }

  if (req.method === 'POST' && subRoute === 'resume') {
    const session = await SessionStorage.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Lecture not found' });
      return true;
    }

    runSessionPipeline(session.id).catch((err) => {
      console.error(`[Resume Error] Lecture ${session.code}:`, err.message);
    });

    sendJson(res, 200, { ok: true, message: 'Resumed lecture pipeline.' });
    return true;
  }

  if (req.method === 'POST' && subRoute === 'regenerate-notes') {
    const session = await SessionStorage.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Lecture not found' });
      return true;
    }

    const body = await readJsonBody(req).catch(() => ({}));
    const startFromChunkIndex =
      body.startFromChunkIndex !== undefined && body.startFromChunkIndex !== null
        ? Number(body.startFromChunkIndex)
        : null;

    runSessionPipeline(session.id, {
      forceRegenerateNotes: startFromChunkIndex === null,
      startFromChunkIndex
    }).catch((err) => {
      console.error(`[Regenerate Notes Error] Lecture ${session.code}:`, err.message);
    });

    sendJson(res, 200, {
      ok: true,
      message:
        startFromChunkIndex !== null
          ? `Updating lecture notes from Chunk ${startFromChunkIndex + 1} onward...`
          : 'Regenerating all comprehensive lecture notes...'
    });
    return true;
  }

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
    return true;
  }

  if (req.method === 'GET' && subRoute === 'export') {
    const session = await SessionStorage.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Lecture not found' });
      return true;
    }
    const safeBase = `${session.code}_${session.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;

    if (subParam === 'notes.md') {
      const content = await SessionStorage.getComprehensiveNotesMarkdown(session.id);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeBase}_comprehensive_notes.md"`
      });
      res.end(content);
      return true;
    }

    if (subParam === 'transcript.md') {
      const content = await SessionStorage.getFullTranscriptMarkdown(session.id);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeBase}_verbatim_transcript.md"`
      });
      res.end(content);
      return true;
    }
  }

  return false;
}
