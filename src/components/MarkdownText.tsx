import React from 'react';
import { View } from 'react-native';
import { Text } from './ui/Text';
import {
  parseMarkdownBlocks,
  toPlainText,
  type MarkdownBlock,
  type MarkdownSpan,
} from '../lib/markdown';

// Re-export the pure helpers so callers can treat this component as the
// markdown entry point (parser lives in src/lib/markdown.ts for testability).
export { parseMarkdownBlocks, toPlainText };

interface MarkdownTextProps {
  text: string;
  /** Tailwind classes for body text. Default matches SOAP section body copy. */
  textClassName?: string;
}

const DEFAULT_TEXT_CLASS = 'text-body text-content-body leading-relaxed';

// Every <Text> here is long-form reading copy (SOAP and translation section
// bodies), so each one — nested spans included, since RN caps per fragment —
// takes the 2.0x reading ceiling. See READING_MAX_FONT_SIZE_MULTIPLIER.

function Spans({ spans }: { spans: MarkdownSpan[] }) {
  return (
    <>
      {spans.map((span, i) =>
        span.bold ? (
          <Text key={i} scaling="reading" className="font-semibold text-content-primary">
            {span.text}
          </Text>
        ) : (
          <Text key={i} scaling="reading">
            {span.text}
          </Text>
        )
      )}
    </>
  );
}

function Block({
  block,
  isFirst,
  textClassName,
}: {
  block: MarkdownBlock;
  isFirst: boolean;
  textClassName: string;
}) {
  switch (block.type) {
    case 'header':
      return (
        <Text
          scaling="reading"
          className={`${block.level === 1 ? 'text-body-lg' : 'text-body'} font-bold text-content-primary ${isFirst ? '' : 'mt-2'} mb-1`}
          accessibilityRole="header"
        >
          <Spans spans={block.spans} />
        </Text>
      );
    case 'bullet':
    case 'numbered':
      return (
        <View className="flex-row mb-1 pl-1">
          <Text scaling="reading" className={textClassName}>
            {block.type === 'bullet' ? '•' : block.marker}
            {'  '}
          </Text>
          {/* flex-1 so the label claims row space and wraps instead of clipping (Android Text-in-flex-row gotcha) */}
          <Text scaling="reading" className={`${textClassName} flex-1`}>
            <Spans spans={block.spans} />
          </Text>
        </View>
      );
    case 'paragraph':
    default:
      return (
        <Text scaling="reading" className={`${textClassName} ${isFirst ? '' : 'mt-1'} mb-1`}>
          <Spans spans={block.spans} />
        </Text>
      );
  }
}

/**
 * Renders AI-generated SOAP content with minimal markdown support
 * (**bold**, bullets, headers, numbered lists). Any parse failure falls back
 * to the raw string — visible `**` beats a crashed detail screen.
 */
export function MarkdownText({ text, textClassName = DEFAULT_TEXT_CLASS }: MarkdownTextProps) {
  let blocks: MarkdownBlock[] | null = null;
  try {
    blocks = parseMarkdownBlocks(text ?? '');
  } catch (error) {
    if (__DEV__) console.error('[MarkdownText] parse failed:', error);
  }

  if (!blocks) {
    return (
      <Text scaling="reading" className={textClassName}>
        {text ?? ''}
      </Text>
    );
  }

  return (
    <View>
      {blocks.map((block, i) => (
        <Block key={i} block={block} isFirst={i === 0} textClassName={textClassName} />
      ))}
    </View>
  );
}
