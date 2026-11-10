import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Normalizes BASE_PATH so it always starts and ends with a slash.
 * The deploy workflow builds with BASE_PATH=/beltworks-play/.
 */
function basePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '/' : `/${trimmed}/`;
}

/** The file the build writes the bundled packages' licenses into (src/ui/about.ts links to it, D61). */
const LICENSES_FILE = 'third-party-licenses.txt';

/** The root directory of the npm package module `id` belongs to, or `null` outside `node_modules`. */
function packageRoot(id: string): string | null {
  const m = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id);
  return m ? m[1]! : null;
}

/** The MIT license's text, for a package that says it is MIT but ships no license file. */
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/**
 * Writes `third-party-licenses.txt` next to the game: the name, version,
 * license and license text of every npm package whose code ends up in the
 * bundle (PixiJS and what it pulls in), read from the modules actually
 * bundled, so the list follows the dependencies by itself. A bundled
 * package without a license file fails the build.
 */
function thirdPartyLicenses(): Plugin {
  return {
    name: 'beltworks-third-party-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const roots = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds) {
          const root = packageRoot(id);
          if (root) roots.add(root);
        }
      }
      const entries = [...roots].map((root) => {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
          name: string;
          version: string;
          license?: string;
          homepage?: string;
          author?: string | { name: string };
        };
        const file = readdirSync(root).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
        if (file) return { pkg, text: readFileSync(join(root, file), 'utf8').trim() };
        const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
        if (pkg.license !== 'MIT' || !author) {
          throw new Error(`${pkg.name}: bundled, but has no license file`);
        }
        return { pkg, text: `MIT License\n\nCopyright (c) ${author}\n\n${MIT_TEXT}` };
      });
      entries.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
      const header =
        'Beltworks bundles the following open-source packages. Their licenses follow.\n' +
        'Everything else in the game (code, art, sound and music) is original to the project.\n';
      const body = entries.map(
        ({ pkg, text }) =>
          `${'='.repeat(72)}\n${pkg.name} ${pkg.version} (${pkg.license ?? 'see below'})` +
          `${pkg.homepage ? `\n${pkg.homepage}` : ''}\n${'-'.repeat(72)}\n${text}\n`,
      );
      this.emitFile({
        type: 'asset',
        fileName: LICENSES_FILE,
        source: [header, ...body].join('\n'),
      });
    },
  };
}

export default defineConfig({
  base: basePath(process.env.BASE_PATH),
  plugins: [thirdPartyLicenses()],
  build: {
    target: 'es2022',
    // No sourcemaps in the deployed build: players download only what runs.
    sourcemap: false,
    rolldownOptions: {
      // The game, and the standalone WebGPU belt demo (demo/gpu/README.md), which shares no code with it.
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        gpu: fileURLToPath(new URL('demo/gpu/index.html', import.meta.url)),
      },
      output: {
        // The bundled packages (PixiJS and what it pulls in) in a chunk of their own, loaded
        // behind the title screen with the renderer (D64). It changes only with the dependencies
        // (or the PixiJS features the game uses), so returning players keep it across releases.
        // Vite's preload helper gets its own small chunk: the main chunk needs it, and in the
        // packages' chunk it would make the main chunk wait for all of PixiJS. The module preload
        // polyfill goes with it: with two pages it would otherwise get a chunk of its own, one more
        // request before the game starts.
        codeSplitting: {
          groups: [
            { name: 'preload', test: /preload-helper|modulepreload-polyfill/, priority: 1 },
            { name: 'pixi', test: /[\\/]node_modules[\\/]/ },
          ],
        },
      },
    },
    // The packages' chunk is about 610 kB (175 kB gzipped); every other chunk stays below 500 kB.
    chunkSizeWarningLimit: 700,
  },
});
