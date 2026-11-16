import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { SessionStorage } from './storage.js';

let lastGeminiCallTimestamp = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enforces Free Tier request spacing so we stay comfortably under 15 RPM.
 */
export async function enforceFreeTierPacing() {
  const now = Date.now();
  const elapsed = now - lastGeminiCallTimestamp;
  if (lastGeminiCallTimestamp > 0 && elapsed < CONFIG.freeTierMinIntervalMs) {
    await sleep(CONFIG.freeTierMinIntervalMs - elapsed);
  }
  lastGeminiCallTimestamp = Date.now();
}

/**
 * Calls the Gemini generateContent REST API with automatic model fallback and rate-limit retry.
 */
export async function callGeminiWithRetry({ contents, systemInstruction, generationConfig = {} }, onStatus = null) {
  const apiKey = CONFIG.geminiApiKey;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing in .env');
  }

  const models = CONFIG.geminiModels;
  let lastError = null;

  for (const model of models) {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await enforceFreeTierPacing();

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const body = {
        contents,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          ...generationConfig
        }
      };

      if (systemInstruction) {
        body.systemInstruction = {
          parts: [{ text: systemInstruction }]
        };
      }

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (res.ok) {
          const data = await res.json();
          const text = (data?.candidates?.[0]?.content?.parts || [])
            .map((p) => p.text || '')
            .join('')
            .trim();

          if (!text) {
            const finishReason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
            throw new Error(`Gemini (${model}) returned empty output (finishReason: ${finishReason})`);
          }

          return { text, model };
        }

        const errText = await res.text();
        let errMessage = `HTTP ${res.status}: ${errText.slice(0, 300)}`;
        try {
          const parsed = JSON.parse(errText);
          if (parsed?.error?.message) errMessage = parsed.error.message;
        } catch {
          // ignore
        }

        // If 404 (model not found/supported on this key), break inner loop and try next model
        if (res.status === 404) {
          lastError = new Error(`Model ${model} not available: ${errMessage}`);
          break;
        }

        // If 429 (Free Tier rate limit) or 503 (overloaded), wait and retry
        if (res.status === 429 || res.status === 503) {
          const waitSec = attempt * 12;
          if (onStatus) {
            onStatus(`Free Tier rate limit reached on ${model}; pausing ${waitSec}s before retry (${attempt}/${maxAttempts})...`);
          }
          await sleep(waitSec * 1000);
          lastError = new Error(errMessage);
          continue;
        }

        throw new Error(errMessage);
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          await sleep(attempt * 4000);
        }
      }
    }
  }

  throw lastError || new Error('All Gemini models failed to respond.');
}

/**
 * Extracts the last ~450 characters of a transcript string to serve as rolling context
 * for the next audio chunk.
 */
function getRollingTail(text, maxChars = 450) {
  if (!text) return '';
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) return cleaned;
  const sliced = cleaned.slice(-maxChars);
  const firstSpace = sliced.indexOf(' ');
  return firstSpace > 0 ? sliced.slice(firstSpace + 1) : sliced;
}

/**
 * Transcribes a single audio chunk verbatim with rolling context from the previous chunk.
 */
export async function transcribeSingleChunk({
  chunkFilePath,
  chunk,
  totalChunks,
  title,
  topic,
  previousTail,
  onStatus
}) {
  const audioBuffer = fs.readFileSync(chunkFilePath);
  const base64Audio = audioBuffer.toString('base64');

  const systemInstruction = [
    `You are an expert verbatim academic lecture and conversation transcriptionist.`,
    `Your job is to produce a COMPLETE, ACCURATE, WORD-FOR-WORD verbatim transcript of the provided audio segment.`,
    `CRITICAL RULES:`,
    `1. NEVER summarize, paraphrase, condense, or skip any portion of the speech. Every explanation, example, tangent, question, and detail spoken must be transcribed in full.`,
    `2. Clean up only meaningless non-lexical stutters ("uh", "umm") while keeping every actual spoken sentence intact and readable.`,
    `3. Insert periodic timestamp markers in brackets like [${chunk.startFormatted}] at the start and roughly every 45-60 seconds or on speaker/topic shifts, using the real lecture timeline starting from ${chunk.startFormatted} and ending at ${chunk.endFormatted}.`,
    `4. If multiple speakers are audible (e.g. Professor / Student, or Speaker 1 / Speaker 2), label speaker turns clearly.`,
    `5. Output ONLY the verbatim transcript text—do not include introductory or concluding meta-commentary.`
  ].join('\n');

  const promptParts = [
    `Recording Title: "${title || 'Lecture Recording'}"`,
    topic ? `Subject / Topic Context (use for accurate spelling of technical terms & jargon): "${topic}"` : '',
    `Current Audio Segment: Chunk ${chunk.index + 1} of ${totalChunks} (Timeline: ${chunk.startFormatted} to ${chunk.endFormatted}).`
  ].filter(Boolean);

  if (previousTail) {
    promptParts.push(
      `\n<previous_chunk_tail>\n${previousTail}\n</previous_chunk_tail>\n` +
        `Instruction for continuity: The text in <previous_chunk_tail> is the end of the immediately preceding audio chunk. ` +
        `If the first few seconds of this audio segment repeat the final words of <previous_chunk_tail>, do NOT duplicate those repeated words—continue seamlessly right after them.`
    );
  }

  promptParts.push(
    `\nNow transcribe this audio segment (${chunk.startFormatted} – ${chunk.endFormatted}) completely and verbatim:`
  );

  const contents = [
    {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'audio/mp3',
            data: base64Audio
          }
        },
        {
          text: promptParts.join('\n')
        }
      ]
    }
  ];

  const { text, model } = await callGeminiWithRetry(
    {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192
      }
    },
    onStatus
  );

  return { transcriptText: text, modelUsed: model };
}

/**
 * Transcribes all pending chunks in a session sequentially, persisting each chunk's transcript
 * to disk immediately upon completion so zero progress is ever lost.
 */
export async function transcribeSessionChunks(sessionId, onEvent = null) {
  let session = SessionStorage.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const sessionDir = SessionStorage.getSessionDir(sessionId);
  const chunksDir = path.join(sessionDir, 'chunks');

  session.status = 'transcribing';
  session.error = null;
  SessionStorage.saveSession(session);

  let previousTail = '';
  const totalChunks = session.chunks.length;

  for (let i = 0; i < totalChunks; i++) {
    session = SessionStorage.getSession(sessionId);
    const chunk = session.chunks[i];

    // If this chunk was already transcribed in an earlier run, reuse its transcript and rolling tail!
    if (chunk.status === 'completed' && chunk.transcriptText) {
      previousTail = getRollingTail(chunk.transcriptText);
      if (onEvent) {
        onEvent({
          type: 'chunk_completed',
          chunkIndex: chunk.index,
          totalChunks,
          skippedCached: true,
          chunk,
          message: `Chunk ${i + 1}/${totalChunks} (${chunk.startFormatted} – ${chunk.endFormatted}) already stored on disk.`
        });
      }
      continue;
    }

    const chunkFilePath = path.join(chunksDir, chunk.fileName);
    if (!fs.existsSync(chunkFilePath)) {
      throw new Error(`Chunk audio file missing on disk: ${chunkFilePath}`);
    }

    chunk.status = 'transcribing';
    session.statusMessage = `Transcribing chunk ${i + 1} of ${totalChunks} (${chunk.startFormatted} – ${chunk.endFormatted})...`;
    SessionStorage.saveSession(session);

    if (onEvent) {
      onEvent({
        type: 'chunk_started',
        chunkIndex: chunk.index,
        totalChunks,
        startFormatted: chunk.startFormatted,
        endFormatted: chunk.endFormatted,
        message: session.statusMessage
      });
    }

    const { transcriptText, modelUsed } = await transcribeSingleChunk({
      chunkFilePath,
      chunk,
      totalChunks,
      title: session.title,
      topic: session.topic,
      previousTail,
      onStatus: (rateLimitMsg) => {
        if (onEvent) {
          onEvent({
            type: 'rate_limit_wait',
            chunkIndex: chunk.index,
            message: rateLimitMsg
          });
        }
      }
    });

    // Save chunk transcript to disk immediately!
    session = SessionStorage.saveChunkTranscript(sessionId, chunk.index, transcriptText, modelUsed);
    previousTail = getRollingTail(transcriptText);

    if (onEvent) {
      onEvent({
        type: 'chunk_completed',
        chunkIndex: chunk.index,
        totalChunks,
        chunk: session.chunks[i],
        fullTranscriptWords: session.fullTranscriptWords,
        message: `Stored Chunk ${i + 1}/${totalChunks} (${session.chunks[i].wordCount} words)`
      });
    }
  }

  return SessionStorage.getSession(sessionId);
}
