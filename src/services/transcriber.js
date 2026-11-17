import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { SessionStorage } from './storage.js';
import { enhanceChunkAudioForRetry } from './audio.js';
import { getRollingTail } from '../utils/format.js';
import { callGeminiWithRetry, enforceApiPacing } from '../ai/gemini.client.js';
import { detectTranscriptHallucination, sanitizeTranscriptText } from '../ai/guards/hallucination.js';
import { buildChunkTranscriptionPrompts } from '../ai/prompts/transcript.prompt.js';

export { callGeminiWithRetry, enforceApiPacing, detectTranscriptHallucination, sanitizeTranscriptText };

async function runChunkTranscriptionPass({
  audioPathToUse,
  chunk,
  totalChunks,
  lectureCode,
  subjectName,
  title,
  topic,
  previousTail,
  preferredModel,
  useStrictGuardrails = false,
  customHint = '',
  onStatus
}) {
  const audioBuffer = fs.readFileSync(audioPathToUse);
  const base64Audio = audioBuffer.toString('base64');

  const { systemInstruction, userPrompt } = buildChunkTranscriptionPrompts({
    chunk,
    totalChunks,
    lectureCode,
    subjectName,
    title,
    topic,
    previousTail,
    useStrictGuardrails,
    customHint
  });

  const { text, model } = await callGeminiWithRetry(
    {
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/mp3', data: base64Audio } },
            { text: userPrompt }
          ]
        }
      ],
      systemInstruction,
      generationConfig: {
        temperature: useStrictGuardrails ? 0.25 : 0.1,
        maxOutputTokens: 65536
      },
      preferredModel
    },
    onStatus
  );

  return {
    transcriptText: sanitizeTranscriptText(text),
    rawText: text,
    modelUsed: model
  };
}

export async function transcribeSingleChunk({
  chunkFilePath,
  chunk,
  totalChunks,
  lectureCode,
  subjectName,
  title,
  topic,
  previousTail,
  preferredModel = CONFIG.defaultChunkModel,
  forceGuardrails = false,
  enhanceAudio = false,
  customHint = '',
  onStatus
}) {
  let audioPathToUse = chunkFilePath;
  let tempEnhancedPath = null;

  try {
    if (enhanceAudio) {
      tempEnhancedPath = `${chunkFilePath}.enhanced.mp3`;
      await enhanceChunkAudioForRetry(chunkFilePath, tempEnhancedPath);
      audioPathToUse = tempEnhancedPath;
    }

    const firstPass = await runChunkTranscriptionPass({
      audioPathToUse,
      chunk,
      totalChunks,
      lectureCode,
      subjectName,
      title,
      topic,
      previousTail,
      preferredModel,
      useStrictGuardrails: forceGuardrails,
      customHint,
      onStatus
    });

    const check = detectTranscriptHallucination(firstPass.rawText);
    if (!check.isHallucinated && firstPass.transcriptText.length > 20) {
      return {
        transcriptText: firstPass.transcriptText,
        modelUsed: firstPass.modelUsed,
        autoRetried: false
      };
    }

    // Hallucination detected on THIS chunk only -> escalate ONLY this chunk to heavy model + speech boost
    const heavyModel = CONFIG.retryHeavyModel || 'gemini-2.5-pro';
    if (onStatus) {
      onStatus(
        `⚠️ Detected hallucination (${check.reason}) on ${chunk.code} with ${firstPass.modelUsed}. Auto-reprocessing THIS chunk only with ${heavyModel} + Speech-Boost Guardrails...`
      );
    }

    if (!tempEnhancedPath) {
      tempEnhancedPath = `${chunkFilePath}.enhanced.mp3`;
      await enhanceChunkAudioForRetry(chunkFilePath, tempEnhancedPath);
    }

    const retryPass = await runChunkTranscriptionPass({
      audioPathToUse: tempEnhancedPath,
      chunk,
      totalChunks,
      lectureCode,
      subjectName,
      title,
      topic,
      previousTail,
      preferredModel: heavyModel,
      useStrictGuardrails: true,
      customHint,
      onStatus
    });

    return {
      transcriptText: retryPass.transcriptText || firstPass.transcriptText,
      modelUsed: `${retryPass.modelUsed} (Auto-Guardrail Retry)`,
      autoRetried: true,
      hallucinationReason: check.reason
    };
  } finally {
    if (tempEnhancedPath && fs.existsSync(tempEnhancedPath)) {
      try {
        fs.unlinkSync(tempEnhancedPath);
      } catch {
        // ignore
      }
    }
  }
}

export async function retranscribeSingleChunkInSession(
  sessionId,
  chunkIndex,
  { model = CONFIG.retryHeavyModel, enhanceAudio = true, customHint = '' } = {},
  onEvent = null
) {
  let session = await SessionStorage.getSession(sessionId);
  if (!session) throw new Error(`Lecture not found in PostgreSQL: ${sessionId}`);

  const idx = Number(chunkIndex);
  const chunk = session.chunks.find((c) => c.index === idx);
  if (!chunk) throw new Error(`Chunk index ${idx} not found in lecture ${session.code}`);

  const sessionDir = SessionStorage.getSessionDir(session.id);
  const chunkFilePath = path.join(sessionDir, 'chunks', chunk.fileName);
  if (!fs.existsSync(chunkFilePath)) {
    throw new Error(`Audio file for ${chunk.code} not found on disk: ${chunkFilePath}`);
  }

  let previousTail = '';
  if (idx > 0) {
    const prevChunk = session.chunks.find((c) => c.index === idx - 1);
    if (prevChunk && prevChunk.transcriptText) {
      const checkPrev = detectTranscriptHallucination(prevChunk.transcriptText);
      if (!checkPrev.isHallucinated) {
        previousTail = getRollingTail(prevChunk.transcriptText);
      }
    }
  }

  const startMsg = `Reprocessing ${chunk.code} (${chunk.startFormatted} – ${chunk.endFormatted}) with ${model}${
    enhanceAudio ? ' + Speech-Boost & Anti-Loop Guardrails' : ' + Anti-Loop Guardrails'
  }...`;
  await SessionStorage.markChunkStatus(session.id, idx, 'transcribing', startMsg);

  if (onEvent) {
    onEvent({
      type: 'chunk_started',
      chunkIndex: idx,
      chunkCode: chunk.code,
      totalChunks: session.chunks.length,
      message: startMsg
    });
  }

  try {
    const { transcriptText, modelUsed } = await transcribeSingleChunk({
      chunkFilePath,
      chunk,
      totalChunks: session.chunks.length,
      lectureCode: session.code,
      subjectName: session.subjectName,
      title: session.title,
      topic: session.topic,
      previousTail,
      preferredModel: model,
      forceGuardrails: true,
      enhanceAudio: Boolean(enhanceAudio),
      customHint,
      onStatus: (msg) => {
        if (onEvent) onEvent({ type: 'rate_limit_wait', chunkIndex: idx, message: msg });
      }
    });

    const label = `${modelUsed}${enhanceAudio ? ' + SpeechBoost' : ''}`;
    session = await SessionStorage.saveChunkTranscript(session.id, idx, transcriptText, label);
    const updatedChunk = session.chunks.find((c) => c.index === idx);

    const doneMsg = `Re-extracted ${chunk.code} with ${modelUsed} (${updatedChunk.wordCount} words stored in PostgreSQL). You can now update the lecture notes!`;
    await SessionStorage.updateLectureFields(session.id, { statusMessage: doneMsg });

    if (onEvent) {
      onEvent({
        type: 'chunk_reprocessed',
        chunkIndex: idx,
        chunkCode: chunk.code,
        chunk: updatedChunk,
        fullTranscriptWords: session.fullTranscriptWords,
        message: doneMsg
      });
    }

    return await SessionStorage.getSession(session.id);
  } catch (err) {
    await SessionStorage.markChunkStatus(
      session.id,
      idx,
      chunk.transcriptText ? 'completed' : 'error',
      `Reprocess error on ${chunk.code}: ${err.message}`
    );
    throw err;
  }
}

export async function transcribeSessionChunks(sessionId, onEvent = null) {
  let session = await SessionStorage.getSession(sessionId);
  if (!session) throw new Error(`Lecture not found: ${sessionId}`);

  const sessionDir = SessionStorage.getSessionDir(session.id);
  const chunksDir = path.join(sessionDir, 'chunks');

  await SessionStorage.updateLectureFields(session.id, {
    status: 'transcribing',
    error: null
  });

  let previousTail = '';
  const totalChunks = session.chunks.length;

  for (let i = 0; i < totalChunks; i++) {
    session = await SessionStorage.getSession(session.id);
    const chunk = session.chunks[i];

    if (chunk.status === 'completed' && chunk.transcriptText) {
      const checkCached = detectTranscriptHallucination(chunk.transcriptText);
      if (!checkCached.isHallucinated) {
        previousTail = getRollingTail(chunk.transcriptText);
        if (onEvent) {
          onEvent({
            type: 'chunk_completed',
            chunkIndex: chunk.index,
            totalChunks,
            skippedCached: true,
            chunk,
            message: `Chunk ${chunk.code} (${chunk.startFormatted} – ${chunk.endFormatted}) already stored in PostgreSQL.`
          });
        }
        continue;
      }
    }

    const chunkFilePath = path.join(chunksDir, chunk.fileName);
    if (!fs.existsSync(chunkFilePath)) {
      throw new Error(`Chunk audio file missing on disk: ${chunkFilePath}`);
    }

    const statusMsg = `Transcribing ${chunk.code} — Chunk ${i + 1} of ${totalChunks} (${chunk.startFormatted} – ${chunk.endFormatted}) with ${CONFIG.defaultChunkModel}...`;
    await SessionStorage.markChunkStatus(session.id, chunk.index, 'transcribing', statusMsg);

    if (onEvent) {
      onEvent({
        type: 'chunk_started',
        chunkIndex: chunk.index,
        chunkCode: chunk.code,
        totalChunks,
        startFormatted: chunk.startFormatted,
        endFormatted: chunk.endFormatted,
        message: statusMsg
      });
    }

    const { transcriptText, modelUsed, autoRetried } = await transcribeSingleChunk({
      chunkFilePath,
      chunk,
      totalChunks,
      lectureCode: session.code,
      subjectName: session.subjectName,
      title: session.title,
      topic: session.topic,
      previousTail,
      preferredModel: CONFIG.defaultChunkModel,
      forceGuardrails: false,
      enhanceAudio: false,
      onStatus: (statusUpdateMsg) => {
        if (onEvent) {
          onEvent({
            type: 'rate_limit_wait',
            chunkIndex: chunk.index,
            message: statusUpdateMsg
          });
        }
      }
    });

    session = await SessionStorage.saveChunkTranscript(session.id, chunk.index, transcriptText, modelUsed);
    previousTail = getRollingTail(transcriptText);

    if (onEvent) {
      onEvent({
        type: 'chunk_completed',
        chunkIndex: chunk.index,
        chunkCode: chunk.code,
        totalChunks,
        chunk: session.chunks[i],
        autoRetried,
        fullTranscriptWords: session.fullTranscriptWords,
        message: `Stored ${chunk.code} in PostgreSQL (${session.chunks[i].wordCount} words via ${modelUsed})`
      });
    }
  }

  return await SessionStorage.getSession(session.id);
}
