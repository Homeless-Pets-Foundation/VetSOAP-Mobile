import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import vm from 'node:vm';

// Execute the actual callback body while supplying its React closure. This
// tests async state transitions without loading the native renderer in Node.
export async function loadProviderCallback(name, closure) {
  const source = await readFile(new URL('../../src/auth/AuthProvider.tsx', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('AuthProvider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) {
      const initializer = node.initializer;
      if (initializer && ts.isCallExpression(initializer) && initializer.expression.getText(parsed) === 'useCallback') {
        callback = initializer.arguments[0].getText(parsed);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!callback) throw new Error(`Missing provider callback: ${name}`);
  const compiled = ts.transpileModule(`module.exports = (${callback});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, __DEV__: false, Date, Promise, setTimeout, clearTimeout, ...closure,
  });
  return module.exports;
}
