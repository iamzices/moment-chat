import Peer, { type DataConnection } from 'peerjs'
import { PEER_PREFIX, RECONNECT_MS, MAX_PARTICIPANTS, displayName, generateCode, isRecord, validText, validId, type RoomState, type Participant, type ChatMessage, type Outcome } from './protocol'

type Wire = Record<string, unknown>
interface Member {
  participant: Participant; sessionId: string; token: string; connection?: DataConnection
  awayAt?: number; deliveries: Map<string, ChatMessage>; seen: Map<string, ChatMessage>; lastSeen: number
  rate: number[]
}
interface Pending { connection: DataConnection; name: string; sessionId: string; at: number }
const initialState = (): RoomState => ({ screen: 'landing', code: '', selfId: '', isHost: false, name: '', status: 'connecting', participants: [], requests: [], messages: [], settings: { autoApprove: false, locked: false }, error: '' })

// All room state, resume secrets and message buffers exist only in this tab's memory.
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
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
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
    // STUN discovers addresses. No TURN means no server can relay chat payloads.
    const peer = new Peer(id, { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } })
    peer.on('disconnected', () => {
      if (this.stopped || this.peer !== peer) return
      if (this.state.isHost) this.set({ status: 'reconnecting' })
      this.later(() => { if (!peer.destroyed && peer.disconnected) { try { peer.reconnect() } catch { /* retried by ticker */ } } }, 1500)
    })
    peer.on('error', error => {
      if (this.stopped || this.peer !== peer) return
      if (error.type === 'unavailable-id' && this.state.isHost && this.hostRetries++ < 4) {
        peer.destroy(); this.openHost(); return
      }
      if (['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable', 'unavailable-id'].includes(error.type)) { this.finish('connection'); return }
      if (!this.state.isHost && !this.accepted && error.type === 'peer-unavailable') { this.finish('unavailable'); return }
      if (this.state.isHost && this.state.status !== 'online') this.set({ error: 'Connecting to the room…' })
    })
    this.peer = peer
    return peer
  }
  showJoin(code: string) { this.set({ screen: 'join', code, error: '' }); history.replaceState(null, '', `/${code}`) }
  home() { this.cleanup(); this.stopped = false; this.sessionId = crypto.randomUUID(); this.set(initialState()); history.replaceState(null, '', '/') }
  createRoom() {
    this.cleanup(); this.stopped = false; this.hostRetries = 0; this.startAt = Date.now()
    const selfId = crypto.randomUUID(), name = displayName('')
    this.set({ ...initialState(), screen: 'room', isHost: true, selfId, name, participants: [{ id: selfId, name, host: true, away: false }] })
    this.openHost(); this.startTicker()
  }
  private openHost() {
    const code = generateCode()
    this.set({ code, status: 'connecting' })
    history.replaceState(null, '', `/${code}`)
    const peer = this.createPeer(`${PEER_PREFIX}${code}`)
    peer.on('open', () => { if (!this.stopped && this.peer === peer) this.set({ status: 'online', error: '' }) })
    peer.on('connection', connection => this.handleIncoming(connection))
  }
  requestJoin(name: string) {
    const code = this.state.code
    this.cleanup(); this.stopped = false; this.accepted = false; this.startAt = Date.now(); this.lastHostSeen = Date.now()
    this.sessionId = crypto.randomUUID()
    this.set({ ...initialState(), screen: 'waiting', code, name: displayName(name) })
    history.replaceState(null, '', `/${code}`)
    const peer = this.createPeer(`${PEER_PREFIX}guest-${crypto.randomUUID()}`)
    peer.on('open', () => this.connectHost())
    peer.on('connection', connection => connection.close())
    this.startTicker()
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
      for (const event of existing.deliveries.values()) this.send(connection, { type: 'event', event })
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
  decline(id: string) {
    const request = this.pending.get(id)
    if (request) this.reject(request.connection, 'declined')
    this.pending.delete(id); this.updateRequests()
  }
  setAutoApprove(autoApprove: boolean) {
    this.set({ settings: { ...this.state.settings, autoApprove } }); this.broadcastRoster()
    if (autoApprove && !this.state.settings.locked) for (const id of [...this.pending.keys()]) this.admit(id)
  }
  setLocked(locked: boolean) {
    this.set({ settings: { ...this.state.settings, locked } }); this.broadcastRoster()
    if (locked) {
      for (const request of this.pending.values()) this.reject(request.connection, 'locked')
      this.pending.clear(); this.updateRequests()
    }
  }
  rename(name: string) {
    const old = this.state.name, clean = displayName(name)
    if (!this.state.isHost || !name.trim() || clean === old) return
    this.set({ name: clean }); this.broadcastRoster(); this.system(`${old} is now ${clean}.`)
  }
  remove(id: string) {
    const member = this.members.get(id)
    if (!member) return
    this.reject(member.connection, 'removed')
    this.members.delete(id); this.broadcastRoster(); this.system(`${member.participant.name} was removed.`)
  }
  private handleMemberData(member: Member, data: Wire) {
    if (data.type === 'ping') { this.send(member.connection, { type: 'pong' }); return }
    if (data.type === 'ack' && validId(data.id)) { member.deliveries.delete(data.id); return }
    if (data.type === 'leave') {
      this.members.delete(member.participant.id); member.connection?.close(); this.broadcastRoster(); this.system(`${member.participant.name} left.`); return
    }
    if (data.type !== 'message' || !validText(data.text) || !validId(data.clientId)) return
    const existing = member.seen.get(data.clientId)
    if (existing) { this.send(member.connection, { type: 'event', event: existing }); return }
    member.rate = member.rate.filter(time => time > Date.now() - 10_000)
    if (member.rate.length >= 40) { this.send(member.connection, { type: 'slow', clientId: data.clientId }); return }
    member.rate.push(Date.now())
    const event: ChatMessage = { id: crypto.randomUUID(), clientId: data.clientId, senderId: member.participant.id, name: member.participant.name, text: data.text, time: Date.now() }
    member.seen.set(data.clientId, event)
    this.broadcastEvent(event)
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
      const event = raw.event as unknown as ChatMessage
      this.send(this.hostConnection, { type: 'ack', id: event.id })
      if (event.senderId === this.state.selfId && event.clientId) this.outgoing.delete(event.clientId)
      if (this.received.has(event.id)) return
      this.received.add(event.id)
      this.append(event)
    }
  }
  private append(event: ChatMessage) {
    const index = event.clientId && event.senderId === this.state.selfId ? this.state.messages.findIndex(message => message.pending && message.clientId === event.clientId) : -1
    const messages = [...this.state.messages]
    if (index !== -1) messages[index] = event
    else messages.push(event)
    this.set({ messages, error: '' })
  }
  private broadcastEvent(event: ChatMessage) {
    this.append(event)
    // Only current members receive an event, so a new join never gets earlier messages.
    for (const member of this.members.values()) {
      member.deliveries.set(event.id, event)
      this.send(member.connection, { type: 'event', event })
    }
  }
  private system(text: string) { this.broadcastEvent({ id: crypto.randomUUID(), senderId: '', name: '', text, time: Date.now(), system: true }) }
  sendMessage(text: string): boolean {
    if (this.state.screen !== 'room' || !validText(text)) return false
    const clientId = crypto.randomUUID()
    const event: ChatMessage = { id: clientId, clientId, senderId: this.state.selfId, name: this.state.name, text, time: Date.now() }
    if (this.state.isHost) this.broadcastEvent(event)
    else {
      this.outgoing.set(clientId, text); this.append({ ...event, pending: true })
      this.send(this.hostConnection, { type: 'message', text, clientId })
    }
    return true
  }
  private markAway(member: Member) {
    member.connection = undefined
    if (!member.awayAt) { member.awayAt = Date.now(); member.participant.away = true; this.broadcastRoster() }
  }
  private startTicker() {
    this.ticker = setInterval(() => {
      if (this.stopped) return
      const now = Date.now()
      if (this.peer?.disconnected && !this.peer.destroyed) { try { this.peer.reconnect() } catch { /* next tick retries */ } }
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
        // Re-send unacknowledged sends; host deduplicates by clientId.
        if (this.accepted && this.state.status === 'online') for (const [clientId, text] of this.outgoing) this.send(this.hostConnection, { type: 'message', clientId, text })
      }
    }, 3000)
  }
  cancel() { this.send(this.hostConnection, { type: 'cancel' }); this.home() }
  leave() {
    if (this.state.isHost) {
      for (const connection of this.connections) this.send(connection, { type: 'outcome', reason: 'ended' })
    } else this.send(this.hostConnection, { type: 'leave' })
    this.finish(this.state.isHost ? 'ended' : 'left')
  }
  unload() {
    if (this.state.screen === 'room') this.leave()
    else if (this.state.screen === 'waiting') this.send(this.hostConnection, { type: 'cancel' })
  }
  private finish(outcome: Outcome) {
    // Give queued control packets a short chance to leave before closing data channels.
    this.stopped = true
    if (this.ticker) clearInterval(this.ticker)
    this.set({ screen: 'outcome', outcome, messages: [], participants: [], requests: [], error: '', reconnectUntil: undefined })
    this.later(() => this.cleanup(), 200)
  }
  cleanup() {
    this.stopped = true
    if (this.ticker) clearInterval(this.ticker)
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.peer?.destroy(); this.peer = undefined; this.hostConnection = undefined
    this.connections.clear(); this.members.clear(); this.pending.clear(); this.outgoing.clear(); this.received.clear()
    this.resumeToken = undefined; this.accepted = false
  }
}
