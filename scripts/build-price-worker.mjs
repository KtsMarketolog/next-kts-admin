import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/shared/lib/priceBuild/worker.ts'],
  outfile: '.runtime-build/price-build-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  metafile: true,
  legalComments: 'none',
});

// The runtime worker must be a self-contained pure calculation, not a path back
// into the application database/network or a dependency omitted by standalone.
const permittedExternal = new Set(['node:worker_threads', 'node:perf_hooks', 'node:v8']);
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (!permittedExternal.has(imported.path)) throw new Error(`Unexpected price worker external dependency: ${imported.path}`);
  }
}
for (const input of Object.keys(result.metafile.inputs)) {
  if (input.includes('/db/') || input.includes('node_modules/')) throw new Error(`Unexpected price worker input: ${input}`);
}
console.log('Bundled private price build worker');
