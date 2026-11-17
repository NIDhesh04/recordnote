import { pool, initDatabase } from '../postgres.js';
import { countWords } from '../../utils/format.js';

export class ChunkRepo {
  static async listByLectureId(lectureId) {
    await initDatabase();
    const { rows } = await pool.query(
      `SELECT * FROM transcript_chunks WHERE lecture_id = $1 ORDER BY chunk_index ASC`,
      [lectureId]
    );
    return rows.map((c) => ({
      id: c.id,
      code: c.code,
      index: c.chunk_index,
      fileName: c.file_name,
      startTimeSec: c.start_time_sec,
      endTimeSec: c.end_time_sec,
      durationSec: c.duration_sec,
      startFormatted: c.start_formatted,
      endFormatted: c.end_formatted,
      splitOnSilence: c.split_on_silence,
      status: c.status,
      transcriptText: c.transcript_text,
      wordCount: c.word_count,
      modelUsed: c.model_used,
      updatedAt: c.updated_at
    }));
  }

  static async registerChunks(lectureId, lectureCode, audioMetadata, chunkManifest) {
    await initDatabase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE lectures
         SET duration_sec = $1,
             duration_formatted = $2,
             audio_format = $3,
             audio_size_bytes = $4,
             total_chunks = $5,
             updated_at = NOW()
         WHERE id = $6`,
        [
          audioMetadata.durationSec || 0,
          audioMetadata.durationFormatted || '00:00',
          audioMetadata.format || 'mp3',
          audioMetadata.sizeBytes || 0,
          chunkManifest.length,
          lectureId
        ]
      );

      for (const c of chunkManifest) {
        const chunkCode = `${lectureCode}-C${String(c.index + 1).padStart(2, '0')}`;
        const chunkId = `chk_${lectureId}_${String(c.index).padStart(3, '0')}`;
        await client.query(
          `INSERT INTO transcript_chunks (
            id, lecture_id, chunk_index, code, file_name,
            start_time_sec, end_time_sec, duration_sec,
            start_formatted, end_formatted, split_on_silence, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
          ON CONFLICT (lecture_id, chunk_index) DO NOTHING`,
          [
            chunkId,
            lectureId,
            c.index,
            chunkCode,
            c.fileName,
            c.startTimeSec,
            c.endTimeSec,
            c.durationSec,
            c.startFormatted,
            c.endFormatted,
            Boolean(c.splitOnSilence)
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async updateStatus(lectureId, chunkIndex, status) {
    await initDatabase();
    await pool.query(
      `UPDATE transcript_chunks
       SET status = $1, updated_at = NOW()
       WHERE lecture_id = $2 AND chunk_index = $3`,
      [status, lectureId, chunkIndex]
    );
  }

  static async saveTranscript(lectureId, chunkIndex, transcriptText, modelUsed = '') {
    await initDatabase();
    const wordCount = countWords(transcriptText);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE transcript_chunks
         SET status = 'completed',
             transcript_text = $1,
             word_count = $2,
             model_used = $3,
             updated_at = NOW()
         WHERE lecture_id = $4 AND chunk_index = $5`,
        [transcriptText, wordCount, modelUsed || '', lectureId, chunkIndex]
      );

      await client.query(
        `UPDATE lectures
         SET completed_chunks = (
               SELECT COUNT(*)::int FROM transcript_chunks
               WHERE lecture_id = $1 AND status = 'completed'
             ),
             transcript_word_count = (
               SELECT COALESCE(SUM(word_count), 0)::int FROM transcript_chunks
               WHERE lecture_id = $1 AND status = 'completed'
             ),
             updated_at = NOW()
         WHERE id = $1`,
        [lectureId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
