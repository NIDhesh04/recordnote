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
 * Parses a timestamp string ("MM:SS", "HH:MM:SS", or numeric seconds) into seconds.
 * Returns null if empty or invalid.
 */
export function parseTimestampToSeconds(input) {
  if (input === null || input === undefined) return null;
  const str = String(input).trim();
  if (!str) return null;

  if (/^\d+(\.\d+)?$/.test(str)) {
    const val = parseFloat(str);
    return val >= 0 ? val : null;
  }

  const parts = str.split(':').map((p) => p.trim());
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new Error(`Invalid timestamp format "${str}". Use MM:SS or HH:MM:SS (e.g., 05:30 or 00:42:15).`);
  }

  if (parts.length === 2) {
    const mins = parseInt(parts[0], 10);
    const secs = parseFloat(parts[1]);
    return mins * 60 + secs;
  }

  if (parts.length === 3) {
    const hrs = parseInt(parts[0], 10);
    const mins = parseInt(parts[1], 10);
    const secs = parseFloat(parts[2]);
    return hrs * 3600 + mins * 60 + secs;
  }

  throw new Error(`Invalid timestamp format "${str}". Use MM:SS or HH:MM:SS.`);
}

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
 * Converts and optionally trims any input audio/video (.mp3, .aac, .m4a, .wav, .ogg, .webm, .mp4)
 * into a speech-optimized 16kHz Mono 64kbps MP3.
 * If trimStartSec / trimEndSec are provided, ONLY that time window is extracted into outputPath,
 * and the raw inputPath is immediately deleted so unwanted audio is never stored on disk.
 */
export async function normalizeAudioToSpeechMp3(
  inputPath,
  outputPath,
  { trimStartSec = null, trimEndSec = null, deleteOriginal = true } = {}
) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const startSec = trimStartSec !== null && trimStartSec !== undefined && Number(trimStartSec) > 0
    ? Number(trimStartSec)
    : null;
  const endSec = trimEndSec !== null && trimEndSec !== undefined && Number(trimEndSec) > 0
    ? Number(trimEndSec)
    : null;

  if (startSec !== null && endSec !== null && endSec <= startSec) {
    throw new Error(
      `End timestamp (${formatSeconds(endSec)}) must be greater than Start timestamp (${formatSeconds(startSec)}).`
    );
  }

  const args = ['-y'];
  if (startSec !== null) {
    args.push('-ss', String(startSec));
  }
  if (endSec !== null) {
    args.push('-to', String(endSec));
  }

  args.push(
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '64k',
    outputPath
  );

  await runProcess('ffmpeg', args);

  // Immediately delete the raw uploaded/downloaded source file so anything outside
  // [trimStartSec, trimEndSec] is completely discarded and never stored anywhere.
  if (deleteOriginal && path.resolve(inputPath) !== path.resolve(outputPath) && fs.existsSync(inputPath)) {
    try {
      fs.unlinkSync(inputPath);
    } catch {
      // ignore if already removed
    }
  }

  return probeAudioFile(outputPath);
}

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
    starts.push(parseFloat(m[1]));
  }
  while ((m = endRegex.exec(stderr)) !== null) {
    ends.push(parseFloat(m[1]));
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
 * 1. Extracts ONLY [trimStartSec, trimEndSec] (if specified) into normalized.mp3 and deletes raw source
 * 2. Detects silences in the trimmed audio
 * 3. Slices into smart ~5-minute chunk MP3s in `chunksDir`
 */
export async function prepareAndChunkAudio(
  inputFilePath,
  sessionDir,
  targetChunkSec = CONFIG.chunkTargetSec,
  onProgress = null,
  { trimStartSec = null, trimEndSec = null, deleteOriginal = true } = {}
) {
  const normalizedPath = path.join(sessionDir, 'source', 'normalized.mp3');
  const chunksDir = path.join(sessionDir, 'chunks');
  fs.mkdirSync(chunksDir, { recursive: true });

  const hasTrim = (trimStartSec !== null && trimStartSec > 0) || (trimEndSec !== null && trimEndSec > 0);
  if (onProgress) {
    const trimLabel = hasTrim
      ? ` (Extracting only ${formatSeconds(trimStartSec || 0)} to ${
          trimEndSec ? formatSeconds(trimEndSec) : 'end'
        } & discarding rest)`
      : '';
    onProgress({
      stage: 'normalizing',
      message: `Normalizing audio stream${trimLabel}...`
    });
  }

  const normalizedMeta = await normalizeAudioToSpeechMp3(inputFilePath, normalizedPath, {
    trimStartSec,
    trimEndSec,
    deleteOriginal
  });
  const totalDurationSec = normalizedMeta.durationSec;

  if (totalDurationSec <= 0) {
    throw new Error('Selected audio segment is empty or has 0 duration. Check your Start/End timestamps.');
  }

  if (onProgress) {
    onProgress({
      stage: 'detecting_silence',
      message: `Scanning ${normalizedMeta.durationFormatted} recording for natural speech pauses...`
    });
  }

  const silenceMidpoints = await detectSilenceMidpoints(normalizedPath);
  const boundaries = computeSmartChunkBoundaries(totalDurationSec, silenceMidpoints, targetChunkSec);
  const offsetSec = Number(trimStartSec || 0);

  const chunkManifest = [];

  for (const b of boundaries) {
    const chunkFileName = `chunk_${String(b.index).padStart(3, '0')}.mp3`;
    const chunkFilePath = path.join(chunksDir, chunkFileName);

    const displayStartSec = Number((offsetSec + b.startTimeSec).toFixed(2));
    const displayEndSec = Number((offsetSec + b.endTimeSec).toFixed(2));

    if (onProgress) {
      onProgress({
        stage: 'splitting',
        chunkIndex: b.index,
        totalChunks: boundaries.length,
        message: `Extracting chunk ${b.index + 1}/${boundaries.length} (${formatSeconds(
          displayStartSec
        )} – ${formatSeconds(displayEndSec)})...`
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
      startTimeSec: displayStartSec,
      endTimeSec: displayEndSec,
      durationSec: b.durationSec,
      startFormatted: formatSeconds(displayStartSec),
      endFormatted: formatSeconds(displayEndSec),
      splitOnSilence: b.splitOnSilence,
      status: 'pending',
      transcriptText: '',
      wordCount: 0,
      modelUsed: '',
      updatedAt: null
    });
  }

  return {
    normalizedPath,
    audioMetadata: normalizedMeta,
    chunks: chunkManifest
  };
}

/**
 * Applies an FFmpeg speech-enhancement filter chain to a single chunk audio file:
 * - highpass=f=120 (strips low-frequency AC/room hum & mic rumble that trigger "hmm" loops)
 * - lowpass=f=7500 (strips high-frequency hiss)
 * - dynaudnorm=f=150:g=15 (boosts quiet or distant lecturer speech)
 */
export async function enhanceChunkAudioForRetry(inputChunkPath, outputEnhancedPath) {
  fs.mkdirSync(path.dirname(outputEnhancedPath), { recursive: true });
  await runProcess('ffmpeg', [
    '-y',
    '-i',
    inputChunkPath,
    '-af',
    'highpass=f=120,lowpass=f=7500,dynaudnorm=f=150:g=15',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '64k',
    outputEnhancedPath
  ]);
  return outputEnhancedPath;
}
