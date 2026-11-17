import { SessionStorage } from './storage.js';
import { callGeminiWithRetry } from '../ai/gemini.client.js';
import { buildCumulativeNotesPrompts, buildMasterReferencePrompts } from '../ai/prompts/notes.prompt.js';

function buildNoteSectionsFromChunks(chunks) {
  const completed = (chunks || [])
    .filter((c) => c.status === 'completed' && c.transcriptText)
    .sort((a, b) => a.index - b.index);

  return completed.map((c, idx) => ({
    sectionIndex: idx,
    chunkIndices: [c.index],
    startFormatted: c.startFormatted,
    endFormatted: c.endFormatted
  }));
}

export async function generateComprehensiveNotesForSession(
  sessionId,
  forceOrOptions = false,
  onEvent = null
) {
  const forceRegenerate =
    typeof forceOrOptions === 'boolean' ? forceOrOptions : Boolean(forceOrOptions?.forceRegenerate);
  const startFromChunkIndex =
    typeof forceOrOptions === 'object' &&
    forceOrOptions !== null &&
    forceOrOptions.startFromChunkIndex !== undefined &&
    forceOrOptions.startFromChunkIndex !== null
      ? Number(forceOrOptions.startFromChunkIndex)
      : null;

  let session = await SessionStorage.getSession(sessionId);
  if (!session) throw new Error(`Lecture not found: ${sessionId}`);

  const completedChunks = (session.chunks || [])
    .filter((c) => c.status === 'completed' && c.transcriptText)
    .sort((a, b) => a.index - b.index);

  if (completedChunks.length === 0) {
    throw new Error('No transcribed chunks available yet in PostgreSQL to generate notes.');
  }

  await SessionStorage.updateLectureFields(session.id, {
    status: 'generating_notes',
    error: null
  });

  if (
    forceRegenerate ||
    !session.noteSections ||
    session.noteSections.length !== completedChunks.length
  ) {
    const sectionsBlueprint = buildNoteSectionsFromChunks(completedChunks);
    session = await SessionStorage.initNoteSections(session.id, sectionsBlueprint, true);
  }

  const totalSections = session.noteSections.length;
  let accumulatedNotesSoFar = '';

  for (let i = 0; i < totalSections; i++) {
    session = await SessionStorage.getSession(session.id);
    const sec = session.noteSections[i];
    const currentChunk = completedChunks[i];
    const prevChunk = i > 0 ? completedChunks[i - 1] : null;
    const previousTranscriptTail = prevChunk ? prevChunk.transcriptText.trim().slice(-650) : '';

    const shouldSkipExisting =
      !forceRegenerate &&
      (startFromChunkIndex === null
        ? sec.status === 'completed' && sec.contentMarkdown
        : i < startFromChunkIndex && sec.status === 'completed' && sec.contentMarkdown);

    if (shouldSkipExisting) {
      accumulatedNotesSoFar += (accumulatedNotesSoFar ? '\n\n' : '') + sec.contentMarkdown.trim();
      if (onEvent) {
        onEvent({
          type: 'note_section_completed',
          sectionIndex: sec.sectionIndex,
          sectionCode: sec.code,
          totalSections,
          section: sec,
          message: `Note section ${sec.code} (${sec.startFormatted} – ${sec.endFormatted}) already stored in PostgreSQL.`
        });
      }
      continue;
    }

    const statusMsg = `Structuring cumulative lecture notes for ${sec.code} — Segment ${i + 1} of ${totalSections} (${sec.startFormatted} – ${sec.endFormatted}) with full prior context...`;
    await SessionStorage.markNoteSectionStatus(session.id, sec.sectionIndex, 'generating', statusMsg);

    if (onEvent) {
      onEvent({
        type: 'note_section_started',
        sectionIndex: sec.sectionIndex,
        sectionCode: sec.code,
        totalSections,
        startFormatted: sec.startFormatted,
        endFormatted: sec.endFormatted,
        message: statusMsg
      });
    }

    const { systemInstruction, userPrompt } = buildCumulativeNotesPrompts({
      lectureCode: session.code,
      subjectName: session.subjectName,
      sessionTitle: session.title,
      sessionTopic: session.topic,
      section: sec,
      totalSections,
      accumulatedNotesSoFar,
      previousTranscriptTail,
      currentChunkTranscript: currentChunk.transcriptText
    });

    const { text: contentMarkdown, model: modelUsed } = await callGeminiWithRetry(
      {
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction,
        generationConfig: { temperature: 0.15, maxOutputTokens: 65536 }
      },
      (waitMsg) => {
        if (onEvent) onEvent({ type: 'rate_limit_wait', message: waitMsg });
      }
    );

    session = await SessionStorage.saveNoteSection(session.id, sec.sectionIndex, contentMarkdown, modelUsed);
    accumulatedNotesSoFar += (accumulatedNotesSoFar ? '\n\n' : '') + contentMarkdown.trim();

    if (onEvent) {
      onEvent({
        type: 'note_section_completed',
        sectionIndex: sec.sectionIndex,
        sectionCode: sec.code,
        totalSections,
        section: session.noteSections[i],
        notesWords: session.notesWords,
        message: `Stored structured notes ${sec.code} in PostgreSQL (${session.noteSections[i].wordCount} words)`
      });
    }
  }

  session = await SessionStorage.getSession(session.id);
  if (forceRegenerate || startFromChunkIndex !== null || !session.masterIndexMarkdown) {
    const masterStatusMsg = `Compiling ${session.code}-MASTER Executive Overview, Outline & Formula Reference...`;
    await SessionStorage.updateLectureFields(session.id, { statusMessage: masterStatusMsg });

    if (onEvent) {
      onEvent({ type: 'master_index_started', message: masterStatusMsg });
    }

    const { systemInstruction, userPrompt } = buildMasterReferencePrompts({
      lectureCode: session.code,
      subjectName: session.subjectName,
      sessionTitle: session.title,
      sessionTopic: session.topic,
      durationFormatted: session.audioMetadata?.durationFormatted || '',
      fullChronologicalNotes: accumulatedNotesSoFar
    });

    const { text: masterIndex, model } = await callGeminiWithRetry(
      {
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction,
        generationConfig: { temperature: 0.15, maxOutputTokens: 65536 }
      },
      (waitMsg) => {
        if (onEvent) onEvent({ type: 'rate_limit_wait', message: waitMsg });
      }
    );

    session = await SessionStorage.saveMasterIndex(session.id, masterIndex, model);
  }

  const doneMsg = `Completed [${session.code}]! Stored ${session.fullTranscriptWords} transcript words and ${session.notesWords} structured note words in PostgreSQL.`;
  session = await SessionStorage.updateLectureFields(session.id, {
    status: 'completed',
    statusMessage: doneMsg
  });

  if (onEvent) {
    onEvent({ type: 'session_completed', session, message: doneMsg });
  }

  return session;
}
