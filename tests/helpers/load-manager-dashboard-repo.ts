import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const entry = new URL('../../src/shared/lib/db/managerDashboardRepo.ts', import.meta.url);
const implementation = new URL('./managerDashboardRepo/', entry).href;

/** Execute the real facade and internal graph; all external effects must be explicitly mocked. */
export function loadManagerDashboardRepo(modules: Record<string, unknown>): typeof import('../../src/shared/lib/db/managerDashboardRepo') {
  const dependencies = new Map(Object.entries(modules).map(([name, value]) => [
    name.startsWith('.') ? new URL(`${name}.ts`, entry).href : name, value,
  ]));
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  function load(url: URL): Record<string, unknown> {
    const existing = cache.get(url.href);
    if (existing) return existing.exports;
    const loaded = { exports: {} };
    cache.set(url.href, loaded);
    const code = ts.transpileModule(readFileSync(url, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'module', 'exports', 'console', code)((name: string) => {
      const key = name.startsWith('.') ? new URL(`${name}.ts`, url).href : name;
      if (dependencies.has(key)) return dependencies.get(key);
      assert.ok(key.startsWith(implementation), `Unexpected unmocked dependency: ${key}`);
      return load(new URL(key));
    }, loaded, loaded.exports, { error: () => {} });
    return loaded.exports;
  }
  return load(entry) as typeof import('../../src/shared/lib/db/managerDashboardRepo');
}
