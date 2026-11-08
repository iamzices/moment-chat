import Peer, { type BufferedConnection, type DataConnection } from 'peerjs'
import { PEER_PREFIX, RECONNECT_MS, MAX_PARTICIPANTS, FILE_CHUNK, displayName, fileName, generateCode, isRecord, safeMime, validFiles, validText, validId, type RoomState, type Participant, type ChatMessage, type FileItem, type FileMeta, type Outcome } from './protocol'

type Wire = Record<string, unknown>
interface Transfer { id: string; meta: FileMeta[]; f: number; i: number; received: number; pct: number; parts: Uint8Array<ArrayBuffer>[]; blobs: Blob[] }
interface Member {
  participant: Participant; sessionId: string; token: string; connection?: DataConnection
  awayAt?: number; deliveries: Map<string, ChatMessage>; seen: Map<string, ChatMessage>; lastSeen: number
  rate: number[]; upload?: Transfer & { clientId: string }
}
const transfer = (id: string, meta: FileMeta[]): Transfer => ({ id, meta, f: 0, i: 0, received: 0, pct: -1, parts: [], blobs: [] })
const items = (meta: FileMeta[]): FileItem[] => meta.map(({ name, mime, size }) => ({ name: fileName(name), mime, size, progress: 0 }))
function toBase64(bytes: Uint8Array) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}
const MAX_CHUNK_TEXT = Math.ceil(FILE_CHUNK / 3) * 4
interface Pending { connection: DataConnection; name: string; sessionId: string; at: number }
const hostState = (name: string) => { const selfId = crypto.randomUUID(); return { screen: 'room', isHost: true, selfId, name, participants: [{ id: selfId, name, host: true, away: false }] } satisfies Partial<RoomState> }
const initialState = (): RoomState =>({ screen: 'landing', code: '', selfId: '', isHost: false, name: '', status: 'connecting', participants: [], requests: [], messages: [], settings: { autoApprove: true, locked: false }, error: '' })

/**
 * Run one tab's side of a room: hosting or joining, the roster, messages and file transfers.
 *
 * Guests connect only to the host, which relays everything (star topology). All state, resume
 * secrets and buffers live only in this tab's memory. Read it with `subscribe` and `getSnapshot`.
 */
export class RoomEngine {
  private state = initialState()
  private listeners = new Set<() => void>()
  private peer?: Peer
  private hostConnection?: DataConnection
  private members = new Map<string, Member>()
  private pending = new Map<string, Pending>()
  private connections = new Set<DataConnection>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private ticker?: ReturnType<typeof setInterval>
  private sessionId = crypto.randomUUID()
  private resumeToken?: string
  private accepted = false
  private stopped = false
  private lastHostSeen = 0
  private attemptAt = 0
  private startAt = 0
  private outgoing = new Map<string, string>()
  private received = new Set<string>()
  private hostRetries = 0
  private transfers = new Map<string, Transfer>()
  private files = new Map<string, Blob[]>()
  private uploads = Promise.resolve()
  /**
   * Register a listener for state changes, in the shape `useSyncExternalStore` expects.
   * @param listener - Called after every state change.
   * @returns A function that removes the listener.
   */
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /**
   * Read the current state snapshot, which is replaced (never mutated) on every change.
   * @returns The current `RoomState`.
   */
  getSnapshot = () => this.state
  private set(patch: Partial<RoomState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()) }
  private later(fn: () => void, delay: number) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn() }, delay)
    this.timers.add(timer)
  }
  private send(connection: DataConnection | undefined, payload: Wire): boolean {
    if (!connection?.open) return false
    try { connection.send({ v: 1, ...payload }); return true } catch { return false }
  }
  private createPeer(id: string) {
    // Use STUN only; a TURN server could relay chat payloads.
    const peer = new Peer(id, { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } })
    peer.on('disconnected', () => {
      if (this.stopped || this.peer !== peer) return
      if (this.state.isHost) this.set({ status: 'reconnecting' })
      this.later(() => { if (!peer.destroyed && peer.disconnected) { try { peer.reconnect() } catch { /* Retry on the next tick. */ } } }, 1500)
    })
    peer.on('error', error => {
      if (this.stopped || this.peer !== peer) return
      // Lose the claim on a joined code: someone already hosts it, so join them.
      if (error.type === 'unavailable-id' && !this.state.isHost) { this.joinAsGuest(); return }
      if (error.type === 'unavailable-id' && this.hostRetries++ < 4) {
        peer.destroy(); this.openHost(); return
      }
      if (['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable', 'unavailable-id'].includes(error.type)) { this.finish('connection'); return }
      if (!this.state.isHost && !this.accepted && error.type === 'peer-unavailable') { this.finish('unavailable'); return }
      if (this.state.isHost && this.state.status !== 'online') this.set({ error: 'Connecting to the room…' })
    })
    this.peer = peer
    return peer
  }
  /**
   * Show the join screen for a room and put its code in the address bar.
   * @param code - The room code to join.
   */
  showJoin(code: string) { this.set({ screen: 'join', code, error: '' }); history.replaceState(null, '', `/?room=${code}`) }
  /** Leave any room or request and return to the landing screen. */
  home() { this.cleanup(); this.stopped = false; this.sessionId = crypto.randomUUID(); this.set(initialState()); history.replaceState(null, '', '/') }
  /** Create a room with a fresh code and become its host. */
  createRoom() {
    this.cleanup(); this.stopped = false; this.hostRetries = 0; this.startAt = Date.now()
    this.set({ ...initialState(), ...hostState(displayName('')) })
    this.openHost(); this.startTicker()
  }
  private openHost(code = generateCode()) {
    this.set({ code, status: 'connecting' })
    history.replaceState(null, '', `/?room=${code}`)
    const peer = this.createPeer(`${PEER_PREFIX}${code}`)
    peer.on('open', () => { if (!this.stopped && this.peer === peer) this.set({ ...(!this.state.isHost && hostState(this.state.name)), status: 'online', error: '' }) })
    peer.on('connection', connection => this.handleIncoming(connection))
  }
  /**
   * Join the room for the current code, or host it if nobody does yet.
   *
   * The tab first claims the code's peer ID; the signalling server grants each ID once, so
   * simultaneous joiners end up with exactly one host and the rest join it as guests.
   * @param name - The display name to use; it is cleaned before use.
   */
  requestJoin(name: string) {
    const code = this.state.code
    this.cleanup(); this.stopped = false; this.startAt = Date.now(); this.lastHostSeen = Date.now()
    this.sessionId = crypto.randomUUID()
    this.set({ ...initialState(), screen: 'waiting', code, name: displayName(name) })
    this.openHost(code); this.startTicker()
  }
  private joinAsGuest() {
    this.peer?.destroy()
    const peer = this.createPeer(`${PEER_PREFIX}guest-${crypto.randomUUID()}`)
    peer.on('open', () => this.connectHost())
    peer.on('connection', connection => connection.close())
  }
  private connectHost() {
    if (this.stopped || !this.peer?.open || this.hostConnection?.open) return
    this.attemptAt = Date.now()
    this.hostConnection?.close()
    const connection = this.peer.connect(`${PEER_PREFIX}${this.state.code}`, { reliable: true, serialization: 'json' })
    this.hostConnection = connection
    this.connections.add(connection)
    connection.on('open', () => {
      if (this.stopped || connection !== this.hostConnection) return
      this.lastHostSeen = Date.now()
      this.send(connection, { type: 'request', sessionId: this.sessionId, name: this.state.name, token: this.resumeToken })
    })
    connection.on('data', raw => { if (connection === this.hostConnection) this.handleHostData(raw) })
    connection.on('close', () => {
      this.connections.delete(connection)
      if (this.stopped || connection !== this.hostConnection) return
      this.hostConnection = undefined
      if (this.accepted) this.markReconnecting()
    })
    connection.on('error', () => { connection.close(); if (this.accepted && !this.stopped) this.markReconnecting() })
  }
  private markReconnecting() {
    if (!this.state.reconnectUntil) this.set({ status: 'reconnecting', reconnectUntil: this.lastHostSeen + RECONNECT_MS })
  }
  private handleIncoming(connection: DataConnection) {
    if (this.stopped || this.connections.size >= 48) { connection.close(); return }
    this.connections.add(connection)
    let requested = false
    this.later(() => { if (!requested) connection.close() }, 10_000)
    connection.on('data', raw => {
      if (this.stopped || !isRecord(raw) || raw.v !== 1) return
      if (raw.type === 'request' && !requested) {
        requested = true
        this.handleRequest(connection, raw)
        return
      }
      const member = [...this.members.values()].find(item => item.connection === connection)
      if (member) { member.lastSeen = Date.now(); this.handleMemberData(member, raw); return }
      if (raw.type === 'ping') this.send(connection, { type: 'pong' })
      if (raw.type === 'cancel') { this.pending.delete(connection.peer); this.updateRequests(); connection.close() }
    })
    connection.on('close', () => {
      this.connections.delete(connection)
      this.pending.delete(connection.peer); this.updateRequests()
      const member = [...this.members.values()].find(item => item.connection === connection)
      if (member && !this.stopped) this.markAway(member)
    })
    connection.on('error', () => connection.close())
  }
  private handleRequest(connection: DataConnection, data: Wire) {
    if (!validId(data.sessionId) || typeof data.name !== 'string') { connection.close(); return }
    const existing = [...this.members.values()].find(item => item.sessionId === data.sessionId)
    if (existing && typeof data.token === 'string' && data.token === existing.token && (!existing.awayAt || Date.now() - existing.awayAt < RECONNECT_MS)) {
      const old = existing.connection
      existing.connection = connection; existing.awayAt = undefined; existing.lastSeen = Date.now(); existing.participant.away = false
      old?.close()
      this.sendAccepted(existing)
      for (const event of existing.deliveries.values()) {
        this.send(connection, { type: 'event', event })
        // Resend bytes for unacked file events, or abort if the upload is still running.
        const blobs = event.files && this.files.get(event.id)
        if (blobs) this.uploads = this.uploads.then(() => this.stream(blobs, event.id, [connection])).then(() => undefined)
        else if (event.files) this.send(connection, { type: 'abort', id: event.id })
      }
      this.broadcastRoster(); return
    }
    if (data.token) { this.reject(connection, 'expired'); return }
    if (this.state.settings.locked) { this.reject(connection, 'locked'); return }
    if (this.members.size + 1 >= MAX_PARTICIPANTS) { this.reject(connection, 'full'); return }
    if (this.pending.size >= 24) { this.reject(connection, 'full'); return }
    this.pending.set(connection.peer, { connection, name: displayName(data.name), sessionId: data.sessionId, at: Date.now() })
    if (this.state.settings.autoApprove) this.admit(connection.peer)
    else { this.send(connection, { type: 'waiting' }); this.updateRequests() }
  }
  private reject(connection: DataConnection | undefined, reason: Outcome) { this.send(connection, { type: 'outcome', reason }); this.later(() => connection?.close(), 300) }
  private sendAccepted(member: Member) {
    this.send(member.connection, { type: 'accepted', selfId: member.participant.id, token: member.token, participants: this.roster(), settings: this.state.settings })
  }
  private roster(): Participant[] { return [{ id: this.state.selfId, name: this.state.name, host: true, away: false }, ...[...this.members.values()].map(member => ({ ...member.participant }))] }
  private broadcastRoster() {
    const participants = this.roster(); this.set({ participants })
    for (const member of this.members.values()) this.send(member.connection, { type: 'roster', participants, settings: this.state.settings })
  }
  private updateRequests() { if (!this.stopped) this.set({ requests: [...this.pending.entries()].map(([id, request]) => ({ id, name: request.name })) }) }
  /**
   * Admit a waiting request, as host, unless the room has filled up meanwhile.
   * @param id - The request's ID from `RoomState.requests`.
   */
  admit(id: string) {
    const request = this.pending.get(id)
    if (!request || !request.connection.open) return
    this.pending.delete(id); this.updateRequests()
    if (this.members.size + 1 >= MAX_PARTICIPANTS) { this.reject(request.connection, 'full'); return }
    const participant: Participant = { id: crypto.randomUUID(), name: request.name, host: false, away: false }
    const member: Member = { participant, sessionId: request.sessionId, token: crypto.randomUUID(), connection: request.connection, deliveries: new Map(), seen: new Map(), lastSeen: Date.now(), rate: [] }
    this.members.set(participant.id, member)
    this.sendAccepted(member); this.broadcastRoster(); this.system(`${participant.name} joined.`)
  }
  /**
   * Decline a waiting request, as host.
   * @param id - The request's ID from `RoomState.requests`.
   */
  decline(id: string) {
    const request = this.pending.get(id)
    if (request) this.reject(request.connection, 'declined')
    this.pending.delete(id); this.updateRequests()
  }
  /**
   * Toggle automatic admission, as host; turning it on also admits everyone waiting.
   * @param autoApprove - Whether new requests are admitted without asking.
   */
  setAutoApprove(autoApprove: boolean) {
    this.set({ settings: { ...this.state.settings, autoApprove } }); this.broadcastRoster()
    if (autoApprove && !this.state.settings.locked) for (const id of [...this.pending.keys()]) this.admit(id)
  }
  /**
   * Lock or unlock the room, as host; locking also rejects everyone waiting.
   * @param locked - Whether new requests are refused.
   */
  setLocked(locked: boolean) {
    this.set({ settings: { ...this.state.settings, locked } }); this.broadcastRoster()
    if (locked) {
      for (const request of this.pending.values()) this.reject(request.connection, 'locked')
      this.pending.clear(); this.updateRequests()
    }
  }
  /**
   * Change this participant's display name; blank or unchanged names are ignored.
   * @param name - The new name; it is cleaned before use.
   */
  rename(name: string) {
    const old = this.state.name, clean = displayName(name)
    if (!name.trim() || clean === old) return
    // Ask the host, which owns the roster and announces the change.
    if (!this.state.isHost) { if (this.send(this.hostConnection, { type: 'rename', name: clean })) this.set({ name: clean }); return }
    this.set({ name: clean }); this.broadcastRoster(); this.system(`${old} is now ${clean}.`)
  }
  /**
   * Remove a participant from the room, as host, aborting any upload of theirs.
   * @param id - The participant's ID.
   */
  remove(id: string) {
    const member = this.members.get(id)
    if (!member) return
    this.reject(member.connection, 'removed')
    this.abortUpload(member); this.members.delete(id); this.broadcastRoster(); this.system(`${member.participant.name} was removed.`)
  }
  private handleMemberData(member: Member, data: Wire) {
    if (data.type === 'ping') { this.send(member.connection, { type: 'pong' }); return }
    if (data.type === 'ack' && validId(data.id)) { member.deliveries.delete(data.id); return }
    if (data.type === 'leave') {
      this.abortUpload(member); this.members.delete(member.participant.id); member.connection?.close(); this.broadcastRoster(); this.system(`${member.participant.name} left.`); return
    }
    if (data.type === 'rename' && typeof data.name === 'string' && data.name.trim()) {
      const old = member.participant.name, clean = displayName(data.name)
      member.rate = member.rate.filter(time => time > Date.now() - 10_000)
      if (clean === old || member.rate.length >= 40) return
      member.rate.push(Date.now())
      member.participant.name = clean; this.broadcastRoster(); this.system(`${old} is now ${clean}.`); return
    }
    if (data.type === 'chunk') {
      const upload = member.upload
      if (!upload || data.id !== upload.clientId) return
      const { f, i } = data
      if (!this.take(upload, data)) { this.abortUpload(member); return }
      for (const other of this.members.values()) if (other !== member) this.send(other.connection, { type: 'chunk', id: upload.id, f, i, data: data.data })
      if (upload.f === upload.meta.length) { this.files.set(upload.id, upload.blobs); member.upload = undefined }
      return
    }
    const files = validFiles(data.files) ? items(data.files) : undefined
    if (data.type !== 'message' || !validId(data.clientId) || typeof data.text !== 'string' || (data.files !== undefined && !files) || !(validText(data.text) || (files && !data.text))) return
    const existing = member.seen.get(data.clientId)
    if (existing) { this.send(member.connection, { type: 'event', event: existing }); return }
    member.rate = member.rate.filter(time => time > Date.now() - 10_000)
    if (member.rate.length >= 40) { this.send(member.connection, { type: 'slow', clientId: data.clientId }); return }
    member.rate.push(Date.now())
    const event: ChatMessage = { id: crypto.randomUUID(), clientId: data.clientId, senderId: member.participant.id, name: member.participant.name, text: data.text, time: Date.now(), ...(files && { files }) }
    member.seen.set(data.clientId, event)
    if (files) { this.abortUpload(member); member.upload = { ...transfer(event.id, files), clientId: data.clientId } }
    this.broadcastEvent(event)
  }
  // Return false for out-of-order, malformed, or oversized chunks.
  private take(t: Transfer, raw: Wire): boolean {
    if (raw.f === 0 && raw.i === 0) Object.assign(t, transfer(t.id, t.meta))
    if (raw.f !== t.f || raw.i !== t.i || typeof raw.data !== 'string' || raw.data.length > MAX_CHUNK_TEXT) return false
    let bytes: Uint8Array<ArrayBuffer>
    try { bytes = Uint8Array.from(atob(raw.data), char => char.charCodeAt(0)) } catch { return false }
    const file = t.meta[t.f]
    if (!bytes.length || t.received + bytes.length > file.size) return false
    t.parts.push(bytes); t.received += bytes.length; t.i++
    const done = t.received === file.size, pct = Math.floor(t.received * 100 / file.size)
    if (done) t.blobs.push(new Blob(t.parts, { type: safeMime(file.mime) }))
    if (pct !== t.pct) { t.pct = pct; this.patchFile(t.id, t.f, { progress: t.received, ...(done && { blob: t.blobs.at(-1) }) }) }
    if (done) Object.assign(t, { f: t.f + 1, i: 0, received: 0, pct: -1, parts: [] })
    return true
  }
  private abortUpload(member: Member) {
    const upload = member.upload
    if (!upload) return
    member.upload = undefined; this.failFiles(upload.id)
    for (const other of this.members.values()) if (other !== member) this.send(other.connection, { type: 'abort', id: upload.id })
  }
  // Match own uploads by clientId, since the host's echo changes their id.
  private patchFiles(key: string, patch: (file: FileItem, f: number) => FileItem) {
    const messages = this.state.messages.map(message => message.files && (message.id === key || (message.senderId === this.state.selfId && message.clientId === key)) ? { ...message, files: message.files.map(patch) } : message)
    this.set({ messages })
  }
  private patchFile(key: string, f: number, patch: Partial<FileItem>) { this.patchFiles(key, (file, j) => j === f ? { ...file, ...patch } : file) }
  private failFiles(key: string) { this.patchFiles(key, file => file.progress < file.size ? { ...file, failed: true } : file) }
  // Pause while any channel is backlogged to bound memory and keep progress honest.
  private async stream(blobs: Blob[], id: string, targets: (DataConnection | undefined)[], key?: string): Promise<boolean> {
    try { return await this.sendChunks(blobs, id, targets, key) } catch { return false }
  }
  private async sendChunks(blobs: Blob[], id: string, targets: (DataConnection | undefined)[], key?: string) {
    for (let f = 0; f < blobs.length; f++) {
      let pct = -1
      for (let i = 0, at = 0; at < blobs[f].size; i++, at += FILE_CHUNK) {
        const data = toBase64(new Uint8Array(await blobs[f].slice(at, at + FILE_CHUNK).arrayBuffer()))
        const open = targets.filter(connection => connection?.open) as DataConnection[]
        if (this.stopped || !open.length) return false
        for (const connection of open) this.send(connection, { type: 'chunk', id, f, i, data })
        while (!this.stopped && open.some(connection => connection.open && ((connection as BufferedConnection).bufferSize > 0 || (connection.dataChannel?.bufferedAmount ?? 0) > 1_000_000))) await new Promise<void>(resolve => this.later(resolve, 50))
        const sent = Math.min(at + FILE_CHUNK, blobs[f].size), now = Math.floor(sent * 100 / blobs[f].size)
        if (key && now !== pct) { pct = now; this.patchFile(key, f, { progress: sent }) }
      }
    }
    return true
  }
  private handleHostData(raw: unknown) {
    if (this.stopped || !isRecord(raw) || raw.v !== 1) return
    this.lastHostSeen = Date.now()
    if (raw.type === 'outcome' && ['declined', 'locked', 'full', 'ended', 'removed', 'expired'].includes(String(raw.reason))) { this.finish(raw.reason as Outcome); return }
    if (raw.type === 'waiting') { this.set({ status: 'online' }); return }
    if (raw.type === 'accepted' && validId(raw.selfId) && validId(raw.token) && Array.isArray(raw.participants) && isRecord(raw.settings)) {
      this.accepted = true; this.resumeToken = raw.token
      this.set({ screen: 'room', status: 'online', selfId: raw.selfId, participants: raw.participants as Participant[], settings: raw.settings as unknown as RoomState['settings'], reconnectUntil: undefined, error: '' })
      for (const [clientId, text] of this.outgoing) this.send(this.hostConnection, { type: 'message', text, clientId })
    }
    if (!this.accepted) return
    if (raw.type === 'pong' && this.state.status === 'reconnecting' && this.hostConnection?.open) this.set({ status: 'online', reconnectUntil: undefined })
    if (raw.type === 'roster' && Array.isArray(raw.participants) && isRecord(raw.settings)) this.set({ participants: raw.participants as Participant[], settings: raw.settings as unknown as RoomState['settings'] })
    if (raw.type === 'slow' && validId(raw.clientId)) {
      this.set({ error: 'Too many messages. Retrying shortly.' })
      this.later(() => { const text = this.outgoing.get(raw.clientId as string); if (text) this.send(this.hostConnection, { type: 'message', clientId: raw.clientId, text }) }, 10_000)
    }
    if (raw.type === 'event' && isRecord(raw.event) && validId(raw.event.id) && typeof raw.event.text === 'string') {
      const event = { ...raw.event, files: validFiles(raw.event.files) ? items(raw.event.files) : undefined } as unknown as ChatMessage
      if (event.senderId === this.state.selfId && event.clientId) this.outgoing.delete(event.clientId)
      if (!this.received.has(event.id)) {
        this.received.add(event.id)
        if (event.files && event.senderId !== this.state.selfId) this.transfers.set(event.id, transfer(event.id, event.files))
        this.append(event)
      }
      // Ack file events only once their bytes arrive, so the host resends them after a reconnect.
      if (!this.transfers.has(event.id)) this.send(this.hostConnection, { type: 'ack', id: event.id })
    }
    const pending = typeof raw.id === 'string' ? this.transfers.get(raw.id) : undefined
    if (pending && ((raw.type === 'chunk' && (!this.take(pending, raw) || pending.f === pending.meta.length)) || raw.type === 'abort')) {
      this.transfers.delete(pending.id); this.failFiles(pending.id)
      this.send(this.hostConnection, { type: 'ack', id: pending.id })
    }
  }
  private append(event: ChatMessage) {
    const index = event.clientId && event.senderId === this.state.selfId ? this.state.messages.findIndex(message => message.pending && message.clientId === event.clientId) : -1
    const messages = [...this.state.messages]
    // Keep the sender's own blobs and progress when the host's echo replaces the pending message.
    if (index !== -1) messages[index] = { ...event, files: messages[index].files }
    else messages.push(event)
    this.set({ messages, error: '' })
  }
  private broadcastEvent(event: ChatMessage, local = event) {
    this.append(local)
    // Send only to current members, so new joiners never see earlier messages.
    for (const member of this.members.values()) {
      member.deliveries.set(event.id, event)
      this.send(member.connection, { type: 'event', event })
    }
  }
  private system(text: string) { this.broadcastEvent({ id: crypto.randomUUID(), senderId: '', name: '', text, time: Date.now(), system: true }) }
  /**
   * Send a message with optional attachments to everyone in the room.
   * @param text - The message text; may be empty when files are attached.
   * @param files - Up to `MAX_FILES` files, each up to `MAX_FILE_SIZE`; guests can attach only while online.
   * @returns True if the message was accepted for sending.
   */
  sendMessage(text: string, files: File[] = []): boolean {
    const meta = files.map(file => ({ name: fileName(file.name), mime: file.type, size: file.size }))
    if (this.state.screen !== 'room' || !(validText(text) || (!text && files.length))) return false
    if (files.length && (!validFiles(meta) || (!this.state.isHost && this.state.status !== 'online'))) return false
    const clientId = crypto.randomUUID()
    const event: ChatMessage = { id: clientId, clientId, senderId: this.state.selfId, name: this.state.name, text, time: Date.now(), ...(files.length > 0 && { files: items(meta) }) }
    const local = { ...event, files: event.files?.map((file, f) => ({ ...file, blob: files[f] })) }
    if (this.state.isHost) {
      this.broadcastEvent(event, local)
      if (!files.length) return true
      this.files.set(event.id, files)
      const targets = [...this.members.values()].map(member => member.connection)
      this.uploads = this.uploads.then(async () => { await this.stream(files, event.id, targets, event.id); this.patchFiles(event.id, file => ({ ...file, progress: file.size })) })
    } else if (!files.length) {
      this.outgoing.set(clientId, text); this.append({ ...event, pending: true })
      this.send(this.hostConnection, { type: 'message', text, clientId })
    } else {
      // Skip the resend queue, since file metadata without its bytes is useless.
      this.append({ ...local, pending: true })
      this.uploads = this.uploads.then(async () => {
        const connection = this.hostConnection
        if (!this.send(connection, { type: 'message', text, clientId, files: meta }) || !await this.stream(files, clientId, [connection], clientId)) this.failFiles(clientId)
      })
    }
    return true
  }
  private markAway(member: Member) {
    this.abortUpload(member)
    member.connection = undefined
    if (!member.awayAt) { member.awayAt = Date.now(); member.participant.away = true; this.broadcastRoster() }
  }
  private startTicker() {
    this.ticker = setInterval(() => {
      if (this.stopped) return
      const now = Date.now()
      if (this.peer?.disconnected && !this.peer.destroyed) { try { this.peer.reconnect() } catch { /* Retry on the next tick. */ } }
      if (this.state.isHost) {
        if (this.state.status !== 'online' && now - this.startAt > 30_000 && this.members.size === 0) { this.finish('connection'); return }
        for (const member of this.members.values()) {
          if (member.connection?.open && now - member.lastSeen > 15_000) { const connection = member.connection; this.markAway(member); connection.close() }
          if (member.awayAt && now - member.awayAt >= RECONNECT_MS) { this.members.delete(member.participant.id); this.broadcastRoster(); this.system(`${member.participant.name} left.`) }
        }
        for (const [id, request] of this.pending) if (now - request.at > 300_000) { this.reject(request.connection, 'expired'); this.pending.delete(id); this.updateRequests() }
      } else {
        this.send(this.hostConnection, { type: 'ping' })
        if (this.accepted && now - this.lastHostSeen > 15_000 && this.hostConnection?.open) { this.markReconnecting(); this.hostConnection.close() }
        if (this.accepted && now - this.lastHostSeen >= RECONNECT_MS) { this.finish('ended'); return }
        if (!this.accepted && this.state.status === 'connecting' && now - this.startAt > 25_000) { this.finish('connection'); return }
        if (!this.accepted && now - this.lastHostSeen > 25_000) { this.finish('unavailable'); return }
        if (!this.hostConnection?.open && now - this.attemptAt > 4000) this.connectHost()
        // Resend unacked messages; the host dedupes by clientId.
        if (this.accepted && this.state.status === 'online') for (const [clientId, text] of this.outgoing) this.send(this.hostConnection, { type: 'message', clientId, text })
      }
    }, 3000)
  }
  /** Withdraw a pending join request and return to the landing screen. */
  cancel() { this.send(this.hostConnection, { type: 'cancel' }); this.home() }
  /** Leave the room as a guest, or end it for everyone as host. */
  leave() {
    if (this.state.isHost) {
      for (const connection of this.connections) this.send(connection, { type: 'outcome', reason: 'ended' })
    } else this.send(this.hostConnection, { type: 'leave' })
    this.finish(this.state.isHost ? 'ended' : 'left')
  }
  /** Notify the room that this tab is closing; call it from `pagehide`. */
  unload() {
    if (this.state.screen === 'room') this.leave()
    else if (this.state.screen === 'waiting') this.send(this.hostConnection, { type: 'cancel' })
  }
  private finish(outcome: Outcome) {
    // Delay cleanup so queued control packets can leave before channels close.
    this.stopped = true
    if (this.ticker) clearInterval(this.ticker)
    this.set({ screen: 'outcome', outcome, messages: [], participants: [], requests: [], error: '', reconnectUntil: undefined })
    this.later(() => this.cleanup(), 200)
  }
  /** Close every connection and discard all room state, timers and transfers immediately. */
  cleanup() {
    this.stopped = true
    if (this.ticker) clearInterval(this.ticker)
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.peer?.destroy(); this.peer = undefined; this.hostConnection = undefined
    this.connections.clear(); this.members.clear(); this.pending.clear(); this.outgoing.clear(); this.received.clear(); this.transfers.clear(); this.files.clear()
    this.uploads = Promise.resolve()
    this.resumeToken = undefined; this.accepted = false
  }
}
