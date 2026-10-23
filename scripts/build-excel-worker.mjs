import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/entities/catalog/api/excelProcessing/worker.ts'],
  outfile: '.runtime-build/excel-processing-worker.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  metafile: true, legalComments: 'none',
});
// SheetJS exposes optional fs/stream-backed APIs, but this worker calls only its
// in-memory read API. No application database, network, env loader or secret
// module may enter the parser bundle.
const permittedExternal = new Set(['node:worker_threads', 'node:zlib', 'fs', 'stream']);
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (!permittedExternal.has(imported.path)) throw new Error(`Unexpected Excel worker dependency: ${imported.path}`);
  }
}
for (const input of Object.keys(result.metafile.inputs)) {
  if (input.includes('/db/') || input.includes('dotenv') || input.includes('Auth')) throw new Error(`Unexpected Excel worker input: ${input}`);
}
console.log('Bundled private Excel processing worker');
