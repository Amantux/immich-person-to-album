import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PersonToAlbum } from './function'
import { LinkConfig } from './types'

describe('PersonToAlbum config validation', () => {
  let pta: PersonToAlbum
  let dir: string
  let exampleConfigFile: string
  let configFile: string

  beforeEach(() => {
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

  describe('valid config', () => {
    it('accepts a valid link and applies the defaults', () => {
      const link = pta.normaliseLink({
        description: 'Joe and Anna together',
        albumId: 'album-id',
        personIds: ['person-1', 'person-2'],
        logic: 'AND',
        noOtherPeople: true
      })
      expect(link).toEqual({
        description: 'Joe and Anna together',
        albumId: 'album-id',
        personIds: ['person-1', 'person-2'],
        logic: 'AND',
        excludePersonIds: [],
        noOtherPeople: true,
        removeUnmatched: false
      })
    })

    it('accepts a single person link and defaults the logic to OR', () => {
      const link = pta.normaliseLink({ albumId: 'album-id', personId: 'person-1' })
      expect(link.personIds).toEqual(['person-1'])
      expect(link.logic).toBe('OR')
      expect(link.excludePersonIds).toEqual([])
      expect(link.noOtherPeople).toBe(false)
      expect(link.removeUnmatched).toBe(false)
    })
  })

  describe('missing required fields', () => {
    it('fails with a readable error naming the missing albumId', () => {
      expect(() => pta.normaliseLink({ personIds: ['person-1'] } as unknown as LinkConfig)).toThrow(/albumId is missing/)
    })

    it('fails with a readable error naming the missing personIds', () => {
      expect(() => pta.normaliseLink({ albumId: 'album-id' })).toThrow(/personIds is empty/)
    })
  })

  describe('invalid values', () => {
    it('fails when the logic is not AND or OR', () => {
      const invalidLogic = { albumId: 'album-id', personIds: ['person-1', 'person-2'], logic: 'XOR' } as unknown as LinkConfig
      expect(() => pta.normaliseLink(invalidLogic)).toThrow(/logic/)
    })

    it('fails when the logic is not a string', () => {
      const invalidLogicType = { albumId: 'album-id', personIds: ['person-1', 'person-2'], logic: 123 } as unknown as LinkConfig
      expect(() => pta.normaliseLink(invalidLogicType)).toThrow(/logic/)
    })

    it('fails when a person is both included and excluded', () => {
      expect(() => pta.normaliseLink({ albumId: 'album-id', personIds: ['person-1'], excludePersonIds: ['person-1'] })).toThrow(/person-1 is in personIds/)
    })
  })

  describe('unknown fields', () => {
    it('allows fields that are not part of the link schema', () => {
      const config = { albumId: 'album-id', personIds: ['person-1'] } as LinkConfig
      const withUnknownField = { ...config, someField: 'not in the schema' } as unknown as LinkConfig
      expect(() => pta.normaliseLink(withUnknownField)).not.toThrow()
    })
  })
})
