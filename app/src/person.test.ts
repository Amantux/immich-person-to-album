import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addAssetsToAlbum, getMyUser, removeAssetFromAlbum, searchAssets } from '@immich/sdk'
import { PersonToAlbum } from './function'
import { Link, LinkConfig } from './types'
import { AssetResponseDto, AssetTypeEnum, AssetVisibility, PersonResponseDto, UserAdminResponseDto } from '@immich/sdk'

vi.mock('@immich/sdk', () => ({
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

const ALICE_ID = 'person-alice'
const BOB_ID = 'person-bob'
const CAROL_ID = 'person-carol'
const EXCLUDED_ID = 'person-dave'

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

const excluded: PersonResponseDto = {
  id: EXCLUDED_ID,
  name: 'Dave',
  isHidden: false,
  birthDate: null,
  color: '#ffff00',
  isFavorite: false,
  otherPeople: [],
  sharedBy: [],
  sharedWith: [],
  thumbnailPath: '',
  updatedAt: '2026-11-26T00:00:00.000Z'
}

const asset = (id: string, people: PersonResponseDto[], ownerId = 'user-1'): AssetResponseDto => ({
  id,
  ownerId,
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

describe('PersonToAlbum person matching', () => {
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

  describe('AND group of people', () => {
    it('searches for assets that contain all the people of the group', async () => {
      mockedSearchAssets.mockResolvedValue(page([]))
      mockedAddAssetsToAlbum.mockResolvedValue([])

      await pta.processLink({ albumId: 'album-and', personIds: [ALICE_ID, BOB_ID], logic: 'AND' })

      expect(mockedSearchAssets).toHaveBeenCalledTimes(1)
      const call = mockedSearchAssets.mock.calls[0][0] as { metadataSearchDto: { filter: object } }
      expect(call.metadataSearchDto.filter).toEqual({
        personIds: { all: [ALICE_ID, BOB_ID] },
        albumIds: { none: ['album-and'] }
      })
    })

    it('rejects the assets of an AND group that are missing any one of its people', () => {
      const link: Link = pta.normaliseLink({ albumId: 'album-and', personIds: [ALICE_ID, BOB_ID], logic: 'AND' })

      expect(pta.unmatchedBranches(link)).toEqual([
        { personIds: { none: [ALICE_ID] } },
        { personIds: { none: [BOB_ID] } }
      ])
    })
  })

  describe('OR group of people', () => {
    it('searches for assets that contain any one of the people of the group', async () => {
      mockedSearchAssets.mockResolvedValue(page([]))
      mockedAddAssetsToAlbum.mockResolvedValue([])

      await pta.processLink({ albumId: 'album-or', personIds: [ALICE_ID, BOB_ID, CAROL_ID], logic: 'OR' })

      expect(mockedSearchAssets).toHaveBeenCalledTimes(1)
      const call = mockedSearchAssets.mock.calls[0][0] as { metadataSearchDto: { filter: object } }
      expect(call.metadataSearchDto.filter).toEqual({
        personIds: { any: [ALICE_ID, BOB_ID, CAROL_ID] },
        albumIds: { none: ['album-or'] }
      })
    })

    it('rejects the assets of an OR group that contain none of its people', () => {
      const link: Link = pta.normaliseLink({ albumId: 'album-or', personIds: [ALICE_ID, BOB_ID], logic: 'OR' })

      expect(pta.unmatchedBranches(link)).toEqual([
        { personIds: { none: [ALICE_ID, BOB_ID] } }
      ])
    })
  })

  describe('excludePersonIds', () => {
    it('excludes the excluded people from the search of an AND group', async () => {
      mockedSearchAssets.mockResolvedValue(page([]))
      mockedAddAssetsToAlbum.mockResolvedValue([])

      await pta.processLink({ albumId: 'album-ex', personIds: [ALICE_ID, BOB_ID], logic: 'AND', excludePersonIds: [EXCLUDED_ID] })

      const call = mockedSearchAssets.mock.calls[0][0] as { metadataSearchDto: { filter: object } }
      expect(call.metadataSearchDto.filter).toEqual({
        personIds: { all: [ALICE_ID, BOB_ID], none: [EXCLUDED_ID] },
        albumIds: { none: ['album-ex'] }
      })
    })

    it('adds a search branch that rejects assets with an excluded person', () => {
      const link: Link = pta.normaliseLink({ albumId: 'album-ex', personIds: [ALICE_ID, BOB_ID], logic: 'AND', excludePersonIds: [EXCLUDED_ID] })

      expect(pta.unmatchedBranches(link)).toEqual([
        { personIds: { none: [ALICE_ID] } },
        { personIds: { none: [BOB_ID] } },
        { personIds: { any: [EXCLUDED_ID] } }
      ])
    })
  })

  describe('noOtherPeople', () => {
    it('asks Immich for the people of the assets, so that extra people can be checked', async () => {
      mockedSearchAssets.mockResolvedValue(page([]))
      mockedAddAssetsToAlbum.mockResolvedValue([])

      await pta.processLink({ albumId: 'album-nop', personIds: [ALICE_ID, BOB_ID], logic: 'AND', noOtherPeople: true })

      const call = mockedSearchAssets.mock.calls[0][0] as { metadataSearchDto: { filter: object, withPeople?: boolean } }
      expect(call.metadataSearchDto.withPeople).toBe(true)
    })

    it('adds the assets that contain nobody outside the person group', async () => {
      mockedSearchAssets.mockResolvedValue(page([
        asset('asset-and', [alice, bob]),
        asset('asset-extra', [alice, carol])
      ]))
      mockedAddAssetsToAlbum.mockResolvedValue([])

      await pta.processLink({ albumId: 'album-nop', personIds: [ALICE_ID, BOB_ID], logic: 'AND', noOtherPeople: true })

      expect(mockedAddAssetsToAlbum).toHaveBeenCalledWith({ id: 'album-nop', bulkIdsDto: { ids: ['asset-and'] } })
    })

    it('does not remove the assets that fail only the noOtherPeople check', () => {
      const link: Link = pta.normaliseLink({ albumId: 'album-nop', personIds: [ALICE_ID, BOB_ID], logic: 'AND', noOtherPeople: true, removeUnmatched: true })

      // The noOtherPeople check has no search branch, so it never rejects an asset here
      expect(pta.unmatchedBranches(link)).toEqual([
        { personIds: { none: [ALICE_ID] } },
        { personIds: { none: [BOB_ID] } }
      ])
    })
  })

  describe('removeUnmatched', () => {
    it('removes the assets of the album that do not match the person link', async () => {
      mockedGetMyUser.mockResolvedValue({ id: 'user-1' } as UserAdminResponseDto)
      mockedSearchAssets
        .mockResolvedValueOnce(page([asset('asset-1', [alice])])) // Alice has a photo
        .mockResolvedValueOnce(page([asset('asset-2', [bob])])) // Bob has a photo
        .mockResolvedValueOnce(page([asset('asset-2', [bob])])) // The album holds the photo of Bob only
      mockedRemoveAssetFromAlbum.mockResolvedValue([])

      await pta.removeUnmatched([
        { albumId: 'album-remove', personIds: [ALICE_ID, BOB_ID], logic: 'AND', removeUnmatched: true }
      ])

      expect(mockedRemoveAssetFromAlbum).toHaveBeenCalledWith({ id: 'album-remove', bulkIdsDto: { ids: ['asset-2'] } })
    })

    it('removes nothing when a linked person has no assets', async () => {
      mockedGetMyUser.mockResolvedValue({ id: 'user-1' } as UserAdminResponseDto)
      mockedSearchAssets.mockResolvedValueOnce(page([])) // Alice has no assets

      await pta.removeUnmatched([
        { albumId: 'album-remove', personIds: [ALICE_ID], logic: 'OR', removeUnmatched: true }
      ])

      expect(mockedRemoveAssetFromAlbum).not.toHaveBeenCalled()
    })

    it('removes an asset only when none of the album links accept it', async () => {
      mockedGetMyUser.mockResolvedValue({ id: 'user-1' } as UserAdminResponseDto)
      mockedSearchAssets
        .mockResolvedValueOnce(page([asset('asset-1', [alice])])) // Alice has a photo
        .mockResolvedValueOnce(page([asset('asset-2', [bob])])) // Bob has a photo
        .mockResolvedValueOnce(page([asset('asset-3', [carol])])) // Carol has a photo
        .mockResolvedValueOnce(page([asset('asset-3', [carol])])) // Album: asset-3 fails the AND link of Alice and Bob
        .mockResolvedValueOnce(page([])) // Album: asset-3 satisfies the OR link of Carol, so it is kept
      mockedRemoveAssetFromAlbum.mockResolvedValue([])

      await pta.removeUnmatched([
        { albumId: 'album-remove', personIds: [ALICE_ID, BOB_ID], logic: 'AND', removeUnmatched: true },
        { albumId: 'album-remove', personIds: [CAROL_ID], logic: 'OR', removeUnmatched: true }
      ])

      expect(mockedRemoveAssetFromAlbum).not.toHaveBeenCalled()
    })
  })
})
