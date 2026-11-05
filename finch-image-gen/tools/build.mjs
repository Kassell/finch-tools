/**
 * Build entry for both bundles.
 *
 * Two things here are not obvious:
 *
 * 1. `undici` is bundled (minitools install no dependencies at runtime) and it is
 *    CommonJS. Inside an ESM output its `require(...)` calls become esbuild's
 *    "dynamic require is not supported" throw, so the banner gives the bundle a
 *    real `require` via `createRequire`. Without it the module dies on import.
 * 2. `--target=node20` keeps the output compatible with the oldest Finch we
 *    support; undici 8 itself is fine there.
 */
import { build } from 'esbuild';
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(root, 'dist/index.js'),
  banner: {
    js: [
      "import { createRequire as __finchCreateRequire } from 'node:module';",
      'const require = __finchCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'warning',
});

await build({
  entryPoints: [join(root, 'src/gallery.ts')],
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  outfile: join(root, 'dist/gallery.js'),
  logLevel: 'warning',
});

for (const file of ['gallery.html', 'gallery.css']) {
  await cp(join(root, 'src', file), join(root, 'dist', file));
}

console.log('built dist/index.js, dist/gallery.js, gallery.html, gallery.css');
