import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import http from 'http'
import request from 'supertest'
import { PersonToAlbum } from './function'
import { addAssetsToAlbum, getMyUser, removeAssetFromAlbum, searchAssets } from '@immich/sdk'
import { AssetResponseDto, AssetTypeEnum, AssetVisibility, PersonResponseDto, UserAdminResponseDto } from '@immich/sdk'

vi.mock('@immich/sdk', () => ({
  init: vi.fn(),
  addAssetsToAlbum: vi.fn(),
  getMyUser: vi.fn(),
  removeAssetFromAlbum: vi.fn(),
  searchAssets: vi.fn(),
  AssetTypeEnum: { Image: 'IMAGE', Video: 'VIDEO', Audio: 'AUDIO', Other: 'OTHER' },
  AssetVisibility: { Archive: 'archive', Timeline: 'timeline', Hidden: 'hidden', Locked: 'locked' }
}))

const mockedAddAssetsToAlbum = vi.mocked(addAssetsToAlbum)
const mockedGetMyUser = vi.mocked(getMyUser)
const mockedRemoveAssetFromAlbum = vi.mocked(removeAssetFromAlbum)
const mockedSearchAssets = vi.mocked(searchAssets)

const ORIGINAL_CWD = process.cwd()

const ALICE_ID = 'person-alice'
const BOB_ID = 'person-bob'
const CAROL_ID = 'person-carol'

const alice: PersonResponseDto = {
  id: ALICE_ID,
  name: 'Alice',
  isHidden: false,
  birthDate: null,
  color: '#ff0000',
  isFavorite: false,
  otherPeople: [],
  sharedBy: [],
  sharedWith: [],
  thumbnailPath: '',
  updatedAt: '2026-11-26T00:00:00.000Z'
}

const bob: PersonResponseDto = {
  id: BOB_ID,
  name: 'Bob',
  isHidden: false,
  birthDate: null,
  color: '#00ff00',
  isFavorite: false,
  otherPeople: [],
  sharedBy: [],
  sharedWith: [],
  thumbnailPath: '',
  updatedAt: '2026-11-26T00:00:00.000Z'
}

const carol: PersonResponseDto = {
  id: CAROL_ID,
  name: 'Carol',
  isHidden: false,
  birthDate: null,
  color: '#0000ff',
  isFavorite: false,
  otherPeople: [],
  sharedBy: [],
  sharedWith: [],
  thumbnailPath: '',
  updatedAt: '2026-11-26T00:00:00.000Z'
}

const asset = (id: string, people: PersonResponseDto[]): AssetResponseDto => ({
  id,
  ownerId: 'user-1',
  checksum: `checksum-${id}`,
  createdAt: '2026-11-26T00:00:00.000Z',
  duration: null,
  fileCreatedAt: '2026-11-26T00:00:00.000Z',
  fileModifiedAt: '2026-11-26T00:00:00.000Z',
  hasMetadata: true,
  height: 1000,
  isArchived: false,
  isEdited: false,
  isFavorite: false,
  isOffline: false,
  isTrashed: false,
  libraryId: null,
  livePhotoVideoId: null,
  localDateTime: '2026-11-26T00:00:00.000Z',
  originalFileName: `${id}.jpg`,
  originalMimeType: 'image/jpeg',
  originalPath: `/photos/${id}.jpg`,
  people,
  resized: false,
  stack: null,
  tags: [],
  thumbhash: null,
  type: AssetTypeEnum.Image,
  updatedAt: '2026-11-26T00:00:00.000Z',
  visibility: AssetVisibility.Timeline,
  width: 1000
})

const page = (items: AssetResponseDto[]) => ({
  assets: { items, nextCursor: null, nextPage: null, total: items.length, count: items.length, facets: [] },
  albums: { items: [], nextCursor: null, nextPage: null, total: 0, count: 0, facets: [] }
})

describe('HTTP API', () => {
  let server: http.Server
  let staticDir: string

  beforeAll(async () => {
    // The static dir is resolved from the working directory at import time, so point it at a temp dir with a web UI file
    staticDir = mkdtempSync(join(tmpdir(), 'immich-person-to-album-'))
    mkdirSync(join(staticDir, 'static'), { recursive: true })
    writeFileSync(join(staticDir, 'static', 'index.html'), '<html><body>PTA UI</body></html>')
    process.chdir(staticDir)
    const appModule = await import('./index')
    server = appModule.server
  })

  afterAll(() => {
    rmSync(staticDir, { recursive: true, force: true })
    process.chdir(ORIGINAL_CWD)
  })

  describe('GET /health', () => {
    it('returns 200 with an ok status', async () => {
      const res = await request(server).get('/health').expect(200)
      expect(res.body).toEqual({ status: 'ok' })
      expect(res.headers['content-type']).toMatch(/json/)
    })
  })

  describe('static web UI', () => {
    it('serves the web UI at / with a 200', async () => {
      const res = await request(server).get('/').expect(200)
      expect(res.headers['content-type']).toMatch(/text\/html/)
      expect(res.text).toContain('PTA UI')
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

  describe('person matching via the Immich API', () => {
    let pta: PersonToAlbum
    let dir: string
    let exampleConfigFile: string
    let configFile: string

    beforeEach(() => {
      vi.resetAllMocks()
      dir = mkdtempSync(join(tmpdir(), 'immich-person-to-album-'))
      exampleConfigFile = join(dir, 'config.json.example')
      configFile = join(dir, 'config.json')
      writeFileSync(exampleConfigFile, JSON.stringify({ immichServer: 'http://immich.example.com:2283', schedule: '*/30 * * * *', users: [] }))
      pta = new PersonToAlbum(configFile, exampleConfigFile)
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
      delete process.env.CONFIG
    })

    it('adds the assets that match an AND group of people to the album', async () => {
      mockedSearchAssets.mockResolvedValue(page([
        asset('asset-and', [alice, bob]),
        asset('asset-extra', [alice, carol])
      ]))
      mockedAddAssetsToAlbum.mockResolvedValue([])

      await pta.processLink({ albumId: 'album-and', personIds: [ALICE_ID, BOB_ID], logic: 'AND', noOtherPeople: true })

      const call = mockedSearchAssets.mock.calls[0][0] as { metadataSearchDto: { filter: object, withPeople?: boolean } }
      expect(call.metadataSearchDto.filter).toEqual({
        personIds: { all: [ALICE_ID, BOB_ID] },
        albumIds: { none: ['album-and'] }
      })
      expect(call.metadataSearchDto.withPeople).toBe(true)
      expect(mockedAddAssetsToAlbum).toHaveBeenCalledWith({ id: 'album-and', bulkIdsDto: { ids: ['asset-and'] } })
    })
  })
})
