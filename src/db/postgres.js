import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { CONFIG } from '../config.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const pool = new Pool({
  ...CONFIG.pg,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

let schemaInitialized = false;

/**
 * Ensures all 4 PostgreSQL tables (subjects, lectures, transcript_chunks, lecture_notes)
 * and indexes are created and default subjects are seeded.
 */
export async function initDatabase() {
  if (schemaInitialized) return;
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    // Recover any orphaned 'transcribing' or 'generating' states from a previous stopped server process
    await client.query(`
      UPDATE transcript_chunks
      SET status = CASE WHEN coalesce(transcript_text, '') <> '' THEN 'completed' ELSE 'pending' END,
          updated_at = NOW()
      WHERE status = 'transcribing'
    `);
    await client.query(`
      UPDATE lecture_notes
      SET status = CASE WHEN coalesce(content_markdown, '') <> '' THEN 'completed' ELSE 'pending' END,
          updated_at = NOW()
      WHERE status = 'generating'
    `);
    await client.query(`
      UPDATE lectures
      SET status = 'completed',
          status_message = 'Ready — select any chunk to reprocess or update notes',
          updated_at = NOW()
      WHERE status IN ('transcribing', 'generating_notes', 'chunking', 'downloading')
    `);
    schemaInitialized = true;
  } finally {
    client.release();
  }
}

export async function resetLectureProcessingState(lectureId) {
  await pool.query(
    `UPDATE transcript_chunks
     SET status = CASE WHEN coalesce(transcript_text, '') <> '' THEN 'completed' ELSE 'pending' END,
         updated_at = NOW()
     WHERE lecture_id = $1 AND status = 'transcribing'`,
    [lectureId]
  );
  await pool.query(
    `UPDATE lecture_notes
     SET status = CASE WHEN coalesce(content_markdown, '') <> '' THEN 'completed' ELSE 'pending' END,
         updated_at = NOW()
     WHERE lecture_id = $1 AND status = 'generating'`,
    [lectureId]
  );
  await pool.query(
    `UPDATE lectures
     SET status = 'completed',
         status_message = 'Ready — select any chunk to reprocess or update notes',
         updated_at = NOW()
     WHERE id = $1`,
    [lectureId]
  );
}

/**
 * Generates a short uppercase subject code from a subject name.
 * Examples:
 *  - "Graph Theory" -> "GT"
 *  - "Number Theory" -> "NT"
 *  - "Physics" -> "PHY"
 *  - "Operating Systems" -> "OS"
 *  - "Discrete Mathematics" -> "DM"
 */
export function deriveSubjectCode(name, customCode = '') {
  if (customCode && customCode.trim()) {
    return customCode
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
  }
  const words = String(name || 'SUB')
    .trim()
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 'SUB';
  if (words.length === 1) {
    return words[0].slice(0, 3).toUpperCase();
  }
  return words
    .slice(0, 4)
    .map((w) => w[0].toUpperCase())
    .join('');
}
