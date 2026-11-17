import { pool, initDatabase } from '../postgres.js';
import { countWords } from '../../utils/format.js';

export class NoteRepo {
  static async listByLectureId(lectureId) {
    await initDatabase();
    const { rows } = await pool.query(
      `SELECT * FROM lecture_notes WHERE lecture_id = $1 ORDER BY section_index ASC NULLS LAST`,
      [lectureId]
    );

    const noteSections = rows
      .filter((n) => n.note_type === 'section')
      .map((n) => ({
        id: n.id,
        code: n.code,
        sectionIndex: n.section_index,
        chunkIndices: n.chunk_indices || [],
        startFormatted: n.start_formatted,
        endFormatted: n.end_formatted,
        status: n.status,
        contentMarkdown: n.content_markdown,
        wordCount: n.word_count,
        modelUsed: n.model_used,
        updatedAt: n.updated_at
      }));

    const masterRow = rows.find((n) => n.note_type === 'master_index');
    const fullRow = rows.find((n) => n.note_type === 'full_compiled');

    return {
      noteSections,
      masterIndexMarkdown: masterRow ? masterRow.content_markdown : '',
      comprehensiveNotesMarkdown: fullRow ? fullRow.content_markdown : ''
    };
  }

  static async initSections(lectureId, lectureCode, sections, forceClear = false) {
    await initDatabase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (forceClear) {
        await client.query(`DELETE FROM lecture_notes WHERE lecture_id = $1`, [lectureId]);
      }

      for (const sec of sections) {
        const noteCode = `${lectureCode}-N${String(sec.sectionIndex + 1).padStart(2, '0')}`;
        const noteId = `not_${lectureId}_sec_${String(sec.sectionIndex).padStart(3, '0')}`;
        await client.query(
          `INSERT INTO lecture_notes (
            id, lecture_id, code, note_type, section_index,
            chunk_indices, start_formatted, end_formatted, status
          ) VALUES ($1, $2, $3, 'section', $4, $5, $6, $7, 'pending')
          ON CONFLICT (code) DO NOTHING`,
          [
            noteId,
            lectureId,
            noteCode,
            sec.sectionIndex,
            sec.chunkIndices || [],
            sec.startFormatted,
            sec.endFormatted
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

  static async updateSectionStatus(lectureId, sectionIndex, status) {
    await initDatabase();
    await pool.query(
      `UPDATE lecture_notes
       SET status = $1, updated_at = NOW()
       WHERE lecture_id = $2 AND note_type = 'section' AND section_index = $3`,
      [status, lectureId, sectionIndex]
    );
  }

  static async saveSectionContent(lectureId, sectionIndex, contentMarkdown, modelUsed = '') {
    await initDatabase();
    const wordCount = countWords(contentMarkdown);
    await pool.query(
      `UPDATE lecture_notes
       SET status = 'completed',
           content_markdown = $1,
           word_count = $2,
           model_used = $3,
           updated_at = NOW()
       WHERE lecture_id = $4 AND note_type = 'section' AND section_index = $5`,
      [contentMarkdown, wordCount, modelUsed || '', lectureId, sectionIndex]
    );
  }

  static async upsertMasterIndex(lectureId, lectureCode, masterIndexMarkdown, modelUsed = '') {
    await initDatabase();
    const masterCode = `${lectureCode}-MASTER`;
    const masterId = `not_${lectureId}_master`;
    const wordCount = countWords(masterIndexMarkdown);

    await pool.query(
      `INSERT INTO lecture_notes (
        id, lecture_id, code, note_type, section_index, status, content_markdown, word_count, model_used
      ) VALUES ($1, $2, $3, 'master_index', NULL, 'completed', $4, $5, $6)
      ON CONFLICT (code) DO UPDATE
      SET content_markdown = EXCLUDED.content_markdown,
          word_count = EXCLUDED.word_count,
          model_used = EXCLUDED.model_used,
          status = 'completed',
          updated_at = NOW()`,
      [masterId, lectureId, masterCode, masterIndexMarkdown, wordCount, modelUsed || '']
    );
  }

  static async upsertFullCompiledNotes(lectureId, lectureCode, fullNotesMarkdown) {
    await initDatabase();
    const totalNoteWords = countWords(fullNotesMarkdown);
    const fullCode = `${lectureCode}-FULL`;
    const fullId = `not_${lectureId}_full`;

    await pool.query(
      `INSERT INTO lecture_notes (
        id, lecture_id, code, note_type, section_index, status, content_markdown, word_count
      ) VALUES ($1, $2, $3, 'full_compiled', NULL, 'completed', $4, $5)
      ON CONFLICT (code) DO UPDATE
      SET content_markdown = EXCLUDED.content_markdown,
          word_count = EXCLUDED.word_count,
          updated_at = NOW()`,
      [fullId, lectureId, fullCode, fullNotesMarkdown, totalNoteWords]
    );

    await pool.query(
      `UPDATE lectures SET notes_word_count = $1, updated_at = NOW() WHERE id = $2`,
      [totalNoteWords, lectureId]
    );

    return totalNoteWords;
  }
}
