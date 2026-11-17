import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';
import { SessionStorage } from './storage.js';
import { downloadFromGoogleDrive } from './gdrive.js';
import { prepareAndChunkAudio } from './audio.js';
import { transcribeSessionChunks, retranscribeSingleChunkInSession } from './transcriber.js';
import { generateComprehensiveNotesForSession } from './notes.js';

export const pipelineEvents = new EventEmitter();
pipelineEvents.setMaxListeners(100);

const activeRuns = new Set();

export function emitSessionEvent(sessionId, payload) {
  pipelineEvents.emit(`session:${sessionId}`, {
    sessionId,
    timestamp: new Date().toISOString(),
    ...payload
  });
}

export function isSessionRunning(sessionId) {
  return activeRuns.has(sessionId);
}

export async function runSessionPipeline(sessionId, options = {}) {
  if (activeRuns.has(sessionId)) {
    return await SessionStorage.getSession(sessionId);
  }

  activeRuns.add(sessionId);
  const targetChunkSec = Number(options.chunkTargetSec || CONFIG.chunkTargetSec);

  try {
    let session = await SessionStorage.getSession(sessionId);
    if (!session) throw new Error(`Lecture not found: ${sessionId}`);

    const sessionDir = SessionStorage.getSessionDir(session.id);
    const sourceDir = path.join(sessionDir, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });

    let inputFilePath =
      session.sourceFilePath && fs.existsSync(session.sourceFilePath) ? session.sourceFilePath : null;

    if (!inputFilePath && session.sourceType === 'gdrive' && session.gdriveUrl) {
      const dlStatus = `Downloading [${session.code}] audio recording from Google Drive...`;
      await SessionStorage.updateLectureFields(session.id, {
        status: 'downloading',
        statusMessage: dlStatus,
        error: null
      });
      emitSessionEvent(session.id, { type: 'status', status: 'downloading', message: dlStatus });

      const dl = await downloadFromGoogleDrive(session.gdriveUrl, sourceDir, (prog) => {
        emitSessionEvent(session.id, { type: 'download_progress', ...prog });
      });

      inputFilePath = dl.filePath;
      const updatedFields = {
        sourceFilePath: dl.filePath,
        originalFileName: dl.fileName
      };
      if (!session.title || session.title.includes('Google Drive Audio Import')) {
        updatedFields.title = `${session.subjectName} — ${path
          .basename(dl.fileName, path.extname(dl.fileName))
          .replace(/[_-]+/g, ' ')}`;
      }
      session = await SessionStorage.updateLectureFields(session.id, updatedFields);
    }

    if (!inputFilePath || !fs.existsSync(inputFilePath)) {
      throw new Error('Source audio file not found for this lecture.');
    }

    // Step 2: Normalize & smart-chunk audio if not already registered in PostgreSQL
    if (!session.chunks || session.chunks.length === 0) {
      const chunkMsg = `Normalizing [${session.code}] audio & detecting natural pauses for smart chunking...`;
      await SessionStorage.updateLectureFields(session.id, {
        status: 'chunking',
        statusMessage: chunkMsg,
        error: null
      });
      emitSessionEvent(session.id, { type: 'status', status: 'chunking', message: chunkMsg });

      const { normalizedPath, audioMetadata, chunks } = await prepareAndChunkAudio(
        inputFilePath,
        sessionDir,
        targetChunkSec,
        (prog) => {
          emitSessionEvent(session.id, { type: 'chunking_progress', ...prog });
        },
        {
          trimStartSec: session.trimStartSec,
          trimEndSec: session.trimEndSec,
          deleteOriginal: true
        }
      );

      session = await SessionStorage.registerChunks(session.id, audioMetadata, chunks);
      const readyMsg = `Split [${session.code}] (${audioMetadata.durationFormatted}) into ${session.chunks.length} smart chunks in PostgreSQL.`;
      await SessionStorage.updateLectureFields(session.id, {
        sourceFilePath: normalizedPath,
        statusMessage: readyMsg
      });

      emitSessionEvent(session.id, {
        type: 'chunks_ready',
        audioMetadata,
        totalChunks: session.chunks.length,
        chunks: session.chunks,
        message: readyMsg
      });
    }

    // Step 3: Transcribe all chunks sequentially with rolling context & PostgreSQL storage
    await transcribeSessionChunks(session.id, (ev) => {
      emitSessionEvent(session.id, ev);
    });

    // Step 4: Generate exhaustive, comprehensive notes in PostgreSQL `lecture_notes` table
    session = await generateComprehensiveNotesForSession(
      session.id,
      {
        forceRegenerate: Boolean(options.forceRegenerateNotes),
        startFromChunkIndex: options.startFromChunkIndex ?? null
      },
      (ev) => {
        emitSessionEvent(session.id, ev);
      }
    );

    return session;
  } catch (err) {
    const session = await SessionStorage.getSession(sessionId);
    if (session) {
      await SessionStorage.updateLectureFields(session.id, {
        status: 'error',
        error: err.message || String(err),
        statusMessage: `Error: ${err.message || String(err)}`
      });
    }
    emitSessionEvent(sessionId, {
      type: 'error',
      error: err.message || String(err),
      message: `Pipeline stopped: ${err.message || String(err)}`
    });
    throw err;
  } finally {
    activeRuns.delete(sessionId);
  }
}

/**
 * Reprocesses a single chunk's transcript with a chosen model (e.g. gemini-2.5-pro)
 * and anti-hallucination guardrails, and optionally updates notes from that chunk onward.
 */
export async function runSingleChunkReprocess(sessionId, chunkIndex, options = {}) {
  activeRuns.add(sessionId);
  try {
    let session = await retranscribeSingleChunkInSession(
      sessionId,
      chunkIndex,
      {
        model: options.model,
        enhanceAudio: options.enhanceAudio !== false,
        customHint: options.customHint || ''
      },
      (ev) => emitSessionEvent(sessionId, ev)
    );

    if (options.updateNotesFromHere) {
      session = await generateComprehensiveNotesForSession(
        sessionId,
        {
          forceRegenerate: false,
          startFromChunkIndex: Number(chunkIndex)
        },
        (ev) => emitSessionEvent(sessionId, ev)
      );
    }

    return session;
  } catch (err) {
    emitSessionEvent(sessionId, {
      type: 'error',
      error: err.message || String(err),
      message: `Chunk reprocess stopped: ${err.message || String(err)}`
    });
    throw err;
  } finally {
    activeRuns.delete(sessionId);
  }
}
