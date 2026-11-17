import crypto from 'node:crypto';
import { pool, initDatabase } from '../postgres.js';

export class LectureRepo {
  static async create({
    subject,
    title = '',
    topic = '',
    sourceType = 'upload',
    originalFileName = '',
    gdriveUrl = '',
    trimStartSec = null,
    trimEndSec = null
  }) {
    await initDatabase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock subject row to safely compute sequential lecture_number
      await client.query(`SELECT id FROM subjects WHERE id = $1 FOR UPDATE`, [subject.id]);
      const seqRes = await client.query(
        `SELECT COALESCE(MAX(lecture_number), 0) + 1 AS next_num FROM lectures WHERE subject_id = $1`,
        [subject.id]
      );
      const lectureNumber = Number(seqRes.rows[0].next_num || 1);
      const lectureCode = `${subject.code}-L${String(lectureNumber).padStart(2, '0')}`;

      const shortRand = crypto.randomBytes(3).toString('hex');
      const sessionId = `lec_${lectureCode.toLowerCase().replace(/[^a-z0-9]/g, '')}_${shortRand}`;
      const finalTitle = title.trim() || `${subject.name} — Lecture ${lectureNumber}`;

      await client.query(
        `INSERT INTO lectures (
          id, subject_id, lecture_number, code, title, topic,
          source_type, original_file_name, gdrive_url, trim_start_sec, trim_end_sec, status, status_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'created', 'Lecture initialized in PostgreSQL')`,
        [
          sessionId,
          subject.id,
          lectureNumber,
          lectureCode,
          finalTitle,
          topic || '',
          sourceType,
          originalFileName || '',
          gdriveUrl || '',
          trimStartSec !== null && trimStartSec !== '' ? Number(trimStartSec) : null,
          trimEndSec !== null && trimEndSec !== '' ? Number(trimEndSec) : null
        ]
      );

      await client.query('COMMIT');
      return sessionId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async updateFields(sessionId, fields = {}) {
    await initDatabase();
    const keys = Object.keys(fields);
    if (keys.length === 0) return;

    const colMap = {
      title: 'title',
      topic: 'topic',
      sourceFilePath: 'source_file_path',
      originalFileName: 'original_file_name',
      status: 'status',
      statusMessage: 'status_message',
      error: 'error',
      durationSec: 'duration_sec',
      durationFormatted: 'duration_formatted',
      audioFormat: 'audio_format',
      audioSizeBytes: 'audio_size_bytes',
      totalChunks: 'total_chunks',
      completedChunks: 'completed_chunks',
      transcriptWordCount: 'transcript_word_count',
      notesWordCount: 'notes_word_count'
    };

    const setClauses = ['updated_at = NOW()'];
    const values = [];
    let paramIdx = 1;

    for (const k of keys) {
      const col = colMap[k] || k;
      setClauses.push(`${col} = $${paramIdx++}`);
      values.push(fields[k]);
    }
    values.push(sessionId);

    await pool.query(
      `UPDATE lectures SET ${setClauses.join(', ')} WHERE id = $${paramIdx} OR code = $${paramIdx}`,
      values
    );
  }

  static async findByIdOrCode(idOrCode) {
    await initDatabase();
    if (!idOrCode) return null;
    const { rows } = await pool.query(
      `SELECT
        l.*,
        s.code AS subject_code,
        s.name AS subject_name
       FROM lectures l
       JOIN subjects s ON s.id = l.subject_id
       WHERE l.id = $1 OR UPPER(l.code) = UPPER($1)
       LIMIT 1`,
      [String(idOrCode).trim()]
    );
    return rows[0] || null;
  }

  static async listAll(subjectId = '') {
    await initDatabase();
    const params = [];
    let whereSql = '';
    if (subjectId && subjectId !== 'all') {
      params.push(subjectId);
      whereSql = `WHERE l.subject_id = $1 OR UPPER(s.code) = UPPER($1)`;
    }

    const { rows } = await pool.query(
      `SELECT
        l.id,
        l.code,
        l.lecture_number AS "lectureNumber",
        l.subject_id AS "subjectId",
        s.code AS "subjectCode",
        s.name AS "subjectName",
        l.title,
        l.topic,
        l.source_type AS "sourceType",
        l.original_file_name AS "originalFileName",
        l.created_at AS "createdAt",
        l.updated_at AS "updatedAt",
        l.status,
        l.status_message AS "statusMessage",
        l.error,
        l.duration_sec AS "durationSec",
        l.duration_formatted AS "durationFormatted",
        l.total_chunks AS "totalChunks",
        l.completed_chunks AS "completedChunks",
        l.transcript_word_count AS "fullTranscriptWords",
        l.notes_word_count AS "notesWords"
       FROM lectures l
       JOIN subjects s ON s.id = l.subject_id
       ${whereSql}
       ORDER BY l.created_at DESC`,
      params
    );

    return rows.map((r) => ({
      ...r,
      audioMetadata: r.durationSec
        ? {
            durationSec: r.durationSec,
            durationFormatted: r.durationFormatted
          }
        : null
    }));
  }

  static async deleteById(lectureId) {
    await initDatabase();
    await pool.query(`DELETE FROM lectures WHERE id = $1`, [lectureId]);
  }
}
