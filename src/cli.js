import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { SessionStorage } from './services/storage.js';
import { runSessionPipeline, pipelineEvents } from './services/pipeline.js';

function parseArgs(argv) {
  const args = {
    file: '',
    gdrive: '',
    title: '',
    topic: '',
    chunkSec: CONFIG.chunkTargetSec
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') args.file = argv[++i] || '';
    else if (arg === '--gdrive' || arg === '-g') args.gdrive = argv[++i] || '';
    else if (arg === '--title' || arg === '-t') args.title = argv[++i] || '';
    else if (arg === '--topic' || arg === '-c') args.topic = argv[++i] || '';
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
RecordNote CLI — Verbatim Chunked Transcription & Comprehensive Lecture Notes

Usage:
  node src/cli.js --file <path/to/recording.mp3|.aac> [--title "Lecture Title"] [--topic "Subject Context"] [--chunk-sec 300]
  node src/cli.js --gdrive <google-drive-share-link-or-id> [--title "Lecture Title"] [--topic "Subject Context"]
`);
    process.exit(1);
  }

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

    session = SessionStorage.createSession({
      title,
      topic: args.topic,
      sourceType: 'upload',
      originalFileName: rawFileName
    });

    const sessionDir = SessionStorage.getSessionDir(session.id);
    const destPath = path.join(sessionDir, 'source', `original${ext}`);
    fs.copyFileSync(resolvedFile, destPath);
    session.sourceFilePath = destPath;
    SessionStorage.saveSession(session);
  } else {
    session = SessionStorage.createSession({
      title: args.title || 'Google Drive Audio Import',
      topic: args.topic,
      sourceType: 'gdrive',
      originalFileName: 'Google Drive Stream',
      gdriveUrl: args.gdrive
    });
  }

  console.log(`\n[RecordNote] Created Session: ${session.id}`);
  console.log(`[RecordNote] Storage Folder : ${SessionStorage.getSessionDir(session.id)}\n`);

  pipelineEvents.on(`session:${session.id}`, (ev) => {
    if (ev.message) {
      console.log(`[${new Date().toLocaleTimeString()}] ${ev.message}`);
    }
  });

  const completed = await runSessionPipeline(session.id, { chunkTargetSec: args.chunkSec });
  const sessionDir = SessionStorage.getSessionDir(completed.id);

  console.log(`\n========================================================`);
  console.log(`  DONE! Session: ${completed.title} (${completed.id})`);
  console.log(`  Verbatim Transcript (${completed.fullTranscriptWords} words):`);
  console.log(`    -> ${path.join(sessionDir, 'full_transcript.md')}`);
  console.log(`  Comprehensive Notes (${completed.notesWords} words):`);
  console.log(`    -> ${path.join(sessionDir, 'comprehensive_notes.md')}`);
  console.log(`========================================================\n`);
}

main().catch((err) => {
  console.error('\n[RecordNote CLI Error]:', err.message);
  process.exit(1);
});
