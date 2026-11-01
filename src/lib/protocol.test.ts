import { afterEach, describe, expect, it, vi } from 'vitest'
import { displayName, generateCode, inviteUrl, MAX_MESSAGE_LENGTH, parseRoomCode, validText } from './protocol'

afterEach(() => vi.unstubAllGlobals())

describe('room input boundaries', () => {
  it('accepts codes, pasted invites and query links, but rejects unrelated URLs', () => {
    expect(parseRoomCode(' ab23cd ')).toBe('AB23CD')
    expect(parseRoomCode('https://chat.zices.com/HLMV2K')).toBe('HLMV2K')
    expect(parseRoomCode('https://chat.zices.com/hlmv2k/')).toBe('HLMV2K')
    expect(parseRoomCode('https://chat.zices.com/AB23CD?ref=invite')).toBe('AB23CD')
    expect(parseRoomCode('https://example.com/#room=AB23CD')).toBe('AB23CD')
    expect(parseRoomCode('https://example.com/?room=ab23cd')).toBe('AB23CD')
    expect(parseRoomCode('https://example.com/')).toBeNull()
    expect(parseRoomCode('javascript://example.com/#room=AB23CD')).toBeNull()
    expect(parseRoomCode('ABCDEF7')).toBeNull()
    expect(parseRoomCode('AB CD1')).toBeNull()
    expect(parseRoomCode('https://chat.zices.com/AB23CD7')).toBeNull()
    expect(parseRoomCode('https://chat.zices.com/assets/file.js')).toBeNull()
  })
  it('copies an absolute path invite with no hash or query', () => {
    vi.stubGlobal('window', { location: { href: 'https://chat.zices.com/?ref=old#room=OLD123' } })
    expect(inviteUrl('HLMV2K')).toBe('https://chat.zices.com/HLMV2K')
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:5173/ABC234' } })
    expect(inviteUrl('HLMV2K')).toBe('http://127.0.0.1:5173/HLMV2K')
  })
  it('generates six-character room codes and anonymous four-digit names', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
      expect(displayName('')).toMatch(/^User\d{4}$/)
    }
    expect(displayName('  Alex  ')).toBe('Alex')
    expect(displayName('\u202eAlice')).toBe('Alice')
    expect(displayName('x'.repeat(50))).toHaveLength(32)
  })
  it('enforces the message limit on the receiving side as well as the composer', () => {
    expect(validText('a'.repeat(MAX_MESSAGE_LENGTH))).toBe(true)
    expect(validText('a'.repeat(MAX_MESSAGE_LENGTH + 1))).toBe(false)
    expect(validText('   ')).toBe(false)
    expect(validText({ text: 'spoof' })).toBe(false)
  })
})
