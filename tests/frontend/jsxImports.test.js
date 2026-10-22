// Every component a React screen renders must be imported or defined in that
// file. A missing import is not a build error (Vite compiles it happily) but
// crashes the page to a blank screen at runtime — the Settings page shipped
// that way once (InlineStack used, never imported). This catches it in CI.

const fs = require('fs');
const path = require('path');

const ROOTS = ['web/merchant/src', 'web/portal/src'].map((p) => path.join(__dirname, '..', '..', p));

function jsxFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return jsxFiles(full);
    return d.name.endsWith('.jsx') ? [full] : [];
  });
}

function declaredNames(src) {
  const names = new Set();
  // import X, { A, B as C } from '...'  /  import * as X from '...'
  // (The clause excludes quotes so a side-effect import like
  // `import './index.css'` is not swallowed into the next import.)
  for (const m of src.matchAll(/import\s+([^'";]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1];
    const def = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (def) names.add(def[1]);
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) names.add(ns[1]);
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
  }
  // function X(  /  const X =  /  class X
  for (const m of src.matchAll(/(?:function|class)\s+([A-Z][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Z][\w$]*)\s*=/g)) names.add(m[1]);
  // const { A, B } = something  (e.g. destructured icon sets)
  for (const m of src.matchAll(/(?:const|let|var)\s+\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function usedComponents(src) {
  const used = new Set();
  // <Foo ...> or <Foo.Bar ...>; only the root identifier needs declaring.
  for (const m of src.matchAll(/<([A-Z][\w$]*)(?:\.[\w$]+)*[\s/>]/g)) used.add(m[1]);
  return used;
}

const files = ROOTS.flatMap(jsxFiles);

describe('React screens import every component they render', () => {
  it('finds the merchant and portal screens', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [path.relative(path.join(__dirname, '..', '..'), f).replace(/\\/g, '/'), f]))('%s', (_rel, file) => {
    const src = fs.readFileSync(file, 'utf8');
    const declared = declaredNames(src);
    const missing = [...usedComponents(src)].filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });
});
