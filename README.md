# RecordNote

**RecordNote** is a full-stack lecture and conversation transcription and exhaustive note-taking application powered by **FFmpeg Smart Silence-Aware Audio Chunking** and **Google Gemini Flash**.

Designed specifically for **40–45+ minute lecture recordings** (`.mp3`, `.aac`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.webm`, `.mp4`), RecordNote avoids the accuracy degradation and lazy summarization of single-shot long-audio calls by slicing recordings at natural speech pauses (~5-minute chunks), transcribing every chunk verbatim with rolling context, persisting every single chunk transcript to disk immediately, and compiling **exhaustive, textbook-grade notes** that document every detail discussed.

---

## Key Features

1. **Dual Audio Import Modes**
   - **Browse Computer:** Drag-and-drop or browse local `.mp3`, `.aac`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.webm`, or `.mp4` recordings of any length.
   - **Direct Google Drive Import:** Paste any shared Google Drive audio link (`https://drive.google.com/file/d/.../view?usp=sharing`) or File ID. Automatically handles large-file virus-scan confirmation streams.
2. **Smart Silence-Aware Audio Chunking (`FFmpeg`)**
   - Normalizes input audio (`.aac`, `.mp3`, etc.) to a clean 16kHz Mono speech stream.
   - Scans for natural pauses (`silencedetect`) around each 5-minute mark so words are never sliced mid-syllable.
3. **Context-Chained Verbatim Transcription (Free-Tier Paced)**
   - Feeds the tail of Chunk $N-1$ into Chunk $N$ so sentences spanning chunk boundaries connect seamlessly.
   - Built-in pacing and exponential retry designed to run at **$0 cost** on the Google AI Studio Free Tier.
4. **Continuous Persistent Disk Vault (`data/sessions/`)**
   - Every chunk transcript is written to disk (`transcripts/chunk_XXX.json`, `full_transcript.md`, `full_transcript.txt`) the exact moment it finishes.
   - Interrupted sessions can be resumed from the exact chunk where they stopped without re-transcribing completed chunks.
5. **Exhaustive, Comprehensive Lecture Notes (Never Just a Summary)**
   - Compiles multi-part, textbook-depth notes across 2-chunk (~10-minute) windows so nothing is compressed or skipped—preserving every concept, step-by-step explanation, example, analogy, formula, and Q&A discussion, topped with a **Master Reference Index & Glossary**.

---

## Quick Start

### Prerequisites
- **Node.js** `>= 20.0.0`
- **FFmpeg** & **FFprobe** available on system `PATH`

### 1. Configure Environment
Copy `.env.example` to `.env` and add your Google AI Studio API key:
```bash
cp .env.example .env
```

### 2. Start the Web Application
```bash
npm start
```
Then open **http://localhost:3456** in your browser.

### 3. Or Run via CLI
```bash
# Local .mp3 or .aac file
npm run cli -- --file ./lecture.aac --title "CS301 Lecture 12" --topic "Virtual Memory & Paging"

# Direct from Google Drive link
npm run cli -- --gdrive "https://drive.google.com/file/d/YOUR_FILE_ID/view?usp=sharing" --title "Physics Lecture 4"
```

### 4. Run Automated Pipeline Verification
```bash
npm run test:pipeline
```
