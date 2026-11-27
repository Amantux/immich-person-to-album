import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import request from 'supertest'

const ORIGINAL_CWD = process.cwd()

describe('Web UI', () => {
  let server: { listen?: unknown, close?: () => Promise<void> } | undefined
  let staticDir: string

  beforeAll(async () => {
    staticDir = mkdtempSync(join(tmpdir(), 'immich-person-to-album-'))
    mkdirSync(join(staticDir, 'static'), { recursive: true })
    writeFileSync(join(staticDir, 'static', 'index.html'), '<html><body>PTA UI</body></html>')
    writeFileSync(join(staticDir, 'static', 'app.js'), 'console.log(1)')
    process.chdir(staticDir)
    const appModule = await import('./index')
    server = appModule.server as { listen?: unknown, close?: () => Promise<void> }
  })

  afterAll(() => {
    rmSync(staticDir, { recursive: true, force: true })
    process.chdir(ORIGINAL_CWD)
  })

  it('returns 200 with an ok status for the health check', async () => {
    const res = await request(server).get('/health').expect(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('serves the web UI at / with a 200', async () => {
    const res = await request(server).get('/').expect(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toContain('PTA UI')
  })

  it('serves the app javascript at /app.js with a 200', async () => {
    const res = await request(server).get('/app.js').expect(200)
    expect(res.headers['content-type']).toMatch(/text\/javascript/)
    expect(res.text).toContain('console.log')
  })

  it('returns a not_found error for an unknown path', async () => {
    const res = await request(server).get('/not-a-route').expect(404)
    expect(res.body).toEqual({ status: 'not_found', path: '/not-a-route' })
  })

  it('returns a forbidden error for a path that escapes the static dir', async () => {
    const res = await request(server).get('/%2e%2e%2f%2e%2e%2fetc%2fpasswd').expect(403)
    expect(res.body).toEqual({ status: 'forbidden' })
  })
})
