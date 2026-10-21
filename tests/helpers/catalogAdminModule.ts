import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as catalogImportValidation from '../../src/entities/catalog/api/catalogImportValidation';

// Only the extracted, pure repository modules may be followed. Every IO edge
// remains an explicit stub; an unknown import fails rather than reaching a DB.
const modules = new Set([
  './core', './productInput', './entityWrites', './wholesaleSync',
  './importMatching', './productRowWrites', './stats', './productMutations', './importApply',
]);

export function loadCatalogAdminModule<T>(dependencies: Record<string, unknown>): T {
  const cache = new Map<string, { exports: object }>();
  function load(name: string): unknown {
    if (name in dependencies) return dependencies[name];
    if (name === '../catalogImportValidation') return catalogImportValidation;
    assert.ok(modules.has(name), `Unexpected IO dependency: ${name}`);
    const existing = cache.get(name);
    if (existing) return existing.exports;
    const source = readFileSync(new URL(`../../src/entities/catalog/api/catalogAdmin/${name.slice(2)}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const loaded = { exports: {} };
    cache.set(name, loaded);
    new Function('require', 'module', 'exports', code)(load, loaded, loaded.exports);
    return loaded.exports;
  }
  return load('./core') as T;
}
