import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadEnvFiles } from '../src/main/envFiles'

const KEYS = ['ENVTEST_KEY', 'ENVTEST_TUNING', 'ENVTEST_ONLY_BUNDLED']

describe('loadEnvFiles (user .env layered over bundled defaults)', () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k]
  })

  it('takes each key from the first file that defines it and fills the rest from later files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envfiles-'))
    const user = join(dir, 'user.env')
    const bundled = join(dir, 'bundled.env')
    writeFileSync(user, 'ENVTEST_KEY=user-key\nENVTEST_TUNING=user-value\n')
    writeFileSync(bundled, 'ENVTEST_TUNING=bundled-value\nENVTEST_ONLY_BUNDLED=from-bundle\n')

    const loaded = loadEnvFiles([join(dir, 'missing.env'), user, bundled])

    expect(loaded).toEqual([user, bundled])
    expect(process.env.ENVTEST_KEY).toBe('user-key')
    expect(process.env.ENVTEST_TUNING).toBe('user-value')
    // Previously the bundled file was ignored entirely once a user file existed.
    expect(process.env.ENVTEST_ONLY_BUNDLED).toBe('from-bundle')
  })

  it('returns nothing when no file exists', () => {
    expect(loadEnvFiles([join(tmpdir(), 'definitely-missing-envfile.env')])).toEqual([])
  })
})
