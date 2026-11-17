/**
 * Builds the system instruction and user prompt for verbatim lecture audio chunk transcription.
 */
export function buildChunkTranscriptionPrompts({
  chunk,
  totalChunks,
  lectureCode,
  subjectName,
  title,
  topic,
  previousTail,
  useStrictGuardrails = false,
  customHint = ''
}) {
  const guardrailLines = useStrictGuardrails
    ? [
        `STRICT ANTI-HALLUCINATION & ANTI-REPETITION GUARDRAILS:`,
        `- NEVER output repeated filler sounds such as "Hmm", "Professor: Hmm", "Student: Hmm", "uh", "um", "mm", or "हम्म".`,
        `- NEVER invent numbered student sequences (like Student 1..100) or synthetic alphabetical patterns (like A, B, C, D... Z) that are not actually spoken.`,
        `- NEVER repeat the same line, word, or phrase multiple times in a row.`,
        `- If the speaker pauses to write on the board, breathes, coughs, or if there is background classroom murmur/noise, DO NOT output "Hmm" for those pauses—skip the non-verbal noise and only transcribe actual spoken sentences!`,
        `- If the speakers mix English and Hindi (Hinglish), transcribe their exact spoken words naturally in Latin/English script (plus English technical terms).`
      ]
    : [
        `- Completely ignore non-verbal vocalizations ("hmm", "uh", "um", throat clearing, background hum) and never output lines consisting only of "Hmm".`
      ];

  const systemInstruction = [
    `You are an expert verbatim academic lecture and conversation transcriptionist.`,
    `Your job is to produce a COMPLETE, ACCURATE, WORD-FOR-WORD verbatim transcript of the provided audio segment.`,
    `CRITICAL RULES:`,
    `1. NEVER summarize, paraphrase, condense, or skip any portion of the actual speech. Every explanation, example, tangent, question, and detail spoken must be transcribed in full.`,
    `2. Clean up meaningless non-lexical stutters ("uh", "umm", "hmm") while keeping every actual spoken sentence intact and readable.`,
    ...guardrailLines,
    `3. Insert periodic timestamp markers in brackets like [${chunk.startFormatted}] at the start and roughly every 45-60 seconds or on speaker/topic shifts, using the real lecture timeline starting from ${chunk.startFormatted} and ending at ${chunk.endFormatted}.`,
    `4. If multiple speakers are audible (e.g. Professor / Student), label speaker turns clearly.`,
    `5. Output ONLY the verbatim transcript text—do not include introductory or concluding meta-commentary.`
  ].join('\n');

  const promptParts = [
    `Course Subject: "${subjectName || 'Academic Lecture'}" (Lecture ID: ${lectureCode || 'L01'})`,
    `Lecture Title: "${title || 'Lecture Recording'}"`,
    topic ? `Specific Topic / Keywords Context: "${topic}"` : '',
    customHint ? `Special User Instruction / Context for this Segment: "${customHint}"` : '',
    `Current Audio Segment: Chunk ${chunk.index + 1} of ${totalChunks} [${chunk.code || ''}] (Timeline: ${chunk.startFormatted} to ${chunk.endFormatted}).`
  ].filter(Boolean);

  if (previousTail) {
    promptParts.push(
      `\n<previous_chunk_tail>\n${previousTail}\n</previous_chunk_tail>\n` +
        `Instruction for continuity: The text in <previous_chunk_tail> is the end of the immediately preceding audio chunk. ` +
        `If the first few seconds of this audio segment repeat the final words of <previous_chunk_tail>, do NOT duplicate those repeated words—continue seamlessly right after them.`
    );
  }

  promptParts.push(
    `\nNow transcribe this audio segment (${chunk.startFormatted} – ${chunk.endFormatted}) completely and verbatim (do NOT output "Hmm" lines):`
  );

  return {
    systemInstruction,
    userPrompt: promptParts.join('\n')
  };
}
