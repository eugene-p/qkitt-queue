import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    // Declarations come from `tsc -p tsconfig.build.json` (tsup dts is
    // incompatible with TypeScript 7's compiler host APIs today).
    dts: false,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    outDir: 'dist',
    treeshake: true,
    // Keep the public surface as a proper ESM package for Node + bundlers.
    splitting: false,
})
