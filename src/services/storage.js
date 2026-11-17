import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { SubjectRepo } from '../db/repositories/subject.repo.js';
import { LectureRepo } from '../db/repositories/lecture.repo.js';
import { ChunkRepo } from '../db/repositories/chunk.repo.js';
import { NoteRepo } from '../db/repositories/note.repo.js';
import { ExporterService } from './exporter.js';
import { formatSeconds, countWords } from '../utils/format.js';

export { formatSeconds, countWords };

/**
 * Unified Storage Facade coordinating the 4 PostgreSQL Repositories
 * (`SubjectRepo`, `LectureRepo`, `ChunkRepo`, `NoteRepo`) and disk exports (`ExporterService`).
 */
export class SessionStorage {
  static getSessionDir(sessionId) {
    const safeId = path.basename(String(sessionId)).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(CONFIG.sessionsDir, safeId);
  }

  // --- Subjects ---
  static async listSubjects() {
    return SubjectRepo.listAll();
  }

  static async getSubject(idOrCode) {
    return SubjectRepo.findByIdOrCodeOrName(idOrCode);
  }

  static async createSubject(data) {
    return SubjectRepo.create(data);
  }

  // --- Lectures ---
  static async createSession({
    subjectId = '',
    newSubjectName = '',
    newSubjectCode = '',
    title = '',
    topic = '',
    sourceType = 'upload',
    originalFileName = '',
    gdriveUrl = '',
    trimStartSec = null,
    trimEndSec = null
  }) {
    let subject = null;
    if (newSubjectName && newSubjectName.trim()) {
      subject = await SubjectRepo.create({ name: newSubjectName, code: newSubjectCode });
    } else if (subjectId) {
      subject = await SubjectRepo.findByIdOrCodeOrName(subjectId);
    }

    if (!subject) {
      const all = await SubjectRepo.listAll();
      subject = all[0] || (await SubjectRepo.create({ name: 'General Studies', code: 'GEN' }));
    }

    const sessionId = await LectureRepo.create({
      subject,
      title,
      topic,
      sourceType,
      originalFileName,
      gdriveUrl,
      trimStartSec,
      trimEndSec
    });

    const sessionDir = this.getSessionDir(sessionId);
    fs.mkdirSync(path.join(sessionDir, 'source'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'chunks'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'transcripts'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'notes'), { recursive: true });

    return this.getSession(sessionId);
  }

  static async updateLectureFields(sessionId, fields = {}) {
    await LectureRepo.updateFields(sessionId, fields);
    return this.getSession(sessionId);
  }

  static async listSessions(subjectId = '') {
    return LectureRepo.listAll(subjectId);
  }

  static async deleteSession(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    await LectureRepo.deleteById(session.id);
    const sessionDir = this.getSessionDir(session.id);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    return true;
  }

  // --- Chunks ---
  static async registerChunks(sessionId, audioMetadata, chunkManifest) {
    const row = await LectureRepo.findByIdOrCode(sessionId);
    if (!row) throw new Error(`Lecture not found: ${sessionId}`);
    await ChunkRepo.registerChunks(row.id, row.code, audioMetadata, chunkManifest);
    return this.getSession(row.id);
  }

  static async markChunkStatus(sessionId, chunkIndex, status, statusMessage = null) {
    await ChunkRepo.updateStatus(sessionId, chunkIndex, status);
    if (statusMessage) {
      await LectureRepo.updateFields(sessionId, { statusMessage });
    }
  }

  static async saveChunkTranscript(sessionId, chunkIndex, transcriptText, modelUsed = '') {
    await ChunkRepo.saveTranscript(sessionId, chunkIndex, transcriptText, modelUsed);
    const updatedSession = await this.getSession(sessionId);
    ExporterService.writeTranscriptFilesToDisk(this.getSessionDir(updatedSession.id), updatedSession);
    return updatedSession;
  }

  // --- Notes ---
  static async initNoteSections(sessionId, sections, forceClear = false) {
    const row = await LectureRepo.findByIdOrCode(sessionId);
    if (!row) throw new Error(`Lecture not found: ${sessionId}`);
    await NoteRepo.initSections(row.id, row.code, sections, forceClear);
    return this.getSession(row.id);
  }

  static async markNoteSectionStatus(sessionId, sectionIndex, status, statusMessage = null) {
    await NoteRepo.updateSectionStatus(sessionId, sectionIndex, status);
    if (statusMessage) {
      await LectureRepo.updateFields(sessionId, { statusMessage });
    }
  }

  static async saveNoteSection(sessionId, sectionIndex, contentMarkdown, modelUsed = '') {
    await NoteRepo.saveSectionContent(sessionId, sectionIndex, contentMarkdown, modelUsed);
    return this.rebuildCompiledNotesInDb(sessionId);
  }

  static async saveMasterIndex(sessionId, masterIndexMarkdown, modelUsed = '') {
    const row = await LectureRepo.findByIdOrCode(sessionId);
    if (!row) throw new Error(`Lecture not found: ${sessionId}`);
    await NoteRepo.upsertMasterIndex(row.id, row.code, masterIndexMarkdown, modelUsed);
    return this.rebuildCompiledNotesInDb(row.id);
  }

  static async rebuildCompiledNotesInDb(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) return null;
    const fullNotesMarkdown = ExporterService.buildCompiledNotesMarkdown(session);
    await NoteRepo.upsertFullCompiledNotes(session.id, session.code, fullNotesMarkdown);
    ExporterService.writeNotesFileToDisk(this.getSessionDir(session.id), fullNotesMarkdown);
    return this.getSession(session.id);
  }

  // --- Hydration & Exports ---
  static async getSession(idOrCode) {
    const row = await LectureRepo.findByIdOrCode(idOrCode);
    if (!row) return null;

    const [chunks, notesData] = await Promise.all([
      ChunkRepo.listByLectureId(row.id),
      NoteRepo.listByLectureId(row.id)
    ]);

    return {
      id: row.id,
      code: row.code,
      lectureNumber: row.lecture_number,
      subjectId: row.subject_id,
      subjectCode: row.subject_code,
      subjectName: row.subject_name,
      title: row.title,
      topic: row.topic,
      sourceType: row.source_type,
      originalFileName: row.original_file_name,
      sourceFilePath: row.source_file_path,
      gdriveUrl: row.gdrive_url,
      trimStartSec: row.trim_start_sec,
      trimEndSec: row.trim_end_sec,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
      statusMessage: row.status_message,
      error: row.error,
      audioMetadata: row.duration_sec
        ? {
            durationSec: row.duration_sec,
            durationFormatted: row.duration_formatted,
            format: row.audio_format,
            sizeBytes: Number(row.audio_size_bytes || 0)
          }
        : null,
      chunks,
      noteSections: notesData.noteSections,
      masterIndexMarkdown: notesData.masterIndexMarkdown,
      comprehensiveNotesMarkdown: notesData.comprehensiveNotesMarkdown,
      fullTranscriptWords: row.transcript_word_count || 0,
      notesWords: row.notes_word_count || 0
    };
  }

  static async getFullTranscriptMarkdown(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) return '';
    const sessionDir = this.getSessionDir(session.id);
    const p = path.join(sessionDir, 'full_transcript.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    ExporterService.writeTranscriptFilesToDisk(sessionDir, session);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }

  static async getComprehensiveNotesMarkdown(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) return '';
    if (session.comprehensiveNotesMarkdown) return session.comprehensiveNotesMarkdown;
    const sessionDir = this.getSessionDir(session.id);
    const p = path.join(sessionDir, 'comprehensive_notes.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }
}
