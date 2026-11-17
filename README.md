# RecordNote

**RecordNote** is a full-stack lecture and conversation transcription and textbook-grade note-taking platform built with **Node.js**, **PostgreSQL**, **FFmpeg**, and **Google Gemini (`gemini-2.5-flash` & `gemini-2.5-pro`)**.

Designed specifically for **40–45+ minute academic lectures and technical discussions** (`.mp3`, `.aac`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.webm`, `.mp4`), RecordNote eliminates the accuracy degradation, token truncation, and "lazy summarization" of single-pass audio LLMs by combining **silence-aware audio chunking**, **anti-hallucination verbatim transcription**, **PostgreSQL relational + full-text storage**, and **cumulative context-chained lecture note synthesis**.

---

## Core Features

### 1. Dual Audio Ingest & Selective Timestamp Trimming (`Start → End`)
- **Browse Computer:** Drag-and-drop or select local `.mp3`, `.aac`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.webm`, or `.mp4` files of any size.
- **Direct Google Drive Import:** Paste any shared Google Drive URL (`https://drive.google.com/file/d/.../view?usp=sharing`) or File ID. Automatically handles Google Drive's large-file virus-scan confirmation stream.
- **Interactive Preview & Zero-Storage Audio Trimming:**
  - Scrub through local audio files right inside the import form and set **Start (`MM:SS` / `HH:MM:SS`)** and **End (`MM:SS` / `HH:MM:SS`)** timestamps (or type them manually for Local/Google Drive imports).
  - `ffmpeg -ss <start> -to <end>` extracts **only** the selected time window into `normalized.mp3` and **immediately deletes (`unlink`) the raw un-trimmed file**. Unwanted parts of a recording are never stored on disk, never chunked, never sent to Gemini, and never saved in PostgreSQL.
  - Preserves original recording timeline offsets so chunk and note timestamps match the original lecture timeline.

### 2. Course Subject Organization & Semantic Sequential IDs (PostgreSQL)
- **Subject Dropdown & Dynamic Creation:** Assign recordings to existing subjects in PostgreSQL (pre-seeded with **Graph Theory (`GT`)**, **Number Theory (`NT`)**, and **Physics (`PHY`)**) or create new subjects on the fly (auto-deriving subject codes such as `Discrete Mathematics` → `DM`).
- **Dual-ID Hierarchy:** Every entity receives both an immutable internal primary key and a human-readable semantic code:
  - **Subject:** `GT`, `NT`, `PHY`, `DM`
  - **Lecture:** `GT-L01`, `GT-L02`, `NT-L01` *(auto-incremented per subject)*
  - **Transcript Chunks:** `GT-L01-C01`, `GT-L01-C02`, ..., `GT-L01-C09`
  - **Note Sections & Compiled Notes:** `GT-L01-N01`, `GT-L01-N02`, ..., `GT-L01-MASTER`, `GT-L01-FULL`

### 3. Silence-Aware Smart Chunking (`FFmpeg`)
- Converts any input audio/video format into a speech-optimized **16kHz Mono 64kbps MP3** stream.
- Scans the recording using `ffmpeg silencedetect` to find natural speech pauses around each **5-minute (300s) target window**, ensuring words are never sliced mid-syllable.

### 4. Context-Chained Verbatim Transcription + Anti-Hallucination Guardrails
- **Rolling Context Continuity:** Passes the trailing ~450 characters of Chunk $K-1$ into the prompt for Chunk $K$ (`<previous_chunk_tail>`) so sentences spanning chunk boundaries connect seamlessly without duplication.
- **Automatic Repetition & `"hmm"` Loop Detector:**
  - Inspects every chunk transcript for degenerate LLM repetition loops (e.g., 100 lines of `"hmm"`, `"Professor: Hmm / Student: Hmm"`, repeated phrases, or low lexical diversity).
- **Scoped Single-Chunk Escalation to `gemini-2.5-pro`:**
  - Every chunk starts on the fast, lightweight **`gemini-2.5-flash`** model.
  - If Chunk $K$ triggers the hallucination detector, **only Chunk $K$** is automatically passed through an FFmpeg vocal-isolation filter (`highpass=f=120,lowpass=f=7500,dynaudnorm=f=150:g=15`) and re-extracted using **`gemini-2.5-pro`** with strict anti-loop guardrails.
  - Subsequent chunks ($K+1, K+2 \dots$) automatically return to `gemini-2.5-flash` so costs stay minimal.

### 5. Per-Chunk Audio Inspection, Reprocessing & Surgical Note Updates
- **Inspect Any Historical Lecture:** Switch to any subject and past lecture from the PostgreSQL sidebar vault. Clicking any `[MM:SS]` timestamp badge inside the notes jumps directly to that chunk card in the **Stored Verbatim Transcripts** tab.
- **Embedded Chunk Audio Player:** Every 5-minute chunk card has a built-in `<audio>` player (`/api/sessions/:id/chunks/:idx/audio` with HTTP byte-range scrubbing) so you can listen to the exact audio for that chunk.
- **Per-Chunk Reprocess Toolbar:**
  - Re-extract any individual chunk using **`Gemini 2.5 Pro`**, **`Gemini 2.5 Flash`**, or **`Gemini 2.0 Flash`**, with optional **FFmpeg Speech-Boost** and a **Custom Hint** input.
  - Or manually edit a chunk's transcript text directly in the UI and save to PostgreSQL.
- **Surgical Note Regeneration:** After updating Chunk $K$, choose between **⚡ Update Notes From Chunk $K$ Onward** (keeping Notes $1 \dots K-1$ untouched) or **✦ Full Rebuild All Notes**.

### 6. Cumulative, Context-Chained Textbook-Grade Lecture Notes
- Instead of generating isolated chunk summaries, when generating structured notes for Segment $K$, RecordNote passes:
  1. `<accumulated_lecture_notes_so_far>` — **all structured lecture notes generated from Segments $1 \dots K-1$**
  2. `<previous_chunk_transcript_tail>` — the raw transcript tail of Segment $K-1$
  3. `<current_chunk_transcript>` — the full verbatim transcript of Segment $K$
- Maintains continuous section numbering (`## 1.`, `### 1.1`, `## 2.`, `### 2.1`), consistent mathematical notation, formal definitions, step-by-step derivations/proofs, worked examples, and Q&A callouts—topped with an **Executive Overview, Structured Timeline Outline, and Definitions/Formulas Reference** (`<CODE>-MASTER`).

---

## System Architecture & Pipeline Flow

```mermaid
flowchart TD
    A["Audio Input: Local Upload (.mp3, .aac, .m4a, .wav) or Google Drive Link"] --> B["FFmpeg Ingest & Optional Timestamp Trim (-ss Start -to End)"]
    B --> C["Immediate Deletion of Un-Trimmed Raw Source File"]
    C --> D["FFmpeg Silence Detection & Smart ~5-Min Chunk Splitting"]
    D --> E["PostgreSQL Registration: lectures (GT-L01) & transcript_chunks (GT-L01-C01..C09)"]
    E --> F["Sequential Context-Chained Transcription (Default: gemini-2.5-flash)"]
    F --> G{"Hallucination / 'hmm' Loop Detected?"}
    G -- "No" --> H["Save Verbatim Chunk to PostgreSQL transcript_chunks"]
    G -- "Yes (Scoped to Current Chunk Only)" --> I["FFmpeg Speech-Boost + Retry Chunk with gemini-2.5-pro & Anti-Loop Guardrails"]
    I --> H
    H --> J["Cumulative Context-Chained Note Compiler (Passes All Prior Notes + Current Transcript)"]
    J --> K["Master Reference Index & Glossary Synthesis (GT-L01-MASTER & GT-L01-FULL)"]
    K --> L["PostgreSQL lecture_notes + Live SSE UI & Markdown Exports"]
```

---

## PostgreSQL Database Schema (`src/db/schema.sql`)

RecordNote uses 4 normalized relational tables with native PostgreSQL Full-Text Search (`TSVECTOR` + `GIN` indexes) and `JSONB` embedding columns reserved for future RAG ("Chat with Your Subject Notes"):

```
subjects (1) ──────< (N) lectures (1) ──────< (N) transcript_chunks
                                  (1) ──────< (N) lecture_notes
```

| Table | Primary Key | Semantic Code | Key Columns |
| :--- | :--- | :--- | :--- |
| **`subjects`** | `id` (`sub_gt`) | `code` (`GT`, `NT`, `PHY`) | `name`, `description`, `created_at` |
| **`lectures`** | `id` (`lec_gtl01_...`) | `code` (`GT-L01`) | `subject_id`, `lecture_number`, `title`, `topic`, `trim_start_sec`, `trim_end_sec`, `duration_sec`, `status`, `transcript_word_count`, `notes_word_count` |
| **`transcript_chunks`** | `id` (`chk_...`) | `code` (`GT-L01-C01`) | `lecture_id`, `chunk_index`, `start_time_sec`, `end_time_sec`, `status`, `transcript_text`, `word_count`, `model_used`, `search_tsv` (`TSVECTOR`), `embedding_json` |
| **`lecture_notes`** | `id` (`not_...`) | `code` (`GT-L01-N01`, `GT-L01-MASTER`, `GT-L01-FULL`) | `lecture_id`, `note_type`, `section_index`, `chunk_indices`, `status`, `content_markdown`, `word_count`, `model_used`, `search_tsv` (`TSVECTOR`), `embedding_json` |

---

## Modular Project Structure

```
recordnote/
├── src/
│   ├── config.js                         # Env loader, Gemini & PostgreSQL connection config
│   ├── server.js                         # HTTP server entrypoint & static asset handler
│   ├── cli.js                            # Command-line runner for local files & Google Drive links
│   ├── db/
│   │   ├── postgres.js                   # pg.Pool, schema initializer & orphan-state recovery
│   │   ├── schema.sql                    # Normalized DDL for subjects, lectures, chunks & notes
│   │   └── repositories/
│   │       ├── subject.repo.js           # SQL CRUD for `subjects`
│   │       ├── lecture.repo.js           # SQL CRUD for `lectures` & sequential numbering
│   │       ├── chunk.repo.js             # SQL CRUD for `transcript_chunks`
│   │       └── note.repo.js              # SQL CRUD for `lecture_notes`
│   ├── ai/
│   │   ├── gemini.client.js              # Gemini REST client, pacing, retry & model fallback
│   │   ├── guards/
│   │   │   └── hallucination.js          # Repetition / "hmm" loop detector & transcript sanitizer
│   │   └── prompts/
│   │       ├── transcript.prompt.js      # Verbatim transcription prompts & anti-loop rules
│   │       └── notes.prompt.js           # Cumulative textbook notes & master index prompts
│   ├── services/
│   │   ├── audio.js                      # FFmpeg normalization, timestamp trim, silence split & speech-boost
│   │   ├── gdrive.js                     # Google Drive stream downloader & confirmation bypass
│   │   ├── transcriber.js                # Chunk transcription & per-chunk reprocessing orchestrator
│   │   ├── notes.js                      # Cumulative notes & surgical note update orchestrator
│   │   ├── exporter.js                   # Markdown (.md) & plain-text (.txt) file builder
│   │   ├── storage.js                    # Unified storage facade over repositories & exporter
│   │   └── pipeline.js                   # Background job runner & Server-Sent Events (SSE) bus
│   ├── routes/
│   │   ├── subjects.routes.js            # GET/POST /api/subjects
│   │   ├── lectures.routes.js            # /api/sessions (upload, gdrive, resume, notes, SSE, export)
│   │   └── chunks.routes.js              # /api/sessions/:id/chunks/:idx (audio stream, reprocess, edit)
│   └── utils/
│       ├── format.js                     # Timestamp & word-count utilities
│       └── http.js                       # JSON & HTTP byte-range audio streaming helpers
├── public/
│   ├── index.html                        # Web application shell
│   ├── styles.css                        # Dark-mode academic UI & Markdown typography
│   ├── app.js                            # Main frontend controller
│   └── js/
│       ├── api.js                        # Upload XHR, Google Drive & chunk reprocess client
│       ├── markdown.js                   # Markdown-to-HTML renderer with clickable timestamps
│       ├── transcript-view.js            # Chunk cards, mini audio players & reprocess/edit toolbar
│       └── utils.js                      # Client formatting helpers
└── scripts/
    └── test-pipeline.js                  # End-to-end automated verification test suite
```

---

## Getting Started

### Prerequisites
- **Node.js** `>= 20.0.0`
- **PostgreSQL** running locally or in the cloud
- **FFmpeg** & **FFprobe** installed and available on system `PATH`

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure `.env`
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```
```ini
GEMINI_API_KEY=your_gemini_api_key_here
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/postgres
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your_password
PGDATABASE=postgres
```

### 3. Start the Web Application
```bash
npm start
```
Open **http://localhost:3456** in your browser. (`npm start` runs with `node --watch` so backend changes reload automatically.)

### 4. Command-Line Interface (CLI) Usage
```bash
# Process a full local .aac or .mp3 recording under "Graph Theory"
npm run cli -- --file ./lecture.aac --subject "Graph Theory" --title "Planar Graphs & Euler's Formula"

# Process ONLY a specific timestamp range (e.g. 05:30 to 38:00) and discard the rest
npm run cli -- --file ./lecture.mp3 --subject "Physics" --start 05:30 --end 38:00 --title "Wave Optics"

# Import directly from a Google Drive shared link
npm run cli -- --gdrive "https://drive.google.com/file/d/YOUR_FILE_ID/view?usp=sharing" --subject "Number Theory"
```

### 5. Run Automated Verification Suite
```bash
npm run test:pipeline
```

---

## REST API Summary

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Health check, PostgreSQL status, and active model info |
| `GET` | `/api/subjects` | List all subjects and their lecture counts |
| `POST` | `/api/subjects` | Create a new subject (`{ name, code, description }`) |
| `GET` | `/api/sessions?subjectId=...` | List stored lectures (optionally filtered by subject) |
| `POST` | `/api/sessions/upload` | Stream-upload a local audio file with optional `X-Trim-Start` / `X-Trim-End` headers |
| `POST` | `/api/sessions/gdrive` | Import audio from Google Drive with optional `trimStart` / `trimEnd` |
| `GET` | `/api/sessions/:id` | Get full lecture details, stored chunks, and compiled Markdown notes |
| `GET` | `/api/sessions/:id/events` | Server-Sent Events (SSE) stream for real-time progress updates |
| `GET` | `/api/sessions/:id/chunks/:idx/audio` | Stream individual 5-minute chunk MP3 with HTTP byte-range support |
| `POST` | `/api/sessions/:id/chunks/:idx/retranscribe` | Re-extract a single chunk with chosen model (`gemini-2.5-pro`), speech-boost & guardrails |
| `PUT` | `/api/sessions/:id/chunks/:idx` | Save manual edits to a chunk's transcript in PostgreSQL |
| `POST` | `/api/sessions/:id/regenerate-notes` | Rebuild all notes or surgically update from `{ startFromChunkIndex }` onward |
| `GET` | `/api/sessions/:id/export/notes.md` | Download compiled comprehensive lecture notes as Markdown |
| `GET` | `/api/sessions/:id/export/transcript.md` | Download stitched verbatim lecture transcript as Markdown |
