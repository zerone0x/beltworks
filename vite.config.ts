import { defineConfig } from 'vite';

/**
 * Normalizes BASE_PATH so it always starts and ends with a slash.
 * The deploy workflow builds with BASE_PATH=/beltworks-play/.
 */
function basePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '/' : `/${trimmed}/`;
}

export default defineConfig({
  base: basePath(process.env.BASE_PATH),
  build: {
    target: 'es2022',
    // The deployed site is public while this repo is private: never ship sourcemaps.
    sourcemap: false,
  },
});
