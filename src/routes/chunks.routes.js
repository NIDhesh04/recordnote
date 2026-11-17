import path from 'node:path';
import { CONFIG } from '../config.js';
import { SessionStorage } from '../services/storage.js';
import { runSingleChunkReprocess } from '../services/pipeline.js';
import { sendJson, readJsonBody, streamAudioFileWithRange } from '../utils/http.js';

export async function handleChunkRoutes(req, res, pathname) {
  const chunkRouteMatch = pathname.match(
    /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/chunks\/(\d+)(?:\/([a-zA-Z0-9_-]+))?$/
  );
  if (!chunkRouteMatch) return false;

  const sessionId = chunkRouteMatch[1];
  const chunkIndex = Number(chunkRouteMatch[2]);
  const chunkAction = chunkRouteMatch[3] || '';

  const session = await SessionStorage.getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Lecture not found' });
    return true;
  }

  const chunk = (session.chunks || []).find((c) => c.index === chunkIndex);
  if (!chunk) {
    sendJson(res, 404, { error: `Chunk ${chunkIndex} not found` });
    return true;
  }

  // GET /api/sessions/:id/chunks/:chunkIndex/audio
  if (req.method === 'GET' && chunkAction === 'audio') {
    const sessionDir = SessionStorage.getSessionDir(session.id);
    const chunkPath = path.join(sessionDir, 'chunks', chunk.fileName);
    streamAudioFileWithRange(req, res, chunkPath);
    return true;
  }

  // POST /api/sessions/:id/chunks/:chunkIndex/retranscribe
  if (req.method === 'POST' && chunkAction === 'retranscribe') {
    const body = await readJsonBody(req);
    const model = (body.model || CONFIG.retryHeavyModel).trim();
    const enhanceAudio = body.enhanceAudio !== false;
    const customHint = (body.customHint || '').trim();
    const updateNotesFromHere = Boolean(body.updateNotesFromHere);

    runSingleChunkReprocess(session.id, chunkIndex, {
      model,
      enhanceAudio,
      customHint,
      updateNotesFromHere
    }).catch((err) => {
      console.error(`[Chunk Reprocess Error] ${chunk.code}:`, err.message);
    });

    sendJson(res, 202, {
      ok: true,
      started: true,
      message: `Started reprocessing ${chunk.code} with ${model}${
        updateNotesFromHere ? ' + updating lecture notes' : ''
      }...`
    });
    return true;
  }

  // PUT /api/sessions/:id/chunks/:chunkIndex
  if (req.method === 'PUT' && !chunkAction) {
    const body = await readJsonBody(req);
    if (typeof body.transcriptText !== 'string' || !body.transcriptText.trim()) {
      sendJson(res, 400, { error: 'Transcript text cannot be empty.' });
      return true;
    }

    const updatedSession = await SessionStorage.saveChunkTranscript(
      session.id,
      chunkIndex,
      body.transcriptText.trim(),
      `${chunk.modelUsed || 'Gemini'} (Manually Edited)`
    );

    sendJson(res, 200, {
      ok: true,
      session: updatedSession,
      chunk: updatedSession.chunks.find((c) => c.index === chunkIndex),
      fullTranscriptMarkdown: await SessionStorage.getFullTranscriptMarkdown(session.id)
    });
    return true;
  }

  return false;
}
