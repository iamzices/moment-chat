
export const PEER_PREFIX = 'moment-chat-'
export const RECONNECT_MS = 120_000
export const MAX_PARTICIPANTS = 8
export const MAX_MESSAGE_LENGTH = 4_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export type Outcome = 'declined' | 'locked' | 'full' | 'ended' | 'removed' | 'unavailable' | 'connection' | 'expired' | 'left'
export interface Participant { id: string; name: string; host: boolean; away: boolean }
export interface ChatMessage { id: string; clientId?: string; senderId: string; name: string; text: string; time: number; system?: boolean; pending?: boolean }
interface JoinRequest { id: string; name: string }
interface Settings { autoApprove: boolean; locked: boolean }
export interface RoomState {
  screen: 'landing' | 'join' | 'waiting' | 'room' | 'outcome'
  code: string; selfId: string; isHost: boolean; name: string
  status: 'connecting' | 'online' | 'reconnecting'
  participants: Participant[]; requests: JoinRequest[]; messages: ChatMessage[]
  settings: Settings; outcome?: Outcome; error: string; reconnectUntil?: number
}
export function parseRoomCode(input: string): string | null {
  let candidate = input.trim()
  if (candidate.includes('://')) {
    try {
      const url = new URL(candidate)
      if (!['http:', 'https:'].includes(url.protocol)) return null
      candidate = /^\/([A-Z0-9]{6})\/?$/i.exec(url.pathname)?.[1]
        ?? new URLSearchParams(url.hash.replace(/^#/, '')).get('room')
        ?? url.searchParams.get('room') ?? ''
    } catch { return null }
  }
  candidate = candidate.toUpperCase()
  return /^[A-Z0-9]{6}$/.test(candidate) ? candidate : null
}
export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
}
export function displayName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 32)
  return clean || `User${String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0')}`
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_MESSAGE_LENGTH
}
export function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 80 }
export function inviteUrl(code: string): string {
  const url = new URL(window.location.href)
  url.pathname = `/${code}`; url.search = ''; url.hash = ''
  return url.href
}
