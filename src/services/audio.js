import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { formatSeconds } from './storage.js';

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run ${command}: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-600)}`));
      }
    });
  });
}

/**
 * Probes an audio file using ffprobe to get duration and format info.
 */
export async function probeAudioFile(filePath) {
  const { stdout } = await runProcess('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration,format_name,size:stream=codec_name,sample_rate,channels',
    '-of',
    'json',
    filePath
  ]);

  const info = JSON.parse(stdout || '{}');
  const durationSec = Number(info?.format?.duration || 0);
  const sizeBytes = Number(info?.format?.size || fs.statSync(filePath).size);
  const formatName = info?.format?.format_name || path.extname(filePath).replace('.', '');

  return {
    durationSec,
    durationFormatted: formatSeconds(durationSec),
    sizeBytes,
    format: formatName
  };
}

/**
 * Converts any input audio/video (.mp3, .aac, .m4a, .wav, .ogg, .webm, .mp4)
 * into a speech-optimized 16kHz Mono 64kbps MP3 for consistent silence detection and fast API calls.
 */
export async function normalizeAudioToSpeechMp3(inputPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await runProcess('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-vn', // strip any video track
    '-ac',
    '1', // mono
    '-ar',
    '16000', // 16kHz speech sample rate
    '-b:a',
    '64k', // 64kbps (high clarity for voice, ~480KB per minute)
    outputPath
  ]);
  return probeAudioFile(outputPath);
}

/**
 * Scans a normalized audio file for natural pauses/silences using ffmpeg silencedetect.
 * Returns an array of silence midpoints (in seconds).
 */
export async function detectSilenceMidpoints(audioPath) {
  const { stderr } = await runProcess('ffmpeg', [
    '-i',
    audioPath,
    '-af',
    'silencedetect=noise=-32dB:d=0.35',
    '-f',
    'null',
    '-'
  ]);

  const starts = [];
  const ends = [];
  const startRegex = /silence_start:\s*([0-9.]+)/g;
  const endRegex = /silence_end:\s*([0-9.]+)/g;

  let m;
  while ((m = startRegex.exec(stderr)) !== null) {
    starts.push( parseFloat(m[1]) );
  }
  while ((m = endRegex.exec(stderr)) !== null) {
    ends.push( parseFloat(m[1]) );
  }

  const midpoints = [];
  const count = Math.min(starts.length, ends.length);
  for (let i = 0; i < count; i++) {
    if (ends[i] >= starts[i]) {
      midpoints.push((starts[i] + ends[i]) / 2);
    }
  }
  return midpoints;
}

/**
 * Computes optimal chunk boundaries for a lecture recording.
 * Prefers splitting on a natural silence near the target chunk duration (default 300s / 5m).
 * If no silence is found in the search window, overlaps by `chunkFallbackOverlapSec` so no word is cut.
 */
export function computeSmartChunkBoundaries(
  totalDurationSec,
  silenceMidpoints = [],
  targetSec = CONFIG.chunkTargetSec
) {
  const windowBefore = Math.min(CONFIG.chunkSearchWindowBeforeSec, Math.max(2, targetSec * 0.15));
  const windowAfter = Math.min(CONFIG.chunkSearchWindowAfterSec, Math.max(2, targetSec * 0.12));
  const minChunkLen = Math.min(45, Math.max(3, targetSec * 0.25));

  if (totalDurationSec <= targetSec + windowAfter) {
    return [
      {
        index: 0,
        startTimeSec: 0,
        endTimeSec: Number(totalDurationSec.toFixed(2)),
        durationSec: Number(totalDurationSec.toFixed(2)),
        splitOnSilence: true
      }
    ];
  }

  const chunks = [];
  let currentStart = 0;
  let index = 0;

  while (currentStart < totalDurationSec) {
    const remaining = totalDurationSec - currentStart;
    // If remaining audio is within 1 chunk + small buffer, keep it as the final chunk
    if (remaining <= targetSec + windowAfter) {
      chunks.push({
        index,
        startTimeSec: Number(currentStart.toFixed(2)),
        endTimeSec: Number(totalDurationSec.toFixed(2)),
        durationSec: Number((totalDurationSec - currentStart).toFixed(2)),
        splitOnSilence: true
      });
      break;
    }

    const idealSplit = currentStart + targetSec;
    const minWindow = Math.max(currentStart + minChunkLen, idealSplit - windowBefore);
    const maxWindow = Math.min(totalDurationSec - minChunkLen, idealSplit + windowAfter);

    // Find silence midpoint closest to idealSplit within [minWindow, maxWindow]
    let bestSilence = null;
    let bestDist = Infinity;
    for (const mp of silenceMidpoints) {
      if (mp >= minWindow && mp <= maxWindow) {
        const dist = Math.abs(mp - idealSplit);
        if (dist < bestDist) {
          bestDist = dist;
          bestSilence = mp;
        }
      }
    }

    if (bestSilence !== null) {
      const endSec = Number(bestSilence.toFixed(2));
      chunks.push({
        index,
        startTimeSec: Number(currentStart.toFixed(2)),
        endTimeSec: endSec,
        durationSec: Number((endSec - currentStart).toFixed(2)),
        splitOnSilence: true
      });
      currentStart = endSec;
    } else {
      // No natural pause found in window; split at idealSplit and step back by overlap for next chunk
      const endSec = Number(idealSplit.toFixed(2));
      chunks.push({
        index,
        startTimeSec: Number(currentStart.toFixed(2)),
        endTimeSec: endSec,
        durationSec: Number((endSec - currentStart).toFixed(2)),
        splitOnSilence: false
      });
      currentStart = Math.max(currentStart + 30, endSec - CONFIG.chunkFallbackOverlapSec);
    }

    index++;
  }

  return chunks;
}

/**
 * Full audio preparation pipeline:
 * 1. Normalizes input (.mp3, .aac, .m4a, .wav, etc.) to 16kHz mono speech MP3
 * 2. Detects silences
 * 3. Slices audio into smart ~5-minute chunk MP3s in `chunksDir`
 */
export async function prepareAndChunkAudio(inputFilePath, sessionDir, targetChunkSec = CONFIG.chunkTargetSec, onProgress = null) {
  const normalizedPath = path.join(sessionDir, 'source', 'normalized.mp3');
  const chunksDir = path.join(sessionDir, 'chunks');
  fs.mkdirSync(chunksDir, { recursive: true });

  if (onProgress) {
    onProgress({ stage: 'normalizing', message: 'Normalizing audio (.mp3/.aac → 16kHz Mono speech stream)...' });
  }

  const normalizedMeta = await normalizeAudioToSpeechMp3(inputFilePath, normalizedPath);
  const totalDurationSec = normalizedMeta.durationSec;

  if (totalDurationSec <= 0) {
    throw new Error('Audio file appears to be empty or has 0 duration.');
  }

  if (onProgress) {
    onProgress({
      stage: 'detecting_silence',
      message: `Scanning ${normalizedMeta.durationFormatted} recording for natural speech pauses...`
    });
  }

  const silenceMidpoints = await detectSilenceMidpoints(normalizedPath);
  const boundaries = computeSmartChunkBoundaries(totalDurationSec, silenceMidpoints, targetChunkSec);

  const chunkManifest = [];

  for (const b of boundaries) {
    const chunkFileName = `chunk_${String(b.index).padStart(3, '0')}.mp3`;
    const chunkFilePath = path.join(chunksDir, chunkFileName);

    if (onProgress) {
      onProgress({
        stage: 'splitting',
        chunkIndex: b.index,
        totalChunks: boundaries.length,
        message: `Extracting chunk ${b.index + 1}/${boundaries.length} (${formatSeconds(b.startTimeSec)} – ${formatSeconds(b.endTimeSec)})...`
      });
    }

    await runProcess('ffmpeg', [
      '-y',
      '-ss',
      String(b.startTimeSec),
      '-t',
      String(b.durationSec),
      '-i',
      normalizedPath,
      '-acodec',
      'copy',
      chunkFilePath
    ]);

    chunkManifest.push({
      index: b.index,
      fileName: chunkFileName,
      startTimeSec: b.startTimeSec,
      endTimeSec: b.endTimeSec,
      durationSec: b.durationSec,
      startFormatted: formatSeconds(b.startTimeSec),
      endFormatted: formatSeconds(b.endTimeSec),
      splitOnSilence: b.splitOnSilence,
      status: 'pending',
      transcriptText: '',
      wordCount: 0,
      modelUsed: '',
      updatedAt: null
    });
  }

  return {
    audioMetadata: normalizedMeta,
    chunks: chunkManifest
  };
}
