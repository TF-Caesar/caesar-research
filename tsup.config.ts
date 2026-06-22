import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // No banner: tsup preserves the shebang from src/cli.ts (adding one here
  // would produce a duplicate shebang and a syntax error).
  // caesar-search is a runtime dependency; keep it external (not bundled).
  external: ['caesar-search'],
});
