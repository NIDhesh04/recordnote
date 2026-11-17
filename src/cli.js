import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { pool } from './db/postgres.js';
import { SessionStorage } from './services/storage.js';
import { parseTimestampToSeconds } from './services/audio.js';
import { runSessionPipeline, pipelineEvents } from './services/pipeline.js';

function parseArgs(argv) {
  const args = {
    file: '',
    gdrive: '',
    subject: 'Graph Theory',
    title: '',
    topic: '',
    start: '',
    end: '',
    chunkSec: CONFIG.chunkTargetSec
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') args.file = argv[++i] || '';
    else if (arg === '--gdrive' || arg === '-g') args.gdrive = argv[++i] || '';
    else if (arg === '--subject' || arg === '-s') args.subject = argv[++i] || '';
    else if (arg === '--title' || arg === '-t') args.title = argv[++i] || '';
    else if (arg === '--topic' || arg === '-c') args.topic = argv[++i] || '';
    else if (arg === '--start') args.start = argv[++i] || '';
    else if (arg === '--end') args.end = argv[++i] || '';
    else if (arg === '--chunk-sec') args.chunkSec = Number(argv[++i] || CONFIG.chunkTargetSec);
    else if (!arg.startsWith('-') && !args.file && !args.gdrive) {
      if (arg.startsWith('http://') || arg.startsWith('https://')) args.gdrive = arg;
      else args.file = arg;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.file && !args.gdrive) {
    console.log(`
RecordNote CLI — PostgreSQL Chunked Transcription & Comprehensive Lecture Notes

Usage:
  node src/cli.js --file <path/to/recording.mp3|.aac> --subject "Graph Theory" [--title "Lecture Title"] [--topic "Keywords"]
  node src/cli.js --gdrive <google-drive-share-link-or-id> --subject "Physics" [--title "Lecture Title"]
`);
    process.exit(1);
  }

  // Check if subject exists in PostgreSQL or create it
  let existingSub = await SessionStorage.getSubject(args.subject);
  if (!existingSub) {
    existingSub = await SessionStorage.createSubject({ name: args.subject });
  }

  const trimStartSec = parseTimestampToSeconds(args.start);
  const trimEndSec = parseTimestampToSeconds(args.end);

  let session;

  if (args.file) {
    const resolvedFile = path.resolve(args.file);
    if (!fs.existsSync(resolvedFile)) {
      console.error(`Error: File not found: ${resolvedFile}`);
      process.exit(1);
    }

    const rawFileName = path.basename(resolvedFile);
    const ext = path.extname(rawFileName).toLowerCase() || '.mp3';
    const title = args.title || path.basename(rawFileName, ext).replace(/[_-]+/g, ' ');

    session = await SessionStorage.createSession({
      subjectId: existingSub.id,
      title,
      topic: args.topic,
      sourceType: 'upload',
      originalFileName: rawFileName,
      trimStartSec,
      trimEndSec
    });

    const sessionDir = SessionStorage.getSessionDir(session.id);
    const destPath = path.join(sessionDir, 'source', `original${ext}`);
    fs.copyFileSync(resolvedFile, destPath);
    session = await SessionStorage.updateLectureFields(session.id, {
      sourceFilePath: destPath
    });
  } else {
    session = await SessionStorage.createSession({
      subjectId: existingSub.id,
      title: args.title || 'Google Drive Audio Import',
      topic: args.topic,
      sourceType: 'gdrive',
      originalFileName: 'Google Drive Stream',
      gdriveUrl: args.gdrive,
      trimStartSec,
      trimEndSec
    });
  }

  console.log(`\n[RecordNote] Created Lecture in PostgreSQL: [${session.code}] ${session.title}`);
  console.log(`[RecordNote] Subject: ${session.subjectName} (${session.subjectCode}) | DB ID: ${session.id}\n`);

  pipelineEvents.on(`session:${session.id}`, (ev) => {
    if (ev.message) {
      console.log(`[${new Date().toLocaleTimeString()}] ${ev.message}`);
    }
  });

  const completed = await runSessionPipeline(session.id, { chunkTargetSec: args.chunkSec });
  const sessionDir = SessionStorage.getSessionDir(completed.id);

  console.log(`\n========================================================`);
  console.log(`  DONE! Lecture: [${completed.code}] ${completed.title}`);
  console.log(`  Subject: ${completed.subjectName} (${completed.subjectCode})`);
  console.log(`  Verbatim Transcript (${completed.fullTranscriptWords} words in PG transcript_chunks):`);
  console.log(`    -> ${path.join(sessionDir, 'full_transcript.md')}`);
  console.log(`  Comprehensive Notes (${completed.notesWords} words in PG lecture_notes):`);
  console.log(`    -> ${path.join(sessionDir, 'comprehensive_notes.md')}`);
  console.log(`========================================================\n`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('\n[RecordNote CLI Error]:', err.message);
  await pool.end();
  process.exit(1);
});
