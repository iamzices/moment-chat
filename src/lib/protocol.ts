
/** Prefix every PeerJS ID so Moment rooms never collide with other apps on the broker. */
export const PEER_PREFIX = 'moment-chat-'
/** Hold a dropped participant's seat and undelivered messages for this many milliseconds. */
export const RECONNECT_MS = 120_000
/** Cap the people in a room, host included. */
export const MAX_PARTICIPANTS = 8
/** Cap the length of a message's text, in UTF-16 code units. */
export const MAX_MESSAGE_LENGTH = 4_000
/** Cap the number of files attached to one message. */
export const MAX_FILES = 10
/** Cap the size of each attached file, in bytes. */
export const MAX_FILE_SIZE = 100 * 1024 * 1024
/** Set the raw bytes per file chunk, keeping base64 chunks under PeerJS's 16,300-byte JSON message limit. */
export const FILE_CHUNK = 10 * 1024
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Describe why a session ended, as shown on the outcome screen. */
export type Outcome = 'declined' | 'locked' | 'full' | 'ended' | 'removed' | 'unavailable' | 'connection' | 'expired' | 'left'
/** Represent one person in the room's roster. */
export interface Participant { id: string; name: string; host: boolean; away: boolean }
/** Describe a file as announced on the wire, before any bytes arrive. */
export interface FileMeta { name: string; mime: string; size: number }
/** Track an attached file: bytes transferred, the assembled blob once complete, and whether it failed. */
export interface FileItem extends FileMeta { progress: number; blob?: Blob; failed?: boolean }
/** Represent a chat or system message; `clientId` links a sender's pending copy to the host's echo. */
export interface ChatMessage { id: string; clientId?: string; senderId: string; name: string; text: string; time: number; system?: boolean; pending?: boolean; files?: FileItem[] }
interface JoinRequest { id: string; name: string }
interface Settings { autoApprove: boolean; locked: boolean }
/** Hold everything the UI renders, published by `RoomEngine` as an immutable snapshot. */
export interface RoomState {
  screen: 'landing' | 'join' | 'waiting' | 'room' | 'outcome'
  code: string; selfId: string; isHost: boolean; name: string
  status: 'connecting' | 'online' | 'reconnecting'
  participants: Participant[]; requests: JoinRequest[]; messages: ChatMessage[]
  settings: Settings; outcome?: Outcome; error: string; reconnectUntil?: number
}
/**
 * Extract a room code from a typed code or a pasted invite link.
 * @param input - A 6-character code, or an http(s) URL carrying the code in its path, `#room=` or `?room=`.
 * @returns The uppercase code, or null if none is found.
 */
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
/**
 * Generate a random room code without look-alike characters (0/O, 1/I).
 * @returns A 6-character uppercase code.
 */
export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
}
// Strip control and bidi characters, which can disguise "gpj.exe" as "exe.jpg".
const unsafe = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g
/**
 * Clean a display name, falling back to a random anonymous one.
 * @param name - The untrusted name as typed or received.
 * @returns The name without control or bidi characters, capped at 32 characters, or `UserNNNN` if empty.
 */
export function displayName(name: string): string {
  const clean = name.replace(unsafe, '').trim().slice(0, 32)
  return clean || `User${String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0')}`
}
/**
 * Check that an untrusted value is a plain object.
 * @param value - Any inbound value.
 * @returns True for non-null, non-array objects.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/**
 * Check that an untrusted value is sendable message text.
 * @param value - Any inbound value.
 * @returns True for a non-blank string within `MAX_MESSAGE_LENGTH`.
 */
export function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_MESSAGE_LENGTH
}
/**
 * Check that an untrusted value is a well-formed, in-limit list of file metadata.
 * @param value - Any inbound value.
 * @returns True for 1 to `MAX_FILES` entries with valid names, MIME types, and sizes from 1 byte to `MAX_FILE_SIZE`.
 */
export function validFiles(value: unknown): value is FileMeta[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_FILES && value.every(file => isRecord(file)
    && typeof file.name === 'string' && file.name.length > 0 && file.name.length <= 255 && typeof file.mime === 'string' && file.mime.length <= 100
    && Number.isSafeInteger(file.size) && (file.size as number) >= 1 && (file.size as number) <= MAX_FILE_SIZE)
}
/**
 * Clean an untrusted file name for display and download.
 * @param name - The file name as received.
 * @returns The name without control or bidi characters or path separators, capped at 200 characters, or `file` if empty.
 */
export const fileName = (name: string) => name.replace(unsafe, '').replace(/[/\\]/g, '_').trim().slice(0, 200) || 'file'
/**
 * Classify a MIME type for inline preview, allowing only types that can't run script in this origin.
 * @param mime - The file's declared MIME type.
 * @returns The preview kind, or null if the file should only be offered as a download.
 */
export const previewKind = (mime: string) => /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm|mp4|aac))$/.test(mime) ? mime.split('/')[0] as 'image' | 'video' | 'audio' : null
/**
 * Pick the MIME type to store a received file under.
 * @param mime - The file's declared MIME type.
 * @returns The type itself if it is previewable, otherwise `application/octet-stream`.
 */
export const safeMime = (mime: string) => previewKind(mime) ? mime : 'application/octet-stream'
/**
 * Check that an untrusted value is a usable ID.
 * @param value - Any inbound value.
 * @returns True for a non-empty string of at most 80 characters.
 */
export function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 80 }
/**
 * Build the shareable invite link for a room on the current origin.
 * @param code - The room code.
 * @returns An absolute URL of the form `<origin>/<code>`, with no query or hash.
 */
export function inviteUrl(code: string): string {
  const url = new URL(window.location.href)
  url.pathname = `/${code}`; url.search = ''; url.hash = ''
  return url.href
}
