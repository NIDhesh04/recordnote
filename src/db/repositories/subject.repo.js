import crypto from 'node:crypto';
import { pool, initDatabase, deriveSubjectCode } from '../postgres.js';

export class SubjectRepo {
  static async listAll() {
    await initDatabase();
    const { rows } = await pool.query(`
      SELECT
        s.id,
        s.code,
        s.name,
        s.description,
        s.created_at AS "createdAt",
        COUNT(l.id)::int AS "lectureCount"
      FROM subjects s
      LEFT JOIN lectures l ON l.subject_id = s.id
      GROUP BY s.id
      ORDER BY s.name ASC
    `);
    return rows;
  }

  static async findByIdOrCodeOrName(idOrCode) {
    await initDatabase();
    if (!idOrCode) return null;
    const val = String(idOrCode).trim();
    const { rows } = await pool.query(
      `SELECT id, code, name, description, created_at AS "createdAt"
       FROM subjects
       WHERE id = $1 OR UPPER(code) = UPPER($1) OR LOWER(name) = LOWER($1)
       LIMIT 1`,
      [val]
    );
    return rows[0] || null;
  }

  static async create({ name, code = '', description = '' }) {
    await initDatabase();
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      throw new Error('Subject name is required.');
    }

    const existing = await pool.query(
      `SELECT id, code, name, description, created_at AS "createdAt"
       FROM subjects WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [cleanName]
    );
    if (existing.rows[0]) {
      return existing.rows[0];
    }

    const baseCode = deriveSubjectCode(cleanName, code);
    let candidateCode = baseCode;
    let suffix = 2;

    while (true) {
      const check = await pool.query(`SELECT 1 FROM subjects WHERE UPPER(code) = UPPER($1)`, [candidateCode]);
      if (check.rowCount === 0) break;
      candidateCode = `${baseCode}${suffix}`;
      suffix++;
    }

    const id = `sub_${candidateCode.toLowerCase()}_${crypto.randomBytes(3).toString('hex')}`;
    const { rows } = await pool.query(
      `INSERT INTO subjects (id, code, name, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, name, description, created_at AS "createdAt"`,
      [id, candidateCode, cleanName, description || '']
    );
    return rows[0];
  }
}
