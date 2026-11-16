import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';
import { SessionStorage } from './storage.js';
import { downloadFromGoogleDrive } from './gdrive.js';
import { prepareAndChunkAudio } from './audio.js';
import { transcribeSessionChunks } from './transcriber.js';
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

/**
 * Runs or resumes the full RecordNote pipeline for a session:
 * - Downloads from Google Drive (if sourceType === 'gdrive' and source file not yet downloaded)
 * - Normalizes & splits into smart ~5-minute chunks (if not yet chunked)
 * - Transcribes every pending chunk verbatim via Gemini Flash (storing each chunk immediately)
 * - Compiles exhaustive, comprehensive multi-section lecture notes (storing each section immediately)
 */
export async function runSessionPipeline(sessionId, options = {}) {
  if (activeRuns.has(sessionId)) {
    return SessionStorage.getSession(sessionId);
  }

  activeRuns.add(sessionId);
  const targetChunkSec = Number(options.chunkTargetSec || CONFIG.chunkTargetSec);

  try {
    let session = SessionStorage.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const sessionDir = SessionStorage.getSessionDir(sessionId);
    const sourceDir = path.join(sessionDir, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });

    // Step 1: Ensure source audio file exists (download from Google Drive if needed)
    let inputFilePath = session.sourceFilePath && fs.existsSync(session.sourceFilePath)
      ? session.sourceFilePath
      : null;

    if (!inputFilePath && session.sourceType === 'gdrive' && session.gdriveUrl) {
      session.status = 'downloading';
      session.statusMessage = 'Downloading audio recording from Google Drive...';
      session.error = null;
      SessionStorage.saveSession(session);
      emitSessionEvent(sessionId, { type: 'status', status: session.status, message: session.statusMessage });

      const dl = await downloadFromGoogleDrive(session.gdriveUrl, sourceDir, (prog) => {
        session.statusMessage = prog.message;
        emitSessionEvent(sessionId, { type: 'download_progress', ...prog });
      });

      inputFilePath = dl.filePath;
      session.sourceFilePath = dl.filePath;
      session.originalFileName = dl.fileName;
      if (!session.title || session.title === 'Google Drive Audio Import') {
        session.title = path.basename(dl.fileName, path.extname(dl.fileName)).replace(/[_-]+/g, ' ');
      }
      SessionStorage.saveSession(session);
    }

    if (!inputFilePath || !fs.existsSync(inputFilePath)) {
      throw new Error('Source audio file not found for this session.');
    }

    // Step 2: Normalize & smart-chunk audio if not already chunked
    if (!session.chunks || session.chunks.length === 0) {
      session.status = 'chunking';
      session.statusMessage = 'Normalizing audio & detecting natural speech pauses for smart chunking...';
      session.error = null;
      SessionStorage.saveSession(session);
      emitSessionEvent(sessionId, { type: 'status', status: session.status, message: session.statusMessage });

      const { audioMetadata, chunks } = await prepareAndChunkAudio(
        inputFilePath,
        sessionDir,
        targetChunkSec,
        (prog) => {
          session.statusMessage = prog.message;
          emitSessionEvent(sessionId, { type: 'chunking_progress', ...prog });
        }
      );

      session.audioMetadata = audioMetadata;
      session.chunks = chunks;
      session.statusMessage = `Split ${audioMetadata.durationFormatted} audio into ${chunks.length} smart chunks.`;
      SessionStorage.saveSession(session);
      emitSessionEvent(sessionId, {
        type: 'chunks_ready',
        audioMetadata,
        totalChunks: chunks.length,
        chunks,
        message: session.statusMessage
      });
    }

    // Step 3: Transcribe all chunks sequentially with rolling context & persistent storage
    await transcribeSessionChunks(sessionId, (ev) => {
      emitSessionEvent(sessionId, ev);
    });

    // Step 4: Generate exhaustive, comprehensive notes from all stored chunk transcripts
    session = await generateComprehensiveNotesForSession(
      sessionId,
      Boolean(options.forceRegenerateNotes),
      (ev) => {
        emitSessionEvent(sessionId, ev);
      }
    );

    return session;
  } catch (err) {
    const session = SessionStorage.getSession(sessionId);
    if (session) {
      session.status = 'error';
      session.error = err.message || String(err);
      session.statusMessage = `Error: ${session.error}`;
      SessionStorage.saveSession(session);
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
