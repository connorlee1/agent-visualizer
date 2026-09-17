import { build as bundle } from 'esbuild';
import { build as buildWeb } from 'vite';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const repo = path.dirname(desktop);
const output = path.join(desktop, 'build');

// All output stays under desktop/. In particular, never replace web/dist:
// the browser server may be serving it while a desktop build is running.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = await bundle({
  entryPoints: [path.join(repo, 'server/index.ts')],
  outfile: path.join(output, 'server/index.mjs'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
});
// A dependency installed at the repo root can hide a missing desktop dependency
// in development, then fail when the standalone app starts on another machine.
const manifest = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'));
const missing = new Set();
for (const file of Object.values(result.metafile.outputs)) {
  for (const imported of file.imports) {
    if (!imported.external || isBuiltin(imported.path)) continue;
    const parts = imported.path.split('/');
    const dependency = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!Object.hasOwn(manifest.dependencies ?? {}, dependency)) missing.add(dependency);
  }
}
if (missing.size) {
  throw new Error(`Missing desktop runtime dependencies: ${[...missing].join(', ')}. Add them to desktop/package.json before packaging.`);
}
await writeFile(path.join(output, 'server/meta.json'), JSON.stringify(result.metafile, null, 2));
await buildWeb({
  root: path.join(repo, 'web'),
  configFile: path.join(repo, 'web/vite.config.ts'),
  build: {
    outDir: path.join(output, 'web/dist'),
    emptyOutDir: true,
  },
});
