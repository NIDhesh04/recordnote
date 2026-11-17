/**
 * Strips leading timestamps ("[00:12]") and speaker labels ("Professor:", "Student 24:", "Speaker 1:")
 * from a line so we can inspect the actual spoken utterance on that line.
 */
export function extractUtteranceFromLine(line) {
  return String(line || '')
    .replace(/\[\d{2}:\d{2}(?::\d{2})?\]/g, '')
    .replace(/^(?:professor|student|speaker|person|user|lecturer|host|guest)\s*\d*\s*:\s*/i, '')
    .trim();
}

/**
 * Detects LLM audio hallucinations such as:
 * - 100 lines of "hmm", "Professor: Hmm. / Student: Hmm.", "हम्म"
 * - Numbered speaker loops like "Student 24: Hatt. / Student 25: Hatt. / Student 26: Hatt."
 * - Consecutive repeated lines or phrases (autoregressive repetition loops)
 * - Abnormally low unique word ratio (lexical collapse)
 */
export function detectTranscriptHallucination(text) {
  if (!text || typeof text !== 'string') {
    return { isHallucinated: true, reason: 'Empty transcript output' };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { isHallucinated: true, reason: 'Blank transcript output' };
  }

  const rawLines = trimmed.split(/\r?\n/);
  const utterances = rawLines.map(extractUtteranceFromLine).filter(Boolean);

  if (utterances.length === 0) {
    return { isHallucinated: true, reason: 'No spoken utterances extracted' };
  }

  const allUtteranceText = utterances.join(' ');
  const words = allUtteranceText
    .toLowerCase()
    .replace(/[.,!?;:"'()[\]{}|\\/<>-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return { isHallucinated: true, reason: 'No spoken words extracted' };
  }

  const fillerRegex = /^(h+m+|u+h+|u+m+|m+m+|a+h+|o+h+|eh+|er+|hat+t*|हम्म+|हूं+|अं+)$/i;
  let fillerCount = 0;
  let maxConsecutiveSameWord = 1;
  let currentStreak = 1;

  for (let i = 0; i < words.length; i++) {
    if (fillerRegex.test(words[i])) {
      fillerCount++;
    }
    if (i > 0) {
      if (words[i] === words[i - 1]) {
        currentStreak++;
        if (currentStreak > maxConsecutiveSameWord) {
          maxConsecutiveSameWord = currentStreak;
        }
      } else {
        currentStreak = 1;
      }
    }
  }

  if (fillerCount >= 10 && fillerCount / words.length >= 0.14) {
    return {
      isHallucinated: true,
      reason: `Excessive filler loop detected (${fillerCount} filler tokens out of ${words.length} words)`
    };
  }

  if (maxConsecutiveSameWord >= 7) {
    return {
      isHallucinated: true,
      reason: `Single-word repetition loop (${maxConsecutiveSameWord} identical consecutive words)`
    };
  }

  const normUtterances = utterances
    .map((u) => u.toLowerCase().replace(/[.,!?;:"'()[\]{}।]/g, '').trim())
    .filter(Boolean);

  if (normUtterances.length >= 6) {
    const lineFreq = new Map();
    let consecutiveStreak = 1;
    let maxStreak = 1;

    for (let i = 0; i < normUtterances.length; i++) {
      const u = normUtterances[i];
      lineFreq.set(u, (lineFreq.get(u) || 0) + 1);
      if (i > 0 && normUtterances[i] === normUtterances[i - 1]) {
        consecutiveStreak++;
        if (consecutiveStreak > maxStreak) {
          maxStreak = consecutiveStreak;
        }
      } else {
        consecutiveStreak = 1;
      }
    }

    if (maxStreak >= 5) {
      return {
        isHallucinated: true,
        reason: `Consecutive repeated utterance loop (${maxStreak} identical utterances in a row)`
      };
    }

    for (const [utt, count] of lineFreq.entries()) {
      if (count >= 8 && count / normUtterances.length >= 0.22) {
        return {
          isHallucinated: true,
          reason: `Utterance "${utt.slice(0, 25)}" repeated ${count} times (${Math.round(
            (count / normUtterances.length) * 100
          )}% of lines)`
        };
      }
    }
  }

  if (words.length >= 80) {
    const uniqueWords = new Set(words).size;
    const diversityRatio = uniqueWords / words.length;
    if (diversityRatio < 0.11) {
      return {
        isHallucinated: true,
        reason: `Low lexical diversity repetition loop (only ${uniqueWords} unique words across ${words.length} total words)`
      };
    }
  }

  return { isHallucinated: false, reason: null };
}

/**
 * Strips lines where the utterance is purely a filler ("Hmm.", "Professor: Hmm.", "Student: हम्म।")
 * and collapses consecutive duplicate short utterances.
 */
export function sanitizeTranscriptText(text) {
  if (!text) return '';
  const rawLines = text.split(/\r?\n/);
  const cleaned = [];
  let prevUtteranceNorm = null;
  let repeatCount = 0;

  for (const line of rawLines) {
    const utterance = extractUtteranceFromLine(line);
    const bare = utterance.replace(/[.,!?;:"'()[\]{}।]/g, '').trim();

    if (/^(h+m+|u+h+|u+m+|m+m+|a+h+|हम्म+|हूं+)[.!?,\s।]*$/i.test(bare)) {
      continue;
    }

    const norm = bare.toLowerCase();
    if (norm && norm === prevUtteranceNorm) {
      repeatCount++;
      if (repeatCount >= 2) {
        continue;
      }
    } else {
      prevUtteranceNorm = norm || prevUtteranceNorm;
      repeatCount = 0;
    }

    cleaned.push(line);
  }

  return cleaned.join('\n').trim();
}
