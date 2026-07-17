import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text } from 'react-native';
import { Copy } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { copyWithAutoClear } from '../lib/secureClipboard';
import { useThemeColors } from '../hooks/useThemeColors';
import { Button } from './ui/Button';
import { CopiedToast } from './ui/CopiedToast';
import { TRANSCRIPT_COPY } from '../constants/strings';

interface TranscriptViewProps {
  transcript: string;
}

/**
 * Above this size the transcript is rendered as per-paragraph Text chunks.
 * A 1-2h consult transcript in ONE selectable Android TextView causes
 * multi-second layout, janky scrolling, and selection ANRs on the budget
 * clinic tablets this app targets. Below it, a single selectable Text keeps
 * whole-transcript long-press selection.
 */
const CHUNK_THRESHOLD_CHARS = 6_000;
/** Fallback chunk size when the text has no blank-line paragraph breaks. */
const FALLBACK_CHUNK_CHARS = 1_500;

/**
 * Split a long transcript into render chunks on blank-line boundaries,
 * falling back to sentence-accumulated ~1,500-char chunks for wall-of-text
 * transcripts. Join with '\n\n' round-trips the paragraph case; no content
 * is ever dropped. Exported for tests.
 */
export function chunkTranscript(text: string): string[] {
  if (text.length <= CHUNK_THRESHOLD_CHARS) return [text];

  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 1) {
    // Merge tiny paragraphs so we don't render thousands of Text nodes.
    // Oversized paragraphs are split FIRST (sentence, then hard boundaries):
    // a short heading followed by one 10,000-char speech-to-text paragraph
    // would otherwise ride through this branch as a single giant Text — the
    // exact Android layout/selection ANR this chunking exists to prevent
    // (Codex P2, PR #143).
    const chunks: string[] = [];
    let current = '';
    for (const para of paragraphs.flatMap(splitOversizedRun)) {
      if (current.length + para.length > FALLBACK_CHUNK_CHARS && current) {
        chunks.push(current);
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // No paragraph breaks — accumulate sentences, hard-splitting any single
  // "sentence" that itself exceeds the target (degraded speech-to-text can
  // produce 6,000+ chars with no punctuation at all, which would otherwise
  // come back as ONE chunk and reintroduce the Android single-TextView ANR).
  const sentences = text.split(/(?<=[.!?])\s+/).flatMap(hardSplitOversized);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length > FALLBACK_CHUNK_CHARS && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Split an oversized run at sentence boundaries first, hard boundaries last. */
function splitOversizedRun(run: string): string[] {
  if (run.length <= FALLBACK_CHUNK_CHARS) return [run];
  return run.split(/(?<=[.!?])\s+/).flatMap(hardSplitOversized);
}

/** Split a punctuation-less run at whitespace (hard char boundary as last resort). */
function hardSplitOversized(piece: string): string[] {
  if (piece.length <= FALLBACK_CHUNK_CHARS) return [piece];
  const words = piece.split(/\s+/);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    // A single unbroken token longer than the target gets sliced outright.
    if (word.length > FALLBACK_CHUNK_CHARS) {
      if (current) {
        out.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += FALLBACK_CHUNK_CHARS) {
        out.push(word.slice(i, i + FALLBACK_CHUNK_CHARS));
      }
      continue;
    }
    if (current.length + word.length + 1 > FALLBACK_CHUNK_CHARS && current) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Raw transcript text for a completed recording. Selectable so a vet can
 * grab a phrase without copying the whole thing; the Copy button uses the
 * auto-clearing clipboard like every other PHI copy path.
 */
export function TranscriptView({ transcript }: TranscriptViewProps) {
  const colors = useThemeColors();
  const [showCopied, setShowCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => clearTimeout(copyTimeoutRef.current);
  }, []);

  const chunks = useMemo(() => chunkTranscript(transcript ?? ''), [transcript]);

  const copyTranscript = async () => {
    try {
      await copyWithAutoClear(transcript ?? '');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setShowCopied(true);
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setShowCopied(false), 1500);
    } catch (error) {
      if (__DEV__) console.error('[Transcript] copy failed:', error);
    }
  };

  return (
    <View className="border border-border-default rounded-input p-3 relative">
      {/* Copy lives in a header row — it used to sit below the transcript,
          which for a long consult meant scrolling everything to reach it. */}
      <View className="flex-row justify-end mb-2">
        <CopiedToast visible={showCopied} label={TRANSCRIPT_COPY.copied} className="top-0 left-0 right-auto self-start" />
        <Button
          variant="secondary"
          size="sm"
          icon={<Copy color={colors.contentSecondary} size={12} />}
          accessibilityLabel="Copy transcript"
          onPress={() => {
            copyTranscript().catch(() => {});
          }}
        >
          {TRANSCRIPT_COPY.copy}
        </Button>
      </View>
      {chunks.map((chunk, i) => (
        <Text
          key={i}
          selectable
          className={`text-body text-content-body leading-relaxed ${i > 0 ? 'mt-3' : ''}`}
        >
          {chunk}
        </Text>
      ))}
    </View>
  );
}
