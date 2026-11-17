/**
 * Builds the system instruction and user prompt for cumulative, context-chained
 * structured lecture notes generation.
 */
export function buildCumulativeNotesPrompts({
  lectureCode,
  subjectName,
  sessionTitle,
  sessionTopic,
  section,
  totalSections,
  accumulatedNotesSoFar,
  previousTranscriptTail,
  currentChunkTranscript
}) {
  const isFirstChunk = section.sectionIndex === 0 || !accumulatedNotesSoFar.trim();

  const systemInstruction = [
    `You are an elite university professor and textbook author writing structured, comprehensive, publication-grade lecture notes for the course "${subjectName}" (${lectureCode}).`,
    ``,
    `CORE MISSION:`,
    `Transform the raw lecture transcript into deeply structured, logically organized, crystal-clear academic lecture notes that read like a cohesive textbook chapter—NOT a fragmented transcript dump and NOT a shallow summary.`,
    ``,
    `CONTINUITY & CONTEXT RULES (CRITICAL):`,
    isFirstChunk
      ? `- This is the FIRST segment of the lecture (${section.startFormatted} – ${section.endFormatted}). Start numbering major topics cleanly from \`## 1. <Topic Name>\`, with sub-sections \`### 1.1\`, \`### 1.2\`, etc.`
      : [
          `- You are given \`<accumulated_lecture_notes_so_far>\`, which contains the complete lecture notes already written for earlier segments of this same lecture.`,
          `- Read \`<accumulated_lecture_notes_so_far>\` carefully so your new output connects seamlessly:`,
          `  1. DO NOT repeat or rewrite anything already covered in \`<accumulated_lecture_notes_so_far>\`.`,
          `  2. Maintain exact continuity in section numbering! If the previous notes ended at \`## 2. ...\` / \`### 2.2 ...\`, and the speaker is continuing that same topic, continue with \`### 2.3 ...\` (or finish the ongoing proof/example first). If the speaker transitions to a new major topic, start \`## 3. <New Topic Title>\`.`,
          `  3. Maintain consistent terminology, variable names, and mathematical notation established in the earlier notes.`
        ].join('\n'),
    ``,
    `STRUCTURAL & FORMATTING STANDARDS:`,
    `1. **Topic-Driven Hierarchy**: Organize by logical concepts (\`## N. Topic\`, \`### N.M Sub-topic\`) with subtle timestamp anchors like \`[${section.startFormatted}]\` next to headings or key transitions.`,
    `2. **Formal Definitions & Theorems**: Whenever a term, principle, theorem, or model is introduced, format it clearly (e.g. **Definition (Term):** ..., **Theorem / Principle:** ..., **Intuition / Why It Matters:** ...).`,
    `3. **Step-by-Step Derivations, Proofs & Mechanisms**: Never skip intermediate steps. Lay out every proof, algorithm, mechanism, or logical argument step-by-step (Step 1, Step 2, ...).`,
    `4. **Worked Examples & Analogies**: Document every example, blackboard problem, real-world analogy, or case study in a dedicated **Worked Example** or **Illustration** block showing both the setup and the full walkthrough.`,
    `5. **Classroom Q&A / Clarifications**: If a student asks a question or the speaker addresses a common misconception, capture it in a clean callout:`,
    `   \`> [!NOTE] Concept Clarification / Q&A:\` followed by the question and complete answer.`,
    `6. **Exam Hints / Key Warnings**: Use \`> [!IMPORTANT]\` for exam tips, homework mentions, or critical edge cases.`,
    `7. Output ONLY the new Markdown notes continuation for the current segment—no meta-commentary.`
  ].join('\n');

  const promptParts = [
    `Course Subject: "${subjectName}" | Lecture Code: ${lectureCode}`,
    `Lecture Title: "${sessionTitle}"`,
    sessionTopic ? `Specific Topic / Keywords: "${sessionTopic}"` : '',
    `Current Segment: Chunk ${section.sectionIndex + 1} of ${totalSections} (Timeline: ${section.startFormatted} – ${section.endFormatted})`
  ].filter(Boolean);

  if (!isFirstChunk) {
    promptParts.push(
      `\n<accumulated_lecture_notes_so_far>\n${accumulatedNotesSoFar}\n</accumulated_lecture_notes_so_far>`
    );
  }

  if (previousTranscriptTail) {
    promptParts.push(
      `\n<previous_chunk_transcript_tail>\n${previousTranscriptTail}\n</previous_chunk_transcript_tail>`
    );
  }

  promptParts.push(
    `\n<current_chunk_transcript timeline="${section.startFormatted}-${section.endFormatted}">\n${currentChunkTranscript}\n</current_chunk_transcript>`,
    ``,
    isFirstChunk
      ? `Write the structured, comprehensive lecture notes for this opening segment (${section.startFormatted} – ${section.endFormatted}), starting with "## 1. ...":`
      : `Continue writing the next structured sections of the lecture notes for the current segment (${section.startFormatted} – ${section.endFormatted}), picking up seamlessly from the end of <accumulated_lecture_notes_so_far>:`
  );

  return {
    systemInstruction,
    userPrompt: promptParts.join('\n')
  };
}

/**
 * Builds the system instruction and user prompt for the Executive Header & Master Reference Index.
 */
export function buildMasterReferencePrompts({
  lectureCode,
  subjectName,
  sessionTitle,
  sessionTopic,
  durationFormatted,
  fullChronologicalNotes
}) {
  const systemInstruction = [
    `You are creating the Executive Header & Quick-Reference Guide to place at the very top of the completed university lecture notes for "${subjectName}" (${lectureCode}).`,
    `Read the complete structured lecture notes provided and generate a clean, well-formatted Markdown header containing:`,
    `1. **## Lecture Overview & Core Objectives**: A concise, high-clarity synthesis of what this lecture covers and how the concepts connect.`,
    `2. **## Structured Outline & Timeline**: A numbered table of contents matching the exact \`## N.\` and \`### N.M\` sections in the lecture notes with their timestamps.`,
    `3. **## Key Definitions, Theorems & Formulas Reference**: A structured reference list of all formal definitions, theorems, equations, and core rules introduced in the lecture.`,
    `4. **## Action Items, Exam Takeaways & Open Questions**: Any homework, exam tips, common pitfalls, or key review takeaways mentioned.`,
    `Output ONLY the Markdown for these 4 reference sections—do not repeat the full lecture body.`
  ].join('\n');

  const userPrompt = [
    `Course Subject: "${subjectName}" (${lectureCode})`,
    `Lecture Title: "${sessionTitle}"`,
    sessionTopic ? `Specific Topic: "${sessionTopic}"` : '',
    durationFormatted ? `Recording Duration: ${durationFormatted}` : '',
    ``,
    `Here are the complete structured lecture notes for the session. Generate the Executive Header & Quick-Reference Guide:`,
    ``,
    fullChronologicalNotes
  ]
    .filter(Boolean)
    .join('\n');

  return { systemInstruction, userPrompt };
}
