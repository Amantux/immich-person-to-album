import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PersonToAlbum } from './function'

describe('PersonToAlbum config', () => {
  let dir: string
  let exampleConfigFile: string
  let configFile: string
  const exampleConfig = {
    immichServer: 'http://immich.example.com:2283',
    schedule: '*/30 * * * *',
    users: []
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'immich-person-to-album-'))
    exampleConfigFile = join(dir, 'config.json.example')
    configFile = join(dir, 'config.json')
    writeFileSync(exampleConfigFile, JSON.stringify(exampleConfig, null, 2))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.CONFIG
  })

  it('creates the config file from the example and reads it when absent', () => {
    expect(existsSync(configFile)).toBe(false)
    const pta = new PersonToAlbum(configFile, exampleConfigFile)
    expect(existsSync(configFile)).toBe(true)
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual(exampleConfig)
    expect(pta.config).toEqual(exampleConfig)
  })

  it('reads the config file when present', () => {
    const config = { immichServer: 'http://from-file:2283', schedule: '0 * * * *', users: [] }
    writeFileSync(configFile, JSON.stringify(config, null, 2))
    const pta = new PersonToAlbum(configFile, exampleConfigFile)
    expect(pta.config).toEqual(config)
  })

  it('ignores the config file when the CONFIG env var is set', () => {
    process.env.CONFIG = JSON.stringify({ immichServer: 'http://from-env:2283', schedule: '0 * * * *', users: [] })
    const pta = new PersonToAlbum(configFile, exampleConfigFile)
    expect(pta.config).toEqual({ immichServer: 'http://from-env:2283', schedule: '0 * * * *', users: [] })
    expect(existsSync(configFile)).toBe(false)
  })
})
