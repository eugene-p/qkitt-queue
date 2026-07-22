/**
 * After `tsc -p tsconfig.build.json`, keep only `.d.ts` files reachable from
 * package export entry points. Private modules still emit for the compile,
 * but are not published.
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const distRoot = path.join(packageRoot, 'dist')

/** Public declaration roots (mirror package.json `exports` types fields). */
const ENTRY_DTS = ['index.d.ts']

const IMPORT_RE =
    /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+from\s+)?['"](\.[^'"]+)['"]/g

const toPosix = (p) => p.split(path.sep).join('/')

async function pathExists(file) {
    try {
        await stat(file)
        return true
    } catch {
        return false
    }
}

/** Resolve a relative specifier from a .d.ts file to an absolute .d.ts path. */
async function resolveDts(fromFile, specifier) {
    const base = path.resolve(path.dirname(fromFile), specifier)
    const candidates = [base, `${base}.d.ts`, path.join(base, 'index.d.ts')]
    for (const candidate of candidates) {
        if (candidate.endsWith('.d.ts') && (await pathExists(candidate))) {
            return path.normalize(candidate)
        }
        const asDts = candidate.endsWith('.d.ts')
            ? candidate
            : `${candidate}.d.ts`
        if (await pathExists(asDts)) return path.normalize(asDts)
    }
    return null
}

async function collectDtsFiles(dir, out = []) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            await collectDtsFiles(full, out)
        } else if (
            entry.name.endsWith('.d.ts') &&
            !entry.name.endsWith('.d.ts.map')
        ) {
            out.push(full)
        }
    }
    return out
}

async function walkReachable(entryAbs, kept) {
    const queue = [entryAbs]
    while (queue.length > 0) {
        const current = queue.pop()
        if (!current || kept.has(current)) continue
        if (!(await pathExists(current))) continue
        kept.add(current)

        const text = await readFile(current, 'utf8')
        IMPORT_RE.lastIndex = 0
        let match
        while ((match = IMPORT_RE.exec(text)) !== null) {
            const resolved = await resolveDts(current, match[1])
            if (resolved && !kept.has(resolved)) queue.push(resolved)
        }
    }
}

async function main() {
    if (!(await pathExists(distRoot))) {
        console.error('prune-dts: dist/ missing — run tsc first')
        process.exit(1)
    }

    const kept = new Set()
    for (const rel of ENTRY_DTS) {
        const abs = path.normalize(path.join(distRoot, rel))
        if (!(await pathExists(abs))) {
            console.error(`prune-dts: missing entry ${rel}`)
            process.exit(1)
        }
        await walkReachable(abs, kept)
    }

    const all = await collectDtsFiles(distRoot)
    const removed = []
    for (const file of all) {
        if (kept.has(path.normalize(file))) continue
        removed.push(file)
        await rm(file, { force: true })
        const map = `${file}.map`
        if (await pathExists(map)) await rm(map, { force: true })
    }

    const keptRel = [...kept]
        .map((f) => toPosix(path.relative(distRoot, f)))
        .sort()
    const removedRel = removed
        .map((f) => toPosix(path.relative(distRoot, f)))
        .sort()

    console.log(
        `prune-dts: kept ${keptRel.length} d.ts, removed ${removedRel.length}`,
    )
    if (removedRel.length > 0) {
        for (const rel of removedRel) console.log(`  - ${rel}`)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
