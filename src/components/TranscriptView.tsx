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

/** A render chunk plus whether it begins at a blank-line boundary from the SOURCE. */
export interface TranscriptChunk {
  text: string;
  /**
   * True when this chunk starts a paragraph that existed in the source text.
   * Chunks created purely for sizing (a split oversized paragraph's tail)
   * are false so the renderer doesn't draw a paragraph-sized gap where the
   * source had none (Codex P2, PR #143).
   */
  startsSourceParagraph: boolean;
}

/**
 * Split a long transcript into render chunks on blank-line boundaries,
 * falling back to sentence-accumulated ~1,500-char chunks for wall-of-text
 * transcripts. No content is ever dropped. Exported for tests.
 */
export function chunkTranscript(text: string): TranscriptChunk[] {
  if (text.length <= CHUNK_THRESHOLD_CHARS) return [{ text, startsSourceParagraph: true }];

  // Whitespace-preserving chunker (Codex P2, PR #143): the transcript is
  // tokenized into text lines and the newline runs that separate them, so all
  // INNER whitespace (single-newline speaker turns, section labels, repeated
  // spaces) is reproduced verbatim inside each chunk. A chunk boundary is only
  // ever placed where a newline run already exists — that run is consumed and
  // the sibling <Text> blocks' own line break stands in for it, so chunking
  // changes Text-node size without changing the displayed transcript. A blank
  // line (>=2 newlines) at a consumed boundary marks the next chunk a source
  // paragraph start (renders the mt-3 gap). Only a single line longer than the
  // target is hard-split (unavoidable), and even then by SLICING so no
  // characters are lost or collapsed.
  const tokens = text.split(/(\n+)/); // [line, sep, line, sep, ...]
  const chunks: TranscriptChunk[] = [];
  let current = '';
  let startsParagraph = true;

  const flush = () => {
    if (current.length > 0) {
      chunks.push({ text: current, startsSourceParagraph: startsParagraph });
      current = '';
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (i % 2 === 1) {
      // Newline run separating two lines. Keep it inline while the chunk still
      // fits (verbatim); otherwise consume it as the boundary.
      if (current.length + token.length <= FALLBACK_CHUNK_CHARS) {
        current += token;
      } else {
        flush();
        startsParagraph = token.length >= 2;
      }
      continue;
    }

    // A text line. Slice-split only if it alone exceeds the target.
    const pieces = token.length > FALLBACK_CHUNK_CHARS ? hardSplitOversized(token) : [token];
    for (const piece of pieces) {
      if (current.length > 0 && current.length + piece.length > FALLBACK_CHUNK_CHARS) {
        flush();
        // A size-forced split mid-line is not a source paragraph boundary.
        startsParagraph = false;
      }
      current += piece;
    }
  }
  flush();
  return chunks;
}

/**
 * Slice an oversized line (no newlines of its own) into <=target pieces,
 * cutting AFTER a space so no character is dropped and repeated whitespace is
 * preserved within each piece (Codex P2, PR #143). A single unbroken token
 * longer than the target is cut at the hard char boundary as a last resort.
 */
function hardSplitOversized(line: string): string[] {
  if (line.length <= FALLBACK_CHUNK_CHARS) return [line];
  const out: string[] = [];
  let pos = 0;
  while (pos < line.length) {
    if (line.length - pos <= FALLBACK_CHUNK_CHARS) {
      out.push(line.slice(pos));
      break;
    }
    const window = line.slice(pos, pos + FALLBACK_CHUNK_CHARS);
    const lastSpace = window.lastIndexOf(' ');
    // Cut just after the space so it stays with the preceding piece.
    const cut = lastSpace > 0 ? lastSpace + 1 : window.length;
    out.push(line.slice(pos, pos + cut));
    pos += cut;
  }
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
          // mt-3 only at boundaries the SOURCE had — size-split continuation
          // chunks would otherwise render fake paragraph gaps.
          className={`text-body text-content-body leading-relaxed ${
            i > 0 && chunk.startsSourceParagraph ? 'mt-3' : ''
          }`}
        >
          {chunk.text}
        </Text>
      ))}
    </View>
  );
}
