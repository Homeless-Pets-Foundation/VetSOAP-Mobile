import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const requireForVm = createRequire(import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

async function loadTsModule(path) {
  const source = await read(path);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;

  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (id) => {
      if (id === './markdown') {
        return markdownModule;
      }
      return requireForVm(id);
    },
  });
  return module.exports;
}

const markdownModule = await loadTsModule('src/lib/markdown.ts');
const pdf = await loadTsModule('src/lib/soapPdf.ts');
const { buildSoapHtml, buildSoapPlainText } = pdf;

const soapNote = {
  id: 'soap-1',
  recordingId: 'rec-1',
  subjective: {
    content: '<script>alert("x")</script>\nOwner says **better** & eating.',
    isEdited: true,
    editedAt: '2026-06-10T12:00:00.000Z',
  },
  objective: {
    content: '<img src=x onerror=alert(1)>',
    isEdited: false,
    editedAt: null,
  },
  assessment: {
    content: 'Stable > yesterday',
    isEdited: false,
    editedAt: null,
  },
  plan: {
    content: 'Continue "meds" and recheck',
    isEdited: false,
    editedAt: null,
  },
  generatedAt: '',
  modelUsed: '',
  promptTokens: 0,
  completionTokens: 0,
  isExported: false,
  exportedTo: null,
  createdAt: '',
  updatedAt: '',
};

const recording = {
  patientName: '<Buddy & "Pal">',
  clientName: "O'Connor",
  species: 'Canine',
  breed: '<Lab>',
  appointmentType: 'Sick Visit',
  createdAt: '2026-06-10T12:00:00.000Z',
};

test('buildSoapHtml escapes every interpolated metadata and note field', () => {
  const html = buildSoapHtml(soapNote, recording);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;Buddy &amp; &quot;Pal&quot;&gt;/);
  assert.match(html, /O&#39;Connor/);
  assert.match(html, /&lt;Lab&gt;/);
  assert.match(html, /Stable &gt; yesterday/);
  assert.match(html, /Continue &quot;meds&quot; and recheck/);
});

test('buildSoapPlainText strips supported markdown markers for exports', () => {
  const text = buildSoapPlainText(soapNote);
  assert.match(text, /Owner says better & eating\./);
  assert.doesNotMatch(text, /\*\*/);
  assert.match(text, /SUBJECTIVE:/);
  assert.match(text, /PLAN:/);
});

test('native PDF share wrapper lazy-loads native modules', async () => {
  const source = await read('src/lib/share.ts');
  assert.match(source, /require\('expo-print'\)/);
  assert.match(source, /require\('expo-sharing'\)/);
  assert.doesNotMatch(source, /import .*expo-print/);
  assert.doesNotMatch(source, /import .*expo-sharing/);
  assert.match(source, /PDF_SHARE_CLEANUP_DELAY_MS/);
  assert.match(source, /schedulePdfCleanup\(uri\)/);
  assert.doesNotMatch(source, /finally\s*\{\s*if \(uri\) safeDeleteFile\(uri\);/);
});
