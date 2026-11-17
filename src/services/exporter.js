import fs from 'node:fs';
import path from 'node:path';

export class ExporterService {
  static writeTranscriptFilesToDisk(sessionDir, session) {
    if (!session) return;
    fs.mkdirSync(path.join(sessionDir, 'transcripts'), { recursive: true });

    const completed = (session.chunks || [])
      .filter((c) => c.status === 'completed' && c.transcriptText)
      .sort((a, b) => a.index - b.index);

    const mdLines = [
      `# [${session.code}] ${session.title} — Full Verbatim Transcript`,
      `**Subject:** ${session.subjectName} (${session.subjectCode}) | **Lecture ID:** \`${session.code}\``,
      session.topic ? `**Topic Context:** ${session.topic}` : '',
      session.audioMetadata?.durationFormatted
        ? `**Audio Duration:** ${session.audioMetadata.durationFormatted} | **Stored Chunks:** ${completed.length}/${session.chunks.length}`
        : '',
      `---`,
      ''
    ].filter(Boolean);

    const txtLines = [];

    for (const c of completed) {
      mdLines.push(`### [${c.code}] Segment ${c.index + 1} (${c.startFormatted} – ${c.endFormatted})`);
      mdLines.push('');
      mdLines.push(c.transcriptText.trim());
      mdLines.push('');
      mdLines.push('---');
      mdLines.push('');

      txtLines.push(`[${c.code} | ${c.startFormatted} - ${c.endFormatted}]`);
      txtLines.push(c.transcriptText.trim());
      txtLines.push('');
    }

    fs.writeFileSync(path.join(sessionDir, 'full_transcript.md'), mdLines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'full_transcript.txt'), txtLines.join('\n'), 'utf8');
  }

  static buildCompiledNotesMarkdown(session) {
    const completedSections = (session.noteSections || [])
      .filter((s) => s.status === 'completed' && s.contentMarkdown)
      .sort((a, b) => a.sectionIndex - b.sectionIndex);

    const lines = [
      `# [${session.code}] ${session.title} — Comprehensive Lecture Notes`,
      `**Subject:** ${session.subjectName} (\`${session.subjectCode}\`) | **Lecture Code:** \`${session.code}\``,
      session.topic ? `**Specific Topics:** ${session.topic}` : '',
      session.audioMetadata?.durationFormatted ? `**Recording Duration:** ${session.audioMetadata.durationFormatted}` : '',
      `*Compiled from ${session.chunks?.length || 0} verbatim audio transcript chunks (${session.fullTranscriptWords || 0} words)*`,
      '',
      '---',
      ''
    ].filter((l) => l !== '');

    if (session.masterIndexMarkdown) {
      lines.push(session.masterIndexMarkdown.trim());
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    for (const sec of completedSections) {
      lines.push(sec.contentMarkdown.trim());
      lines.push('');
    }

    return lines.join('\n');
  }

  static writeNotesFileToDisk(sessionDir, fullNotesMarkdown) {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'comprehensive_notes.md'), fullNotesMarkdown, 'utf8');
  }
}
