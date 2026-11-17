import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CONFIG } from '../src/config.js';
import { pool } from '../src/db/postgres.js';
import { extractGoogleDriveFileId } from '../src/services/gdrive.js';
import { prepareAndChunkAudio, parseTimestampToSeconds, enhanceChunkAudioForRetry } from '../src/services/audio.js';
import { detectTranscriptHallucination, sanitizeTranscriptText } from '../src/services/transcriber.js';
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
  console.log('1. Testing Google Drive Link & Timestamp Parsers...');
  assert.equal(
    extractGoogleDriveFileId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/view?usp=sharing'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz123456'
  );
  assert.equal(parseTimestampToSeconds('05:30'), 330);
  assert.equal(parseTimestampToSeconds('01:02:03'), 3723);

  // Test Hallucination Detector ("100 lines of hmm" vs real lecture transcript)
  const hmmLoopText = Array.from({ length: 100 }, () => 'hmm').join('\n');
  const hmmCheck = detectTranscriptHallucination(hmmLoopText);
  assert.equal(hmmCheck.isHallucinated, true, '100 lines of hmm must be flagged as hallucination');

  const normalSpeech =
    '[00:00] Today we will prove Euler’s formula V - E + F = 2 for connected planar graphs using induction on the number of edges.';
  const normalCheck = detectTranscriptHallucination(normalSpeech);
  assert.equal(normalCheck.isHallucinated, false, 'Normal lecture speech must not be flagged');

  const cleanedText = sanitizeTranscriptText('hmm\n[00:05] Let G be a bipartite graph.\nhmm\n');
  assert.equal(cleanedText, '[00:05] Let G be a bipartite graph.');
  console.log('   ✓ Google Drive link, timestamp & "hmm" hallucination detectors passed.');

  console.log('2. Testing PostgreSQL Subjects Table...');
  const subjects = await SessionStorage.listSubjects();
  const codes = subjects.map((s) => s.code);
  assert.ok(codes.includes('GT'), 'Graph Theory (GT) should be seeded');
  assert.ok(codes.includes('NT'), 'Number Theory (NT) should be seeded');
  assert.ok(codes.includes('PHY'), 'Physics (PHY) should be seeded');
  console.log(`   ✓ Verified PostgreSQL subjects: ${subjects.map((s) => `${s.name} (${s.code})`).join(', ')}`);

  console.log('3. Testing Selective Timestamp Trimming (Discarding Unwanted Audio) & Smart Chunking...');
  const tmpTestDir = path.join(CONFIG.tempDir, 'test_audio_run');
  fs.rmSync(tmpTestDir, { recursive: true, force: true });
  fs.mkdirSync(tmpTestDir, { recursive: true });

  // Generate a 20-second synthetic .aac file (with silence at 9s-10s)
  const rawAacPath = path.join(tmpTestDir, 'raw_20s_lecture.aac');
  await runFfmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=9',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=520:duration=10',
    '-filter_complex',
    '[0:a][1:a][2:a]concat=n=3:v=0:a=1',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    rawAacPath
  ]);

  // Create lecture with trim window [00:03 -> 00:17] (14 seconds total kept; 0-3s and 17-20s discarded!)
  const session = await SessionStorage.createSession({
    subjectId: 'sub_gt',
    title: 'Trees and Spanning Trees (Trimmed 00:03 to 00:17)',
    topic: 'Cayley Formula & Prüfer Sequences',
    sourceType: 'upload',
    originalFileName: 'raw_20s_lecture.aac',
    trimStartSec: 3,
    trimEndSec: 17
  });

  const sessionDir = SessionStorage.getSessionDir(session.id);
  const uploadedOriginalPath = path.join(sessionDir, 'source', 'original.aac');
  fs.copyFileSync(rawAacPath, uploadedOriginalPath);

  const { audioMetadata, chunks } = await prepareAndChunkAudio(
    uploadedOriginalPath,
    sessionDir,
    6,
    null,
    {
      trimStartSec: session.trimStartSec,
      trimEndSec: session.trimEndSec,
      deleteOriginal: true
    }
  );

  // Verify raw un-trimmed file was deleted immediately and only the 14s trimmed audio exists
  assert.equal(fs.existsSync(uploadedOriginalPath), false, 'Raw un-trimmed file should be deleted immediately');
  assert.ok(
    audioMetadata.durationSec >= 13.5 && audioMetadata.durationSec <= 14.5,
    `Trimmed duration should be ~14s (got ${audioMetadata.durationSec}s)`
  );
  assert.equal(chunks[0].startFormatted, '00:03', 'First chunk should start at 00:03');

  // Verify FFmpeg Speech-Boost enhancement on chunk 0
  const chunk0Path = path.join(sessionDir, 'chunks', chunks[0].fileName);
  const enhancedChunkPath = `${chunk0Path}.enhanced.mp3`;
  await enhanceChunkAudioForRetry(chunk0Path, enhancedChunkPath);
  assert.equal(fs.existsSync(enhancedChunkPath), true, 'Enhanced chunk MP3 should be created');
  fs.unlinkSync(enhancedChunkPath);

  console.log(
    `   ✓ Trimmed 20s .aac to exact window [00:03 – 00:17], verified Speech-Boost filter, & split into ${chunks.length} smart chunks.`
  );

  console.log('4. Testing Cumulative Context-Chained Structured Notes in PostgreSQL...');
  let updatedSession = await SessionStorage.registerChunks(session.id, audioMetadata, chunks);

  await SessionStorage.saveChunkTranscript(
    session.id,
    0,
    '[00:03] A tree is a connected acyclic undirected graph with n vertices and n-1 edges.',
    'gemini-2.5-flash'
  );
  await SessionStorage.saveChunkTranscript(
    session.id,
    1,
    '[00:09] By Cayley formula, the number of labeled trees on n vertices is n^(n-2).',
    'gemini-2.5-flash'
  );

  await SessionStorage.initNoteSections(session.id, [
    { sectionIndex: 0, chunkIndices: [0], startFormatted: '00:03', endFormatted: '00:09' },
    { sectionIndex: 1, chunkIndices: [1], startFormatted: '00:09', endFormatted: '00:17' }
  ]);

  await SessionStorage.saveNoteSection(
    session.id,
    0,
    '## 1. Fundamental Properties of Trees [00:03]\n### 1.1 Definition and Edge Count\n- **Definition (Tree):** A connected acyclic undirected graph $T = (V, E)$ with $|E| = n - 1$.',
    'gemini-2.5-flash'
  );
  await SessionStorage.saveNoteSection(
    session.id,
    1,
    '## 2. Counting Labeled Trees: Cayley’s Formula [00:09]\n### 2.1 Statement of Theorem\n- **Theorem (Cayley):** There are exactly $n^{n-2}$ spanning trees on $n$ labeled vertices.',
    'gemini-2.5-flash'
  );

  updatedSession = await SessionStorage.saveMasterIndex(
    session.id,
    '## Lecture Overview & Core Objectives\n- Master fundamental tree properties and Cayley’s enumeration formula.',
    'gemini-2.5-flash'
  );

  assert.ok(updatedSession.comprehensiveNotesMarkdown.includes('## 1. Fundamental Properties of Trees'));
  assert.ok(updatedSession.comprehensiveNotesMarkdown.includes('## 2. Counting Labeled Trees'));
  console.log(
    `   ✓ Verified seamless cumulative structured notes in PostgreSQL (${updatedSession.notesWords} words compiled under ${session.code}-FULL).`
  );

  await SessionStorage.deleteSession(session.id);
  fs.rmSync(tmpTestDir, { recursive: true, force: true });
  await pool.end();
  console.log('   ✓ Cleanup passed.\nAll checks succeeded!');
}

runTests().catch(async (err) => {
  console.error('Test failed:', err);
  await pool.end();
  process.exit(1);
});
