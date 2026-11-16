import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';

export function formatSeconds(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export class SessionStorage {
  static getSessionDir(sessionId) {
    // Sanitize sessionId to prevent path traversal
    const safeId = path.basename(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(CONFIG.sessionsDir, safeId);
  }

  static createSession({ title, topic = '', sourceType = 'upload', originalFileName = '', gdriveUrl = '' }) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const shortRand = crypto.randomBytes(3).toString('hex');
    const sessionId = `rec_${timestamp}_${shortRand}`;
    const sessionDir = this.getSessionDir(sessionId);

    fs.mkdirSync(path.join(sessionDir, 'source'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'chunks'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'transcripts'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'notes'), { recursive: true });

    const now = new Date().toISOString();
    const session = {
      id: sessionId,
      title: title || originalFileName || 'Untitled Lecture Recording',
      topic: topic || '',
      sourceType,
      originalFileName,
      gdriveUrl,
      createdAt: now,
      updatedAt: now,
      status: 'created',
      statusMessage: 'Session initialized',
      error: null,
      audioMetadata: null,
      chunks: [],
      noteSections: [],
      masterIndexMarkdown: '',
      fullTranscriptWords: 0,
      notesWords: 0
    };

    this.saveSession(session);
    return session;
  }

  static saveSession(session) {
    const sessionDir = this.getSessionDir(session.id);
    fs.mkdirSync(sessionDir, { recursive: true });
    session.updatedAt = new Date().toISOString();
    atomicWriteJson(path.join(sessionDir, 'session.json'), session);
    return session;
  }

  static getSession(sessionId) {
    const sessionDir = this.getSessionDir(sessionId);
    const sessionFile = path.join(sessionDir, 'session.json');
    if (!fs.existsSync(sessionFile)) return null;
    try {
      const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      return session;
    } catch {
      return null;
    }
  }

  static listSessions() {
    if (!fs.existsSync(CONFIG.sessionsDir)) return [];
    const entries = fs.readdirSync(CONFIG.sessionsDir, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const s = this.getSession(entry.name);
      if (s) {
        const completedChunks = (s.chunks || []).filter((c) => c.status === 'completed').length;
        const totalChunks = (s.chunks || []).length;
        sessions.push({
          id: s.id,
          title: s.title,
          topic: s.topic,
          sourceType: s.sourceType,
          originalFileName: s.originalFileName,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          status: s.status,
          statusMessage: s.statusMessage,
          error: s.error,
          audioMetadata: s.audioMetadata,
          completedChunks,
          totalChunks,
          fullTranscriptWords: s.fullTranscriptWords || 0,
          notesWords: s.notesWords || 0
        });
      }
    }
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sessions;
  }

  static saveChunkTranscript(sessionId, chunkIndex, transcriptText, modelUsed = '') {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const sessionDir = this.getSessionDir(sessionId);
    const chunk = session.chunks.find((c) => c.index === chunkIndex);
    if (!chunk) throw new Error(`Chunk ${chunkIndex} not found in session ${sessionId}`);

    const now = new Date().toISOString();
    chunk.status = 'completed';
    chunk.transcriptText = transcriptText;
    chunk.wordCount = countWords(transcriptText);
    chunk.modelUsed = modelUsed;
    chunk.updatedAt = now;

    // Persist individual chunk files immediately
    const chunkBase = `chunk_${String(chunkIndex).padStart(3, '0')}`;
    const transcriptsDir = path.join(sessionDir, 'transcripts');
    fs.mkdirSync(transcriptsDir, { recursive: true });

    atomicWriteJson(path.join(transcriptsDir, `${chunkBase}.json`), {
      sessionId,
      chunkIndex,
      startTimeSec: chunk.startTimeSec,
      endTimeSec: chunk.endTimeSec,
      startFormatted: chunk.startFormatted,
      endFormatted: chunk.endFormatted,
      modelUsed,
      wordCount: chunk.wordCount,
      updatedAt: now,
      transcriptText
    });

    fs.writeFileSync(
      path.join(transcriptsDir, `${chunkBase}.txt`),
      `# Chunk ${chunkIndex + 1} [${chunk.startFormatted} - ${chunk.endFormatted}]\n\n${transcriptText}\n`,
      'utf8'
    );

    // Rebuild cumulative full_transcript.md and full_transcript.txt immediately
    this.rebuildFullTranscriptFiles(session);
    this.saveSession(session);
    return session;
  }

  static rebuildFullTranscriptFiles(session) {
    const sessionDir = this.getSessionDir(session.id);
    const completed = (session.chunks || [])
      .filter((c) => c.status === 'completed' && c.transcriptText)
      .sort((a, b) => a.index - b.index);

    let totalWords = 0;
    const mdLines = [
      `# ${session.title} — Full Verbatim Transcript`,
      session.topic ? `**Topic / Course Context:** ${session.topic}` : '',
      session.audioMetadata?.durationFormatted
        ? `**Total Audio Duration:** ${session.audioMetadata.durationFormatted} | **Chunks Stored:** ${completed.length}/${session.chunks.length}`
        : '',
      `---`,
      ''
    ].filter(Boolean);

    const txtLines = [];

    for (const c of completed) {
      totalWords += countWords(c.transcriptText);
      mdLines.push(`### Segment ${c.index + 1} (${c.startFormatted} – ${c.endFormatted})`);
      mdLines.push('');
      mdLines.push(c.transcriptText.trim());
      mdLines.push('');
      mdLines.push('---');
      mdLines.push('');

      txtLines.push(`[Segment ${c.index + 1}: ${c.startFormatted} - ${c.endFormatted}]`);
      txtLines.push(c.transcriptText.trim());
      txtLines.push('');
    }

    session.fullTranscriptWords = totalWords;
    fs.writeFileSync(path.join(sessionDir, 'full_transcript.md'), mdLines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'full_transcript.txt'), txtLines.join('\n'), 'utf8');
  }

  static saveNoteSection(sessionId, sectionIndex, contentMarkdown, modelUsed = '') {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const sessionDir = this.getSessionDir(sessionId);
    const section = session.noteSections.find((s) => s.sectionIndex === sectionIndex);
    if (!section) throw new Error(`Note section ${sectionIndex} not found in session ${sessionId}`);

    section.status = 'completed';
    section.contentMarkdown = contentMarkdown;
    section.wordCount = countWords(contentMarkdown);
    section.modelUsed = modelUsed;
    section.updatedAt = new Date().toISOString();

    const notesDir = path.join(sessionDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    const secFile = path.join(notesDir, `section_${String(sectionIndex).padStart(3, '0')}.md`);
    fs.writeFileSync(secFile, contentMarkdown, 'utf8');

    this.rebuildComprehensiveNotesFile(session);
    this.saveSession(session);
    return session;
  }

  static saveMasterIndex(sessionId, masterIndexMarkdown) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.masterIndexMarkdown = masterIndexMarkdown;
    const sessionDir = this.getSessionDir(sessionId);
    const notesDir = path.join(sessionDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'master_index.md'), masterIndexMarkdown, 'utf8');
    this.rebuildComprehensiveNotesFile(session);
    this.saveSession(session);
    return session;
  }

  static rebuildComprehensiveNotesFile(session) {
    const sessionDir = this.getSessionDir(session.id);
    const completedSections = (session.noteSections || [])
      .filter((s) => s.status === 'completed' && s.contentMarkdown)
      .sort((a, b) => a.sectionIndex - b.sectionIndex);

    const lines = [
      `# ${session.title} — Comprehensive Lecture & Discussion Notes`,
      session.topic ? `**Subject / Topic:** ${session.topic}` : '',
      session.audioMetadata?.durationFormatted ? `**Recording Duration:** ${session.audioMetadata.durationFormatted}` : '',
      `*Generated from ${session.chunks?.length || 0} verbatim audio transcript chunks (${session.fullTranscriptWords || 0} words)*`,
      '',
      '---',
      ''
    ].filter((l) => l !== '');

    if (session.masterIndexMarkdown) {
      lines.push(session.masterIndexMarkdown.trim());
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    lines.push('## Exhaustive Chronological Breakdown');
    lines.push('');

    for (const sec of completedSections) {
      lines.push(`### Part ${sec.sectionIndex + 1}: ${sec.startFormatted} – ${sec.endFormatted}`);
      lines.push('');
      lines.push(sec.contentMarkdown.trim());
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    const fullNotes = lines.join('\n');
    session.notesWords = countWords(fullNotes);
    fs.writeFileSync(path.join(sessionDir, 'comprehensive_notes.md'), fullNotes, 'utf8');
  }

  static getFullTranscriptMarkdown(sessionId) {
    const sessionDir = this.getSessionDir(sessionId);
    const p = path.join(sessionDir, 'full_transcript.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    return '';
  }

  static getComprehensiveNotesMarkdown(sessionId) {
    const sessionDir = this.getSessionDir(sessionId);
    const p = path.join(sessionDir, 'comprehensive_notes.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    return '';
  }

  static deleteSession(sessionId) {
    const sessionDir = this.getSessionDir(sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      return true;
    }
    return false;
  }
}
