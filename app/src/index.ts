import { PersonToAlbum } from './function'
import { init, getAllAlbums, getAllPeople } from '@immich/sdk'
import { AlbumResponseDto, PersonResponseDto, PeopleResponseDto } from '@immich/sdk'
import cron from 'node-cron'
import http from 'http'
import path from 'path'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { Link, LinkConfig, Logic } from './types'

let pta: PersonToAlbum

const PORT = Number(process.env.PORT) || 3000
const STATIC_DIR = path.resolve(process.cwd(), 'static')
const CONFIG_FILE = path.resolve('../data/config.json')

const MIME_TYPES: { [extension: string]: string } = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
}

function sendJson (res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function serveStatic (res: http.ServerResponse, url: string) {
  const pathname = decodeURIComponent(url.split('?')[0])
  const filePath = path.join(STATIC_DIR, pathname.replace(/^\/+/, ''))
  const allowedRoot = STATIC_DIR + path.sep
  if (filePath !== STATIC_DIR && !filePath.startsWith(allowedRoot)) {
    sendJson(res, 403, { status: 'forbidden' })
    return
  }
  let finalPath = filePath
  if (existsSync(finalPath) && statSync(finalPath).isDirectory()) {
    finalPath = path.join(finalPath, 'index.html')
  }
  if (!existsSync(finalPath) || !statSync(finalPath).isFile()) {
    sendJson(res, 404, { status: 'not_found', path: pathname })
    return
  }
  const content = readFileSync(finalPath)
  const extension = path.extname(finalPath).toLowerCase()
  res.writeHead(200, { 'Content-Type': MIME_TYPES[extension] || 'application/octet-stream' })
  res.end(content)
}

function readBody (req: http.IncomingMessage): Promise<object> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

async function listPeople (): Promise<PersonResponseDto[]> {
  const people: PersonResponseDto[] = []
  for (const user of pta.config.users) {
    init({ baseUrl: pta.config.immichServer + '/api', apiKey: user.apiKey })
    const result: PeopleResponseDto = await getAllPeople({ size: 100 })
    people.push(...(result.people || []))
  }
  return people
}

async function listAlbums (): Promise<AlbumResponseDto[]> {
  const albums: AlbumResponseDto[] = []
  for (const user of pta.config.users) {
    init({ baseUrl: pta.config.immichServer + '/api', apiKey: user.apiKey })
    const result = await getAllAlbums({})
    albums.push(...(result || []))
  }
  return albums
}

function listLinks (): Link[] {
  const links: Link[] = []
  if (!pta.config.users) return links
  for (const user of pta.config.users) {
    for (const link of user.personLinks) {
      try {
        links.push(pta.normaliseLink(link))
      } catch (e) {
        // Skip links that are not valid, they cannot be shown or updated
      }
    }
  }
  return links
}

function writeConfig () {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(pta.config, null, 2))
  } catch (e) {
    console.log(e)
  }
}

async function saveLink (body: { albumId?: string, personIds?: string[], logic?: Logic, description?: string, excludePersonIds?: string[], noOtherPeople?: boolean, removeUnmatched?: boolean }) {
  const link = pta.normaliseLink({
    albumId: body.albumId as string,
    personIds: body.personIds as string[],
    logic: body.logic as Logic,
    description: body.description,
    excludePersonIds: body.excludePersonIds,
    noOtherPeople: body.noOtherPeople,
    removeUnmatched: body.removeUnmatched
  })

  let updated = false
  if (pta.config.users) {
    outerLoop:
    for (const user of pta.config.users) {
      for (const existing of user.personLinks) {
        const existingIds = new Set(existing.personIds ?? (existing.personId ? [existing.personId] : []))
        const matches = link.personIds.every(id => existingIds.has(id))
        if (matches) {
          existing.albumId = link.albumId
          if (link.description !== undefined) existing.description = link.description
          if (link.logic) existing.logic = link.logic
          if (link.excludePersonIds.length) existing.excludePersonIds = link.excludePersonIds
          if (link.noOtherPeople) existing.noOtherPeople = true
          if (link.removeUnmatched) existing.removeUnmatched = true
          updated = true
          break outerLoop
        }
      }
    }
  }

  if (!updated && pta.config.users) {
    const user = pta.config.users.find(u => u.personLinks && u.personLinks.length) ?? pta.config.users[0]
    if (user) {
      user.personLinks.push({
        albumId: link.albumId,
        personIds: link.personIds,
        logic: link.logic,
        description: link.description,
        excludePersonIds: link.excludePersonIds,
        noOtherPeople: link.noOtherPeople,
        removeUnmatched: link.removeUnmatched
      })
    }
  }

  writeConfig()
  return { status: 'ok', link }
}

async function main () {
  // Read the config from the mounted data directory at startup, not at import time
  pta = new PersonToAlbum()
  console.log(new Date().toISOString())

  // Test connection to Immich
  let immichAvailable = false
  const pingUrl = pta.config.immichServer + '/api/server/ping'
  try {
    const response = await fetch(pingUrl)
    const result = await response.json()
    immichAvailable = result.res === 'pong'
  } catch (e) { }
  if (!immichAvailable) {
    console.log('Unable to ping Immich API on ' + pingUrl)
    console.log('Make sure that URL is accessible to this container.')
    console.log('You can test this by running:')
    console.log(`docker exec immich-person-to-album sh -c "wget -qO- ${pingUrl}"`)
    console.log('The result should be `{"res":"pong"}`.')
    return
  }

  for (const user of pta.config.users) {
    // Init Immich SDK with the specified API key
    init({ baseUrl: pta.config.immichServer + '/api', apiKey: user.apiKey })

    // Process each of the person-album linkages
    for (const link of user.personLinks) {
      try {
        await pta.processLink(link)
      } catch (e) {
        console.log(e)
      }
    }

    // Remove the assets that no longer match, for the links that ask for it
    try {
      await pta.removeUnmatched(user.personLinks)
    } catch (e) {
      console.log(e)
    }
  }
  console.log('Waiting for next scheduled task...')
}

// Send the correct process error code for any uncaught exceptions
// so that Docker can gracefully restart the container
process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  process.exit(1)
})
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Gracefully shutting down...')
  process.exit(0)
})

// Start the HTTP listener that serves the web UI and the health check, in this same process
export const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (req.method === 'GET' && url === '/api/people') {
    try {
      const people = await listPeople()
      sendJson(res, 200, { people })
    } catch (e) {
      sendJson(res, 502, { status: 'error', error: String(e) })
    }
    return
  }
  if (req.method === 'GET' && url === '/api/albums') {
    try {
      const albums = await listAlbums()
      sendJson(res, 200, { albums })
    } catch (e) {
      sendJson(res, 502, { status: 'error', error: String(e) })
    }
    return
  }
  if (req.method === 'GET' && url === '/api/links') {
    try {
      sendJson(res, 200, { links: listLinks() })
    } catch (e) {
      sendJson(res, 502, { status: 'error', error: String(e) })
    }
    return
  }
  if (req.method === 'PUT' && url === '/api/links') {
    try {
      const body = await readBody(req)
      const result = await saveLink(body)
      sendJson(res, 200, result)
    } catch (e) {
      sendJson(res, 400, { status: 'error', error: String(e) })
    }
    return
  }
  serveStatic(res, url)
})

// Start the listener and run the sync loop when this module starts the app itself,
// but not when it is imported by the tests
if (process.env.VITEST === undefined) {
  server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`)
  })

  // Run on startup

  main()
    .then(() => {
      // Then afterwards run on a schedule
      cron.schedule(pta.config.schedule || '0,30 * * * *', main)
    })
}
