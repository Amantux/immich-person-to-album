import { PersonToAlbum } from './function'
import { init } from '@immich/sdk'
import cron from 'node-cron'
import http from 'http'
import path from 'path'
import { existsSync, readFileSync, statSync } from 'fs'

let pta: PersonToAlbum

const PORT = Number(process.env.PORT) || 3000
const STATIC_DIR = path.resolve(process.cwd(), 'static')

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
    console.log('The result should be `{"res":"pong"}`')
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
export const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
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
