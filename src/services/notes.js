import { callGeminiWithRetry } from './transcriber.js';
import { SessionStorage } from './storage.js';

/**
 * Groups completed transcript chunks into small windows (default 2 chunks = ~10 mins)
 * so Gemini generates exhaustive, encyclopedic notes for every single part of the lecture
 * without ever compressing or summarizing away details.
 */
function buildNoteSectionsFromChunks(chunks, chunksPerSection = 2) {
  const completed = (chunks || [])
    .filter((c) => c.status === 'completed' && c.transcriptText)
    .sort((a, b) => a.index - b.index);

  const sections = [];
  for (let i = 0; i < completed.length; i += chunksPerSection) {
    const slice = completed.slice(i, i + chunksPerSection);
    const sectionIndex = sections.length;
    sections.push({
      sectionIndex,
      chunkIndices: slice.map((c) => c.index),
      startFormatted: slice[0].startFormatted,
      endFormatted: slice[slice.length - 1].endFormatted,
      status: 'pending',
      contentMarkdown: '',
      wordCount: 0,
      modelUsed: '',
      updatedAt: null
    });
  }
  return sections;
}

/**
 * Generates exhaustive, textbook-depth notes for a single section (1-2 chunks of verbatim transcript).
 */
async function generateExhaustiveSectionNotes({
  sessionTitle,
  sessionTopic,
  section,
  totalSections,
  chunkTranscripts,
  onStatus
}) {
  const systemInstruction = [
    `You are an elite academic and technical scribe creating EXHAUSTIVE, COMPREHENSIVE lecture and discussion notes.`,
    `CRITICAL DIRECTIVE — NEVER SUMMARIZE:`,
    `- Your output must NEVER be a brief overview or surface-level summary.`,
    `- You must document EVERY SINGLE concept, explanation, step-by-step reasoning, derivation, example, real-world analogy, debate, question-and-answer, number/statistic, and nuance discussed in the transcript segment.`,
    `- Someone reading your notes should learn 100% of what was taught or discussed in the recording without ever needing to listen to the audio.`,
    `FORMATTING & DEPTH RULES:`,
    `1. Use clear Markdown subheadings (####) for each topic or discussion shift within this timeline (${section.startFormatted} – ${section.endFormatted}), including timestamp references like [${section.startFormatted}].`,
    `2. Explain every concept thoroughly in full sentences and structured bullet hierarchies: state the idea, WHY it works that way, HOW it was explained, and any caveats or edge cases mentioned.`,
    `3. Capture ALL examples, analogies, case studies, and hypothetical scenarios used by the speaker in complete detail.`,
    `4. Write out any formulas, equations, algorithms, code patterns, or technical terminology explicitly and explain each variable/component.`,
    `5. If questions, doubts, or back-and-forth conversation occurred, include a dedicated "**Discussion & Q&A Details**" block capturing the exact question and the full explanation given.`,
    `6. If the speaker mentioned any exam tips, common mistakes, homework, readings, or action items, highlight them in a \`> [!IMPORTANT]\` callout block.`
  ].join('\n');

  const combinedSegmentText = chunkTranscripts
    .map(
      (c) =>
        `--- TRANSCRIPT CHUNK ${c.index + 1} (${c.startFormatted} to ${c.endFormatted}) ---\n${c.transcriptText}`
    )
    .join('\n\n');

  const userPrompt = [
    `Lecture / Recording Title: "${sessionTitle}"`,
    sessionTopic ? `Course / Subject Context: "${sessionTopic}"` : '',
    `Section: Part ${section.sectionIndex + 1} of ${totalSections} (Timeline: ${section.startFormatted} – ${section.endFormatted})`,
    ``,
    `Below is the verbatim transcript for ${section.startFormatted} – ${section.endFormatted}.`,
    `Produce exhaustive, comprehensive, textbook-grade notes covering EVERY detail, explanation, example, formula, and discussion point in this segment. Do not leave anything out:`,
    ``,
    combinedSegmentText
  ]
    .filter((l) => l !== null)
    .join('\n');

  const { text, model } = await callGeminiWithRetry(
    {
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemInstruction,
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 8192
      }
    },
    onStatus
  );

  return { contentMarkdown: text, modelUsed: model };
}

/**
 * Generates the Master Reference Index (Complete Topic Roadmap, Glossary of All Terms/Formulas,
 * and Consolidated Action Items / Key Takeaways) from the compiled exhaustive sections.
 */
async function generateMasterReferenceIndex({ sessionTitle, sessionTopic, durationFormatted, noteSections, onStatus }) {
  const systemInstruction = [
    `You are compiling the Master Reference Guide & Index to sit at the top of an exhaustive multi-part lecture notes document.`,
    `Based on the detailed chronological notes provided, generate a rich Markdown reference header containing:`,
    `1. **## Complete Topic Roadmap & Timeline**: A chronological table or structured breakdown of every topic and sub-topic covered across the recording with their timestamps.`,
    `2. **## Complete Glossary of Terms, Concepts & Definitions**: Every technical term, concept, framework, or key entity discussed in the lecture with its complete definition as explained in the session.`,
    `3. **## Formulas, Rules, Frameworks & Core Principles**: Every equation, technical rule, step-by-step procedure, or core principle covered.`,
    `4. **## Action Items, Assignments, Exam Hints & Open Questions**: Every deadline, homework detail, recommended reading, common pitfall, or follow-up item mentioned (if none were mentioned, summarize the practical takeaways).`,
    `Do NOT replace the chronological notes—this is the structured reference index that precedes the full chronological breakdown.`
  ].join('\n');

  const sectionsDigest = noteSections
    .map(
      (s) =>
        `### Part ${s.sectionIndex + 1} (${s.startFormatted} – ${s.endFormatted})\n${s.contentMarkdown}`
    )
    .join('\n\n');

  const userPrompt = [
    `Lecture / Recording Title: "${sessionTitle}"`,
    sessionTopic ? `Subject / Topic: "${sessionTopic}"` : '',
    durationFormatted ? `Total Duration: ${durationFormatted}` : '',
    ``,
    `Here are the exhaustive chronological notes for the entire session. Generate the complete Master Reference Guide & Index (Topic Roadmap, Complete Glossary, Formulas/Frameworks, and Action Items):`,
    ``,
    sectionsDigest
  ]
    .filter(Boolean)
    .join('\n');

  const { text } = await callGeminiWithRetry(
    {
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemInstruction,
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 8192
      }
    },
    onStatus
  );

  return text;
}

/**
 * Generates and persists the complete, multi-section exhaustive lecture notes for a session.
 */
export async function generateComprehensiveNotesForSession(sessionId, forceRegenerate = false, onEvent = null) {
  let session = SessionStorage.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const completedChunks = (session.chunks || []).filter((c) => c.status === 'completed' && c.transcriptText);
  if (completedChunks.length === 0) {
    throw new Error('No transcribed chunks available yet to generate notes.');
  }

  session.status = 'generating_notes';
  session.error = null;

  if (forceRegenerate || !session.noteSections || session.noteSections.length === 0) {
    session.noteSections = buildNoteSectionsFromChunks(session.chunks, 2);
    session.masterIndexMarkdown = '';
  }

  SessionStorage.saveSession(session);

  const totalSections = session.noteSections.length;

  for (let i = 0; i < totalSections; i++) {
    session = SessionStorage.getSession(sessionId);
    const sec = session.noteSections[i];

    if (!forceRegenerate && sec.status === 'completed' && sec.contentMarkdown) {
      if (onEvent) {
        onEvent({
          type: 'note_section_completed',
          sectionIndex: sec.sectionIndex,
          totalSections,
          section: sec,
          message: `Note section ${i + 1}/${totalSections} (${sec.startFormatted} – ${sec.endFormatted}) already stored.`
        });
      }
      continue;
    }

    sec.status = 'generating';
    session.statusMessage = `Writing exhaustive notes for Part ${i + 1} of ${totalSections} (${sec.startFormatted} – ${sec.endFormatted})...`;
    SessionStorage.saveSession(session);

    if (onEvent) {
      onEvent({
        type: 'note_section_started',
        sectionIndex: sec.sectionIndex,
        totalSections,
        startFormatted: sec.startFormatted,
        endFormatted: sec.endFormatted,
        message: session.statusMessage
      });
    }

    const sectionChunks = session.chunks.filter((c) => sec.chunkIndices.includes(c.index));

    const { contentMarkdown, modelUsed } = await generateExhaustiveSectionNotes({
      sessionTitle: session.title,
      sessionTopic: session.topic,
      section: sec,
      totalSections,
      chunkTranscripts: sectionChunks,
      onStatus: (waitMsg) => {
        if (onEvent) onEvent({ type: 'rate_limit_wait', message: waitMsg });
      }
    });

    session = SessionStorage.saveNoteSection(sessionId, sec.sectionIndex, contentMarkdown, modelUsed);

    if (onEvent) {
      onEvent({
        type: 'note_section_completed',
        sectionIndex: sec.sectionIndex,
        totalSections,
        section: session.noteSections[i],
        notesWords: session.notesWords,
        message: `Completed exhaustive notes for Part ${i + 1}/${totalSections} (${session.noteSections[i].wordCount} words)`
      });
    }
  }

  // Generate the Master Reference Index & Glossary across all sections
  session = SessionStorage.getSession(sessionId);
  if (forceRegenerate || !session.masterIndexMarkdown) {
    session.statusMessage = 'Compiling Master Reference Index, Glossary & Formula Sheet...';
    SessionStorage.saveSession(session);

    if (onEvent) {
      onEvent({
        type: 'master_index_started',
        message: session.statusMessage
      });
    }

    const masterIndex = await generateMasterReferenceIndex({
      sessionTitle: session.title,
      sessionTopic: session.topic,
      durationFormatted: session.audioMetadata?.durationFormatted || '',
      noteSections: session.noteSections,
      onStatus: (waitMsg) => {
        if (onEvent) onEvent({ type: 'rate_limit_wait', message: waitMsg });
      }
    });

    session = SessionStorage.saveMasterIndex(sessionId, masterIndex);
  }

  session.status = 'completed';
  session.statusMessage = `Completed! Stored ${session.fullTranscriptWords} words of verbatim transcript and ${session.notesWords} words of comprehensive notes.`;
  SessionStorage.saveSession(session);

  if (onEvent) {
    onEvent({
      type: 'session_completed',
      session,
      message: session.statusMessage
    });
  }

  return session;
}
