import { build as bundle } from 'esbuild';
import { build as buildWeb } from 'vite';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
await writeFile(path.join(output, 'server/meta.json'), JSON.stringify(result.metafile, null, 2));
await buildWeb({
  root: path.join(repo, 'web'),
  configFile: path.join(repo, 'web/vite.config.ts'),
  build: {
    outDir: path.join(output, 'web/dist'),
    emptyOutDir: true,
  },
});
