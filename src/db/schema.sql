-- ============================================================================
-- RecordNote PostgreSQL Database Schema (Server: mynewserver)
-- Relational Hierarchy: subjects (1) -> (N) lectures (1) -> (N) transcript_chunks
--                                                    (1) -> (N) lecture_notes
-- ============================================================================

-- 1. SUBJECTS TABLE
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  code VARCHAR(16) UNIQUE NOT NULL,
  name VARCHAR(120) UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. LECTURES TABLE
CREATE TABLE IF NOT EXISTS lectures (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  lecture_number INTEGER NOT NULL,
  code VARCHAR(32) UNIQUE NOT NULL, -- e.g. GT-L01, NT-L02, PHY-L01
  title TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  source_type VARCHAR(24) NOT NULL DEFAULT 'upload',
  original_file_name TEXT NOT NULL DEFAULT '',
  source_file_path TEXT NOT NULL DEFAULT '',
  gdrive_url TEXT NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  status_message TEXT NOT NULL DEFAULT '',
  error TEXT,
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_formatted VARCHAR(32) NOT NULL DEFAULT '00:00',
  trim_start_sec DOUBLE PRECISION,
  trim_end_sec DOUBLE PRECISION,
  audio_format VARCHAR(32) NOT NULL DEFAULT '',
  audio_size_bytes BIGINT NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  transcript_word_count INTEGER NOT NULL DEFAULT 0,
  notes_word_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subject_id, lecture_number)
);

CREATE INDEX IF NOT EXISTS idx_lectures_subject_id ON lectures(subject_id);
CREATE INDEX IF NOT EXISTS idx_lectures_created_at ON lectures(created_at DESC);

ALTER TABLE lectures ADD COLUMN IF NOT EXISTS trim_start_sec DOUBLE PRECISION;
ALTER TABLE lectures ADD COLUMN IF NOT EXISTS trim_end_sec DOUBLE PRECISION;

-- 3. TRANSCRIPT_CHUNKS TABLE (Separate table for 5-min verbatim chunks + RAG-ready)
CREATE TABLE IF NOT EXISTS transcript_chunks (
  id TEXT PRIMARY KEY,
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  code VARCHAR(48) UNIQUE NOT NULL, -- e.g. GT-L01-C01
  file_name TEXT NOT NULL,
  start_time_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  end_time_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  start_formatted VARCHAR(32) NOT NULL DEFAULT '00:00',
  end_formatted VARCHAR(32) NOT NULL DEFAULT '00:00',
  split_on_silence BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  transcript_text TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  model_used VARCHAR(64) NOT NULL DEFAULT '',
  search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(transcript_text, ''))) STORED,
  embedding_json JSONB, -- Reserved for future 768-dim Gemini RAG vector embeddings
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lecture_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_transcript_chunks_lecture_id ON transcript_chunks(lecture_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_tsv ON transcript_chunks USING GIN (search_tsv);

-- 4. LECTURE_NOTES TABLE (Separate table for exhaustive section notes, master index & full compiled notes)
CREATE TABLE IF NOT EXISTS lecture_notes (
  id TEXT PRIMARY KEY,
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  code VARCHAR(48) UNIQUE NOT NULL, -- e.g. GT-L01-N01, GT-L01-MASTER, GT-L01-FULL
  note_type VARCHAR(32) NOT NULL,   -- 'section' | 'master_index' | 'full_compiled'
  section_index INTEGER,            -- 0, 1, 2... for 'section'; NULL for 'master_index' / 'full_compiled'
  chunk_indices INTEGER[] NOT NULL DEFAULT '{}',
  start_formatted VARCHAR(32) NOT NULL DEFAULT '',
  end_formatted VARCHAR(32) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  content_markdown TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  model_used VARCHAR(64) NOT NULL DEFAULT '',
  search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(content_markdown, ''))) STORED,
  embedding_json JSONB, -- Reserved for future 768-dim Gemini RAG vector embeddings
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lecture_notes_lecture_id ON lecture_notes(lecture_id, note_type, section_index);
CREATE INDEX IF NOT EXISTS idx_lecture_notes_tsv ON lecture_notes USING GIN (search_tsv);

-- Seed starter subjects (Graph Theory, Number Theory, Physics)
INSERT INTO subjects (id, code, name, description)
VALUES
  ('sub_gt', 'GT', 'Graph Theory', 'Vertices, edges, trees, connectivity, colorings, planarity, and network flows'),
  ('sub_nt', 'NT', 'Number Theory', 'Divisibility, primes, modular arithmetic, congruences, and cryptographic foundations'),
  ('sub_phy', 'PHY', 'Physics', 'Classical mechanics, electromagnetism, thermodynamics, quantum physics, and waves')
ON CONFLICT (code) DO NOTHING;
