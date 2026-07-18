import { defineConfig } from 'tsup'

// Declarations come from `tsc -p tsconfig.build.json` (tsup dts is
// incompatible with TypeScript 7's compiler host APIs today).
export default defineConfig({
    entry: {
        index: 'src/index.ts',
    },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    outDir: 'dist',
    treeshake: true,
    external: ['@qkitt/queue'],
})
