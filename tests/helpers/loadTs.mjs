// Minimal TS module loader for unit-testing pure source modules under Node's
// built-in test runner. Transpiles a .ts file (and its relative .ts imports)
// with the `typescript` compiler and runs it in a vm context. Resolution is
// SYNCHRONOUS and on-demand: a relative require is only loaded when actually
// executed, so a *lazy* require buried inside an uncalled function (e.g.
// secureStorage's lazy require('./monitoring')) never pulls its dependency tree.
//
// Non-relative specifiers resolve to injected `mocks` first, then to the real
// Node require. Use ONLY for modules whose executed code paths avoid the React
// Native runtime; supply expo/react-native specifiers via `mocks`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const repoRoot = new URL('../../', import.meta.url);
const requireReal = createRequire(import.meta.url);

const SANDBOX_GLOBALS = {
  __DEV__: false,
  process,
  Error,
  TypeError,
  RangeError,
  Promise,
  Math,
  Number,
  JSON,
  Date,
  Uint8Array,
  ArrayBuffer,
  Array,
  Object,
  String,
  Boolean,
  Map,
  Set,
  Symbol,
  console,
  setTimeout,
  clearTimeout,
};

function resolveRelative(fromFile, spec) {
  let resolved = path.resolve(path.dirname(fromFile), spec);
  if (!resolved.endsWith('.ts')) resolved += '.ts';
  return resolved;
}

/**
 * Load a repo-relative .ts module (e.g. 'src/lib/durableAudio/tombstone.ts').
 * @param {string} relPath repo-relative path
 * @param {Record<string, unknown>} mocks bare specifier -> module exports
 */
export async function loadTsModule(relPath, mocks = {}) {
  const cache = new Map();

  function loadSync(absFile) {
    if (cache.has(absFile)) return cache.get(absFile);
    const source = readFileSync(absFile, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        strict: false,
        esModuleInterop: true,
      },
    }).outputText;

    const moduleObj = { exports: {} };
    cache.set(absFile, moduleObj.exports); // cache pre-run for cycle safety

    const localRequire = (spec) => {
      if (spec.startsWith('.')) {
        return loadSync(resolveRelative(absFile, spec));
      }
      if (Object.prototype.hasOwnProperty.call(mocks, spec)) return mocks[spec];
      return requireReal(spec);
    };

    vm.runInNewContext(compiled, {
      ...SANDBOX_GLOBALS,
      exports: moduleObj.exports,
      module: moduleObj,
      require: localRequire,
    });
    cache.set(absFile, moduleObj.exports);
    return moduleObj.exports;
  }

  return loadSync(fileURLToPath(new URL(relPath, repoRoot)));
}
