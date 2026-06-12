import type { Recording, SoapNote } from '../types';
import { toPlainText } from './markdown';

const SECTION_ORDER = [
  ['subjective', 'Subjective'],
  ['objective', 'Objective'],
  ['assessment', 'Assessment'],
  ['plan', 'Plan'],
] as const;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeMultiline(value: unknown): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br />');
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function buildSoapPlainText(soapNote: SoapNote): string {
  return SECTION_ORDER.map(([key, label]) => {
    const content = toPlainText(soapNote[key]?.content ?? '');
    return `${label.toUpperCase()}:\n${content}`;
  }).join('\n\n');
}

export function buildSoapHtml(soapNote: SoapNote, recording?: Pick<Recording,
  'patientName' | 'clientName' | 'species' | 'breed' | 'appointmentType' | 'createdAt'
>): string {
  const metadata = [
    ['Patient', recording?.patientName],
    ['Client', recording?.clientName],
    ['Species', recording?.species],
    ['Breed', recording?.breed],
    ['Visit Type', recording?.appointmentType],
    ['Date', formatDate(recording?.createdAt)],
  ].filter(([, value]) => typeof value === 'string' && value.trim().length > 0);

  const metadataHtml = metadata.length
    ? `<dl class="meta">${metadata.map(([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
      ).join('')}</dl>`
    : '';

  const sectionsHtml = SECTION_ORDER.map(([key, label]) => {
    const section = soapNote[key];
    const content = toPlainText(section?.content ?? '');
    const editedAt = section?.isEdited ? formatDate(section.editedAt) : '';
    return `
      <section>
        <h2>${escapeHtml(label)}</h2>
        ${editedAt ? `<p class="edited">Edited ${escapeHtml(editedAt)}</p>` : ''}
        <p>${escapeMultiline(content)}</p>
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1c1917; padding: 32px; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    h2 { font-size: 17px; margin: 24px 0 8px; color: #0d8775; }
    p { font-size: 13px; line-height: 1.48; margin: 0; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; margin: 0 0 20px; }
    .meta div { break-inside: avoid; }
    dt { color: #78716c; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
    dd { margin: 2px 0 0; font-size: 13px; }
    .edited { color: #78716c; font-size: 11px; margin-bottom: 6px; }
    section { break-inside: avoid; border-top: 1px solid #e7e5e4; padding-top: 12px; }
  </style>
</head>
<body>
  <h1>SOAP Note</h1>
  ${metadataHtml}
  ${sectionsHtml}
</body>
</html>`;
}

export const __soapPdfTestUtils = { escapeHtml };
