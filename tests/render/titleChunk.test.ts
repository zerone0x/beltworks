/**
 * Loading (#112, D64): the main chunk, which the title screen waits for,
 * must not contain PixiJS. It holds what src/main.ts imports statically
 * (dynamic `import()`s, like the renderer's in loadRenderer.ts, are chunks
 * of their own), so no module reachable that way may import `pixi.js` - nor
 * any other npm package: vite.config.ts puts everything from `node_modules`
 * into the `pixi` chunk, so a static import of any package would make the
 * title screen wait for all of PixiJS.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** The modules `file` imports at run time (not `import type` / `export type`), as written. */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const out: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      out.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      out.push((node.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return out;
}

/** Whether `spec` names an npm package (bundled into the `pixi` chunk), not one of the game's files. */
function isPackage(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/');
}

/** The chain of static imports from `entry` to an npm package, or `null` if there is none. */
function pathToPackage(entry: string): string[] | null {
  const seen = new Set<string>();
  const visit = (file: string): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      if (isPackage(spec)) return [relative(ROOT, file), spec];
      // Only the game's own TypeScript modules lead further (JSON imports nothing).
      if (spec.endsWith('.json')) continue;
      const found = visit(`${resolve(dirname(file), spec)}.ts`);
      if (found) return [relative(ROOT, file), ...found];
    }
    return null;
  };
  return visit(entry);
}

describe('main chunk', () => {
  it('reaches no npm package (PixiJS or another) through static imports from main.ts', () => {
    expect(pathToPackage(resolve(ROOT, 'src/main.ts'))).toBeNull();
  });

  it('would notice a static import of the renderer', () => {
    expect(pathToPackage(resolve(ROOT, 'src/render/renderer.ts'))).toEqual([
      'src/render/renderer.ts',
      'pixi.js',
    ]);
    expect(pathToPackage(resolve(ROOT, 'src/render/beltLayer.ts'))).not.toBeNull();
  });
});
