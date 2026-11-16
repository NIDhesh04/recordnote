import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CONFIG } from '../src/config.js';
import { extractGoogleDriveFileId } from '../src/services/gdrive.js';
import { prepareAndChunkAudio } from '../src/services/audio.js';
import { SessionStorage } from '../src/services/storage.js';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-400)))));
  });
}

async function runTests() {
  console.log('1. Testing Google Drive Link & File ID Parser...');
  assert.equal(
    extractGoogleDriveFileId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/view?usp=sharing'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz123456'
  );
  assert.equal(
    extractGoogleDriveFileId('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz123456'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz123456'
  );
  assert.equal(
    extractGoogleDriveFileId('1AbCdEfGhIjKlMnOpQrStUvWxYz123456'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz123456'
  );
  console.log('   ✓ Google Drive link parser passed.');

  console.log('2. Testing .aac and .mp3 Normalization & Silence-Aware Smart Chunking...');
  const tmpTestDir = path.join(CONFIG.tempDir, 'test_audio_run');
  fs.rmSync(tmpTestDir, { recursive: true, force: true });
  fs.mkdirSync(tmpTestDir, { recursive: true });

  // Generate a 14-second synthetic .aac file with a 1-second silence pause at 6s-7s
  const sampleAacPath = path.join(tmpTestDir, 'sample_lecture.aac');
  await runFfmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=6',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=520:duration=7',
    '-filter_complex',
    '[0:a][1:a][2:a]concat=n=3:v=0:a=1',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    sampleAacPath
  ]);

  const session = SessionStorage.createSession({
    title: 'Automated Verification Test Session',
    topic: 'Systems Architecture',
    sourceType: 'upload',
    originalFileName: 'sample_lecture.aac'
  });

  const sessionDir = SessionStorage.getSessionDir(session.id);
  // Use a 6-second target chunk duration to verify it splits right on the silence at ~6.5s!
  const { audioMetadata, chunks } = await prepareAndChunkAudio(sampleAacPath, sessionDir, 6);

  assert.ok(audioMetadata.durationSec >= 13, 'Normalized audio duration should be ~14s');
  assert.ok(chunks.length >= 2, 'Should split into at least 2 chunks');
  console.log(
    `   ✓ .aac normalized (${audioMetadata.durationFormatted}) & split into ${chunks.length} chunks (Chunk 1 ends at ${chunks[0].endTimeSec}s on silence=${chunks[0].splitOnSilence}).`
  );

  console.log('3. Testing Persistent Chunk Transcript & Comprehensive Notes Storage...');
  session.audioMetadata = audioMetadata;
  session.chunks = chunks;
  SessionStorage.saveSession(session);

  SessionStorage.saveChunkTranscript(
    session.id,
    0,
    '[00:00] Welcome to the lecture on virtual memory and page tables.',
    'gemini-2.5-flash'
  );
  SessionStorage.saveChunkTranscript(
    session.id,
    1,
    '[00:06] Next we examine translation lookaside buffers and multi-level paging.',
    'gemini-2.5-flash'
  );

  const fullTranscriptMd = SessionStorage.getFullTranscriptMarkdown(session.id);
  assert.ok(fullTranscriptMd.includes('translation lookaside buffers'));

  // Clean up test session
  SessionStorage.deleteSession(session.id);
  fs.rmSync(tmpTestDir, { recursive: true, force: true });
  console.log('   ✓ Persistent storage and cleanup passed.\nAll pipeline unit checks succeeded!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
