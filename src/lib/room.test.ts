import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ peers: new Map<string, any>(), blocked: new Set<string>(), dropAcks: false }))
vi.mock('peerjs', () => {
  class Events {
    handlers = new Map<string, Array<(...args: any[]) => void>>()
    on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); return this }
    emit(event: string, ...args: any[]) { this.handlers.get(event)?.forEach(fn => fn(...args)) }
  }
  class Connection extends Events {
    open = false
    other?: Connection
    constructor(public peer: string, public owner: string) { super() }
    send(data: unknown) {
      if (!this.open || network.blocked.has(this.owner) || network.blocked.has(this.peer)) return
      if (new TextEncoder().encode(JSON.stringify(data)).byteLength >= 16300) throw new Error('Message too big for JSON channel')
      const serialized = JSON.parse(JSON.stringify(data))
      if (network.dropAcks && serialized.type === 'ack') return
      setTimeout(() => { if (this.other?.open) this.other.emit('data', serialized) }, 0)
    }
    close() {
      if (!this.open) return
      this.open = false; this.emit('close')
      if (this.other?.open) { this.other.open = false; this.other.emit('close') }
    }
  }
  class FakePeer extends Events {
    open = false; disconnected = false; destroyed = false; connections: Connection[] = []
    constructor(public id: string) {
      super(); network.peers.set(id, this)
      setTimeout(() => { this.open = true; this.emit('open', id) }, 0)
    }
    connect(id: string) {
      const connection = new Connection(id, this.id); this.connections.push(connection)
      const target = network.peers.get(id)
      if (!target || network.blocked.has(this.id)) return connection
      const incoming = new Connection(this.id, id); target.connections.push(incoming)
      connection.other = incoming; incoming.other = connection
      setTimeout(() => {
        target.emit('connection', incoming)
        connection.open = incoming.open = true
        incoming.emit('open'); connection.emit('open')
      }, 0)
      return connection
    }
    reconnect() { this.disconnected = false; this.open = true; this.emit('open', this.id) }
    destroy() { this.destroyed = true; this.open = false; this.connections.forEach(connection => connection.close()); network.peers.delete(this.id) }
  }
  return { default: FakePeer }
})
import { RoomEngine } from './room'

const engines: RoomEngine[] = []
const make = () => { const engine = new RoomEngine(); engines.push(engine); return engine }
const settle = () => vi.advanceTimersByTimeAsync(30)
// Advance many rounds, since file reads resolve outside fake timers.
async function flush() { for (let round = 0; round < 60; round++) { await vi.advanceTimersByTimeAsync(30); await new Promise(resolve => process.nextTick(resolve)) } }
const binary = (size: number) => new File([Uint8Array.from({ length: size }, (_, i) => i % 251)], 'data.bin', { type: 'application/octet-stream' })
async function hostRoom(manual = true) { const host = make(); host.createRoom(); if (manual) host.setAutoApprove(false); await settle(); return host }
async function request(host: RoomEngine, name = 'Alex') {
  const guest = make(); guest.showJoin(host.getSnapshot().code); guest.requestJoin(name); await settle(); return guest
}
async function join(host: RoomEngine, name = 'Alex') {
  const guest = await request(host, name)
  if (guest.getSnapshot().screen === 'waiting') { host.admit(host.getSnapshot().requests.at(-1)!.id); await settle() }
  return guest
}
beforeEach(() => {
  vi.useFakeTimers(); network.peers.clear(); network.blocked.clear(); network.dropAcks = false
  vi.stubGlobal('history', { replaceState: vi.fn() }); vi.stubGlobal('location', { pathname: '/' })
})
afterEach(() => { engines.forEach(engine => engine.cleanup()); engines.length = 0; vi.useRealTimers(); vi.unstubAllGlobals() })

describe('host-star room behavior', () => {
  it('uses clean room paths and returns home to the root path', async () => {
    const host = await hostRoom()
    expect(history.replaceState).toHaveBeenLastCalledWith(null, '', `/${host.getSnapshot().code}`)
    const guest = make(); guest.showJoin('HLMV2K')
    expect(history.replaceState).toHaveBeenLastCalledWith(null, '', '/HLMV2K')
    guest.home()
    expect(history.replaceState).toHaveBeenLastCalledWith(null, '', '/')
  })
  it('waits for host approval, then exchanges messages without sharing earlier history', async () => {
    const host = await hostRoom()
    host.sendMessage('before anyone joined')
    const alex = await request(host)
    expect(alex.getSnapshot().screen).toBe('waiting')
    expect(host.getSnapshot().requests[0].name).toBe('Alex')
    host.admit(host.getSnapshot().requests[0].id); await settle()
    expect(alex.getSnapshot().screen).toBe('room')
    expect(alex.getSnapshot().messages.some(m => m.text === 'before anyone joined')).toBe(false)
    alex.sendMessage('hello host'); await settle()
    expect(host.getSnapshot().messages.filter(m => m.text === 'hello host')).toHaveLength(1)
    expect(alex.getSnapshot().messages.filter(m => m.text === 'hello host')).toHaveLength(1)
    expect(alex.getSnapshot().messages.at(-1)?.pending).not.toBe(true)
    const bob = await join(host, 'Bob')
    expect(bob.getSnapshot().messages.some(m => m.text === 'hello host')).toBe(false)
    host.sendMessage('hello everyone'); await settle()
    expect([alex, bob].every(g => g.getSnapshot().messages.at(-1)?.text === 'hello everyone')).toBe(true)
  })
  it('declines requests and cancels requests cleanly', async () => {
    const host = await hostRoom(); const alex = await request(host)
    host.decline(host.getSnapshot().requests[0].id); await settle()
    expect(alex.getSnapshot().outcome).toBe('declined')
    const bob = await request(host, 'Bob'); bob.cancel(); await settle()
    expect(host.getSnapshot().requests).toHaveLength(0)
    expect(bob.getSnapshot().screen).toBe('landing')
  })
  it('locks pending and new requests, while admitting everyone works when unlocked', async () => {
    const host = await hostRoom(); const alex = await request(host)
    host.setLocked(true); await settle()
    expect(alex.getSnapshot().outcome).toBe('locked')
    const bob = await request(host, 'Bob'); expect(bob.getSnapshot().outcome).toBe('locked')
    host.setLocked(false); host.setAutoApprove(true)
    const charlie = await request(host, 'Charlie')
    expect(charlie.getSnapshot().screen).toBe('room')
  })
  it('auto-admits by default: seven guests get in and a ninth person is rejected, counting the host', async () => {
    const host = await hostRoom(false)
    expect(host.getSnapshot().settings.autoApprove).toBe(true)
    for (let i = 0; i < 7; i++) expect((await request(host, `Guest${i}`)).getSnapshot().screen).toBe('room')
    const extra = await request(host, 'Extra')
    expect(extra.getSnapshot().outcome).toBe('full')
    expect(host.getSnapshot().participants).toHaveLength(8)
  })
  it('enforces the eight-person limit when approving already waiting requests', async () => {
    const host = await hostRoom()
    const guests: RoomEngine[] = []
    for (let i = 0; i < 8; i++) guests.push(await request(host, `Guest${i}`))
    expect(host.getSnapshot().requests).toHaveLength(8)
    for (const pending of [...host.getSnapshot().requests]) host.admit(pending.id)
    await settle()
    expect(host.getSnapshot().participants).toHaveLength(8)
    expect(guests.filter(guest => guest.getSnapshot().screen === 'room')).toHaveLength(7)
    expect(guests[7].getSnapshot().outcome).toBe('full')
  })
  it('lets the host and guests rename themselves and shares the new name', async () => {
    const host = await hostRoom(), alex = await join(host)
    host.rename('  Cara  '); host.rename('   '); await settle()
    expect(host.getSnapshot().name).toBe('Cara')
    expect(alex.getSnapshot().participants.find(p => p.host)?.name).toBe('Cara')
    expect(alex.getSnapshot().messages.at(-1)?.text).toMatch(/ is now Cara\.$/)
    host.sendMessage('hi'); await settle()
    expect(alex.getSnapshot().messages.at(-1)?.name).toBe('Cara')
    alex.rename('  Dana  '); await settle()
    expect(alex.getSnapshot().name).toBe('Dana')
    expect(host.getSnapshot().participants.find(p => p.id === alex.getSnapshot().selfId)?.name).toBe('Dana')
    expect(alex.getSnapshot().participants.find(p => p.id === alex.getSnapshot().selfId)?.name).toBe('Dana')
    expect(host.getSnapshot().messages.at(-1)?.text).toBe('Alex is now Dana.')
    alex.sendMessage('hello'); await settle()
    expect(host.getSnapshot().messages.at(-1)?.name).toBe('Dana')
  })
  it('removes a participant and ends every remaining connection', async () => {
    const host = await hostRoom(), alex = await join(host), bob = await join(host, 'Bob')
    host.remove(alex.getSnapshot().selfId); await settle()
    expect(alex.getSnapshot().outcome).toBe('removed')
    expect(alex.getSnapshot().messages).toHaveLength(0)
    host.leave(); await settle()
    expect(bob.getSnapshot().outcome).toBe('ended')
    expect(host.getSnapshot().messages).toHaveLength(0)
    expect(bob.getSnapshot().messages).toHaveLength(0)
  })
  it('buffers messages during a brief drop and replays once, even if entry was locked', async () => {
    const host = await hostRoom(), alex = await join(host)
    const guestPeer = [...network.peers.values()].find(peer => peer.id.includes('guest-'))
    network.blocked.add(guestPeer.id); guestPeer.connections.forEach((connection: any) => connection.close())
    expect(host.getSnapshot().participants.find(p => !p.host)?.away).toBe(true)
    expect(alex.getSnapshot().status).toBe('reconnecting')
    host.sendMessage('held for Alex'); alex.sendMessage('held for host'); host.setLocked(true)
    await vi.advanceTimersByTimeAsync(10_000)
    network.blocked.delete(guestPeer.id)
    await vi.advanceTimersByTimeAsync(6000)
    expect(alex.getSnapshot().status).toBe('online')
    expect(host.getSnapshot().participants).toHaveLength(2)
    expect(host.getSnapshot().participants.find(p => !p.host)?.away).toBe(false)
    expect(alex.getSnapshot().messages.filter(m => m.text === 'held for Alex')).toHaveLength(1)
    expect(host.getSnapshot().messages.filter(m => m.text === 'held for host')).toHaveLength(1)
    expect(alex.getSnapshot().messages.filter(m => m.text === 'held for host')).toHaveLength(1)
  })
  it('expires absent participants and ends a guest room when the host disappears', async () => {
    const host = await hostRoom(), alex = await join(host)
    const guestPeer = [...network.peers.values()].find(peer => peer.id.includes('guest-'))
    network.blocked.add(guestPeer.id); guestPeer.connections.forEach((connection: any) => connection.close())
    await vi.advanceTimersByTimeAsync(123_000)
    expect(host.getSnapshot().participants).toHaveLength(1)
    expect(alex.getSnapshot().outcome).toBe('ended')
  })
  it('rejects an oversized outgoing message', async () => {
    const host = await hostRoom(), alex = await join(host)
    expect(alex.sendMessage('x'.repeat(4001))).toBe(false)
    await settle()
    expect(host.getSnapshot().messages.some(m => m.text.length > 4000)).toBe(false)
  })
  it('deduplicates replay when a delivered message acknowledgment was lost', async () => {
    const host = await hostRoom(), alex = await join(host)
    network.dropAcks = true
    host.sendMessage('received but not acknowledged'); await settle()
    const guestPeer = [...network.peers.values()].find(peer => peer.id.includes('guest-'))
    guestPeer.connections.forEach((connection: any) => connection.close())
    network.dropAcks = false
    await vi.advanceTimersByTimeAsync(6000)
    expect(alex.getSnapshot().messages.filter(m => m.text === 'received but not acknowledged')).toHaveLength(1)
  })
  it('uses the admitted identity rather than a forged message sender', async () => {
    const host = await hostRoom(), alex = await join(host)
    const guestPeer = [...network.peers.values()].find(peer => peer.id.includes('guest-'))
    guestPeer.connections[0].send({ v: 1, type: 'message', text: 'forged sender', clientId: 'test-client-id', senderId: host.getSnapshot().selfId, name: 'Host' })
    await settle()
    const message = host.getSnapshot().messages.find(m => m.text === 'forged sender')!
    expect(message.name).toBe('Alex')
    expect(message.senderId).toBe(alex.getSnapshot().selfId)
  })
  it('sends files with a message: every other device gets the text once and complete, safely typed files', async () => {
    const host = await hostRoom(false), alex = await join(host), bob = await join(host, 'Bob')
    const big = binary(100_000), note = new File(['hello'], 'note.txt', { type: 'text/plain' })
    expect(alex.sendMessage('two files', [big, note])).toBe(true)
    await flush()
    for (const engine of [host, bob]) {
      const sent = engine.getSnapshot().messages.filter(m => m.text === 'two files')
      expect(sent).toHaveLength(1)
      const [first, second] = sent[0].files!
      expect(new Uint8Array(await first.blob!.arrayBuffer())).toEqual(new Uint8Array(await big.arrayBuffer()))
      expect(await second.blob!.text()).toBe('hello')
      expect(second.blob!.type).toBe('application/octet-stream')
    }
    expect(alex.getSnapshot().messages.at(-1)?.files?.every(file => file.progress === file.size && !file.failed)).toBe(true)
    expect(host.sendMessage('', [note])).toBe(true); await flush()
    expect(await alex.getSnapshot().messages.at(-1)?.files?.[0].blob?.text()).toBe('hello')
    expect(alex.sendMessage('', [])).toBe(false)
  })
  it('ignores chunks from someone else and aborts a stream that overflows its declared size', async () => {
    const host = await hostRoom(false), alex = await join(host), bob = await join(host, 'Bob')
    const [alexPeer, bobPeer] = [...network.peers.values()].filter(peer => peer.id.includes('guest-'))
    alexPeer.connections[0].send({ v: 1, type: 'message', text: 'forged file', clientId: 'upload-1', files: [{ name: 'a.bin', mime: '', size: 4 }] })
    await settle()
    bobPeer.connections[0].send({ v: 1, type: 'chunk', id: 'upload-1', f: 0, i: 0, data: btoa('abcd') })
    await settle()
    expect(host.getSnapshot().messages.find(m => m.text === 'forged file')?.files?.[0].progress).toBe(0)
    alexPeer.connections[0].send({ v: 1, type: 'chunk', id: 'upload-1', f: 0, i: 0, data: btoa('abcdef') })
    await settle()
    for (const engine of [host, bob]) expect(engine.getSnapshot().messages.find(m => m.text === 'forged file')?.files?.[0].failed).toBe(true)
    expect(alex.getSnapshot().screen).toBe('room')
  })
  it('resends a shared file to someone who dropped before it arrived', async () => {
    const host = await hostRoom(), alex = await join(host)
    const guestPeer = [...network.peers.values()].find(peer => peer.id.includes('guest-'))
    network.blocked.add(guestPeer.id); guestPeer.connections.forEach((connection: any) => connection.close())
    host.sendMessage('while away', [binary(70_000)])
    await vi.advanceTimersByTimeAsync(10_000)
    network.blocked.delete(guestPeer.id)
    await vi.advanceTimersByTimeAsync(6000); await flush()
    const received = alex.getSnapshot().messages.filter(m => m.text === 'while away')
    expect(received).toHaveLength(1)
    expect(received[0].files?.[0].blob?.size).toBe(70_000)
  })
  it('does not allow an unadmitted connection to send messages', async () => {
    const host = await hostRoom(); await request(host)
    const guestPeer = [...network.peers.values()].find(peer => peer.id.includes('guest-'))
    guestPeer.connections[0].send({ v: 1, type: 'message', text: 'not admitted', clientId: 'unapproved-client-id' })
    await settle()
    expect(host.getSnapshot().messages.some(m => m.text === 'not admitted')).toBe(false)
  })
})
