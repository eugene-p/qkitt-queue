/**
 * Minimal static server for browser integration tests and store compare.
 * Serves package dist at /dist/* and fixtures at /*.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const distRoot = path.join(packageRoot, 'dist')
const fixturesRoot = path.join(__dirname, 'fixtures')

const port = Number(process.env.QKITT_BROWSER_PORT ?? 4173)
const host = process.env.QKITT_BROWSER_HOST ?? '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const safeJoin = (root, requestPath) => {
  const decoded = decodeURIComponent(requestPath.split('?')[0] ?? '')
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const full = path.join(root, normalized)
  if (!full.startsWith(root)) return null
  return full
}

const send = (res, status, body, contentType) => {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const serveFile = (res, filePath) => {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8')
    return
  }
  const ext = path.extname(filePath)
  const type = MIME[ext] ?? 'application/octet-stream'
  send(res, 200, fs.readFileSync(filePath), type)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`)
  const pathname = url.pathname

  if (pathname === '/' || pathname === '/harness.html') {
    serveFile(res, path.join(fixturesRoot, 'harness.html'))
    return
  }

  if (pathname.startsWith('/dist/')) {
    const rel = pathname.slice('/dist/'.length)
    serveFile(res, safeJoin(distRoot, rel))
    return
  }

  if (pathname.startsWith('/fixtures/')) {
    const rel = pathname.slice('/fixtures/'.length)
    serveFile(res, safeJoin(fixturesRoot, rel))
    return
  }

  // Allow /harness.js style under fixtures
  serveFile(res, safeJoin(fixturesRoot, pathname.slice(1)))
})

server.listen(port, host, () => {
  // Playwright webServer waits for this URL / stdout is fine either way.
  console.log(`qkitt browser static server http://${host}:${port}/harness.html`)
})
