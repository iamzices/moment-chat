import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, Check, Copy, Crown, Ellipsis, Pencil, Wifi, WifiOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RoomEngine } from '@/lib/room'
import { displayName, inviteUrl, MAX_MESSAGE_LENGTH, MAX_PARTICIPANTS, parseRoomCode, type Outcome, type Participant, type RoomState } from '@/lib/protocol'
import { cn } from '@/lib/utils'

const outcomes: Record<Outcome, string> = {
  declined: 'The host declined your request.',
  locked: 'This room is locked.',
  full: 'This room is full.',
  ended: 'This room has ended.',
  removed: 'The host removed you from the room.',
  unavailable: 'This room is unavailable.',
  connection: 'Couldn’t connect to this room.',
  expired: 'Your session has expired.',
  left: 'You left the room.',
}

// Decorative chat bubbles that slowly rise behind the landing page: [left %, width, height, seconds, start progress, own message].
const bubbles: [number, number, number, number, number, boolean?][] = [
  [6, 220, 64, 64, .1], [18, 150, 50, 74, .55, true], [34, 190, 58, 58, .8], [52, 130, 46, 80, .3, true],
  [66, 240, 68, 68, .65], [80, 160, 52, 62, .05, true], [90, 200, 60, 76, .45],
]
function Bubbles() {
  return <div className="home-bubbles" aria-hidden="true">{bubbles.map(([left, width, height, seconds, start, own], i) =>
    <span key={i} className={cn('home-bubble', own && 'own')} style={{ left: `${left}%`, width, height, animationDuration: `${seconds}s`, animationDelay: `${-start * seconds}s` }} />)}</div>
}

function Brand() { return <img className="brand" src="/assets/moment-wordmark.svg?v=3" alt="Moment" width={120} height={24} /> }
function AppHeader({ children }: { children?: ReactNode }) { return <header className="app-header"><Brand />{children}</header> }
function CopyButton({ value, onFailure, onSuccess }: { value: string; onFailure: () => void; onSuccess: () => void }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (status === 'copied') { const id = setTimeout(() => setStatus('idle'), 2500); return () => clearTimeout(id) }
  }, [status])
  async function copyLink() {
    try { await navigator.clipboard.writeText(value); setStatus('copied'); onSuccess() }
    catch { setStatus('failed'); onFailure() }
  }
  const label = status === 'copied' ? 'Link copied' : status === 'failed' ? 'Copy failed' : 'Copy link'
  return <Button className="copy-button" variant="ghost" onClick={copyLink} aria-label={status === 'idle' ? 'Copy link to room' : label}>
    {status === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}<span className="sr-only" aria-live="polite">{label}</span>
  </Button>
}

function subscribeToLayout(listener: () => void) {
  const query = window.matchMedia('(max-width: 760px)')
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
const isMobileLayout = () => window.matchMedia('(max-width: 760px)').matches

function PrivacyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="moment-dialog privacy-dialog" aria-describedby={undefined}>
    <DialogHeader><DialogTitle>Privacy</DialogTitle></DialogHeader>
    {([
      ['Data collected', 'Moment does not collect any personal data. There are no accounts, cookies, tracking, or analytics.'],
      ['Messages', 'Messages are encrypted and never pass through a server. They exist only in browser memory and are deleted when a participant leaves or the room ends.'],
      ['Third parties', 'The PeerJS signaling service sees room codes and IP addresses. Connection servers run by Google and Twilio see IP addresses. GitHub Pages and Cloudflare, which host the website, may log page requests, including invite links.'],
      ['Contact', <>Questions can be sent to <a href="mailto:hello@zices.com">hello@zices.com</a>.</>],
    ] as [string, ReactNode][]).map(([title, text]) => <div className="privacy-item about-item" key={title}><div><h3>{title}</h3><p>{text}</p></div></div>)}
  </DialogContent></Dialog>
}

function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  const link = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="moment-dialog privacy-dialog" aria-describedby={undefined}>
    <DialogHeader><DialogTitle>About</DialogTitle></DialogHeader>
    <div className="privacy-item about-item">
      <p>Moment is a private, temporary chat built and maintained by Zices, an independent software developer. It runs entirely in the browser, with no accounts, no message servers, and nothing kept once a room ends.</p>
      <p>Moment is {link('https://github.com/iamzices/moment-chat', 'open source on GitHub')}. Find Zices on GitHub as {link('https://github.com/iamzices', '@iamzices')}, or see more projects at {link('https://zices.com', 'zices.com')}.</p>
    </div>
  </DialogContent></Dialog>
}

export default function App() {
  const [engine] = useState(() => new RoomEngine())
  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joinError, setJoinError] = useState('')
  const [name, setName] = useState(() => displayName(''))
  const [unread, setUnread] = useState(0)
  const seenIds = useRef(new Set<string>())
  useEffect(() => {
    const code = parseRoomCode(location.href)
    if (code) engine.showJoin(code)
    const onPageHide = () => engine.unload()
    window.addEventListener('pagehide', onPageHide)
    return () => { window.removeEventListener('pagehide', onPageHide) }
  }, [engine])
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) setUnread(0) }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
  useEffect(() => {
    const fresh = state.messages.filter(message => !message.system && !message.pending && message.senderId !== state.selfId && !seenIds.current.has(message.id))
    state.messages.forEach(message => { if (!message.pending) seenIds.current.add(message.id) })
    if (document.hidden && fresh.length) setUnread(current => current + fresh.length)
    if (state.screen !== 'room') { setUnread(0); seenIds.current.clear() }
  }, [state.messages, state.selfId, state.screen])
  useEffect(() => {
    document.title = state.screen === 'room' ? `${unread ? `(${unread}) ` : ''}${state.code} · Moment` : 'Moment | Private Chat Rooms, No Sign-Up'
  }, [unread, state.code, state.screen])
  function openJoin(event: FormEvent) {
    event.preventDefault()
    const code = parseRoomCode(joinCode)
    if (!code) { setJoinError('Enter a valid 6-character room code or invite link.'); return }
    setJoinError(''); setName(displayName('')); engine.showJoin(code)
  }
  return <div className={cn('app-shell', state.screen === 'room' && 'room-shell')}>
    {state.screen === 'room' ? <Room state={state} engine={engine} /> : <>
      {state.screen !== 'landing' && <AppHeader />}
      <main className={cn('entry-main', state.screen === 'landing' && 'home-main')}>
        {state.screen === 'landing' && <Bubbles />}
        {state.screen === 'landing' && <div className="landing-content">
          <div className="home-intro">
            <h1 className="home-title"><span className="home-brand">Moment</span> Chat Rooms</h1>
            <p className="home-description">Create a private, temporary chat room in one click. No sign-up. Messages are encrypted between browsers and never sent through a message server.</p>
          </div>
          <div className="home-actions">
            <Button className="create-action" onClick={() => { setName(displayName('')); engine.createRoom() }}>Create Room</Button>
            <form onSubmit={openJoin} className="join-form">
              <Label htmlFor="room-code" className="sr-only">Room Code or Invite Link</Label>
              <Input id="room-code" value={joinCode} onChange={event => { setJoinCode(event.target.value); setJoinError('') }} onPaste={event => { const pasted = event.clipboardData.getData('text/plain'); if (parseRoomCode(pasted)) { event.preventDefault(); setJoinCode(pasted.trim()); setJoinError('') } }} placeholder="Room Code or Invite Link" autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go" aria-invalid={!!joinError} aria-describedby={joinError ? 'join-error' : undefined} />
              <Button type="submit" variant="ghost" size="icon" className="join-submit" aria-label="Join Room"><ArrowRight aria-hidden="true" /></Button>
              {joinError && <p className="sr-only" id="join-error" role="alert">{joinError}</p>}
            </form>
          </div>
          <nav className="home-information" aria-label="About and privacy"><Button variant="ghost" onClick={() => setAboutOpen(true)}>About</Button><Button variant="ghost" onClick={() => setPrivacyOpen(true)}>Privacy</Button></nav>
        </div>}
        {state.screen === 'join' && <div className="flow-card"><Button variant="ghost" size="icon" className="back-button" onClick={() => engine.home()} aria-label="Back to home"><ArrowLeft aria-hidden="true" /></Button><h1 className="sr-only">Join Room</h1><div className="room-code-pill" role="group" aria-label="Room code"><strong>{state.code}</strong></div><form onSubmit={event => { event.preventDefault(); engine.requestJoin(name) }} className="name-form"><Label htmlFor="display-name" className="sr-only">Name</Label><Input id="display-name" className="person-name" maxLength={32} autoComplete="off" value={name} onChange={event => setName(event.target.value)} onFocus={event => event.target.select()} /><Button className="primary-action" type="submit">Request to join<ArrowRight aria-hidden="true" /></Button></form></div>}
        {state.screen === 'waiting' && <div className="flow-card waiting-card"><p className="waiting-room-code">{state.code}</p><h1 role="status">{state.status === 'connecting' ? 'Connecting…' : 'Waiting for host approval'}</h1><Button className="cancel-button" variant="outline" onClick={() => engine.cancel()}>Cancel</Button></div>}
        {state.screen === 'outcome' && <div className="outcome-screen"><h1>{outcomes[state.outcome || 'ended']}</h1><Button className="outcome-button" onClick={() => { setJoinCode(''); setName(displayName('')); engine.home() }}>Back to home<ArrowRight aria-hidden="true" /></Button></div>}
      </main>
    </>}
    <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    <PrivacyDialog open={privacyOpen} onOpenChange={setPrivacyOpen} />
  </div>
}

function Room({ state, engine }: { state: RoomState; engine: RoomEngine }) {
  const [manualCopy, setManualCopy] = useState(false)
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [endOpen, setEndOpen] = useState(false)
  const [removePerson, setRemovePerson] = useState<Participant | null>(null)
  const [draft, setDraft] = useState('')
  const [scrolledUp, setScrolledUp] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messageEnd = useRef<HTMLDivElement>(null)
  const lastStatus = useRef(state.status)
  const [connected, setConnected] = useState(false)
  const link = inviteUrl(state.code)
  useEffect(() => {
    // Briefly confirm the connection instead of letting the "Connecting" banner just vanish.
    const was = lastStatus.current; lastStatus.current = state.status
    if (state.status !== 'online' || was === 'online') return
    setConnected(true)
    const timer = setTimeout(() => setConnected(false), 3000)
    return () => { clearTimeout(timer); setConnected(false) }
  }, [state.status])
  useEffect(() => {
    if (!scrolledUp || state.messages.at(-1)?.senderId === state.selfId) messageEnd.current?.scrollIntoView({ block: 'end' })
  }, [state.messages, state.selfId, scrolledUp])
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px` }
  }, [draft])
  function send(event?: FormEvent) {
    event?.preventDefault()
    if (engine.sendMessage(draft.trim())) { setDraft(''); setScrolledUp(false); textareaRef.current?.focus() }
  }
  const mobileLayout = useSyncExternalStore(subscribeToLayout, isMobileLayout)
  const identity = <div className="room-identity" role="group" aria-label="Room code"><strong>{state.code}</strong><CopyButton value={link} onFailure={() => setManualCopy(true)} onSuccess={() => setManualCopy(false)} /></div>
  const controls = <PeoplePanel state={state} engine={engine} identity={!mobileLayout && identity} onRemove={setRemovePerson} />
  return <>
    <AppHeader><RoomMenu state={state} engine={engine} onLeave={() => { if (state.isHost) setEndOpen(true); else engine.leave() }} /></AppHeader>
    {mobileLayout && <div className="room-toolbar">
      {identity}
      <Button variant="ghost" className="people-button" onClick={() => setPeopleOpen(true)} aria-label={`Participants: ${state.participants.length}${state.requests.length ? `. Requests: ${state.requests.length}.` : ''}`}>
        People<span>{state.requests.length > 0 ? `${state.requests.length} waiting` : `${state.participants.length} / ${MAX_PARTICIPANTS}`}</span>
      </Button>
    </div>}
    <div className="room-workspace"><main className="chat-main">{manualCopy && <div className="manual-copy"><Input aria-label="Invite link" readOnly value={link} onFocus={event => event.target.select()} /><p role="alert">Couldn’t copy the link. Select it and copy it manually.</p></div>}<h1 className="sr-only">Room {state.code}</h1>
      {(state.status !== 'online' || connected) && <div className="connection-banner" role="status">{state.status === 'online' ? <Wifi aria-hidden="true" /> : <WifiOff aria-hidden="true" />}<span>{state.status === 'online' ? 'Connected to the room.' : state.status === 'connecting' ? 'Connecting to the room…' : state.isHost ? 'Reconnecting. New people may be unable to join.' : 'Reconnecting for up to 2 minutes. Your messages will wait.'}</span></div>}
      <div className="message-scroll" ref={scrollRef} role="log" aria-label="Room messages" aria-live="polite" aria-relevant="additions" onScroll={() => { const el = scrollRef.current; if (el) setScrolledUp(el.scrollHeight - el.scrollTop - el.clientHeight > 100) }}>
        <div className="message-list">
          {state.messages.map((message, index) => {
            if (message.system) return <div key={message.id} className="system-message">{message.text}</div>
            const own = message.senderId === state.selfId
            const previous = state.messages[index - 1]
            const grouped = previous && !previous.system && previous.senderId === message.senderId && message.time - previous.time < 60_000
            return <div key={message.id} className={cn('message-row', own && 'own-message', grouped && 'grouped-message')}>
              <div className="message-content">{!grouped && <div className="message-meta">{!own && <span className="person-name">{message.name}</span>}<time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>}<div className={cn('message-bubble', message.pending && 'pending-message')}>{message.text}</div>{message.pending && state.status === 'online' && <span className="pending-caption">Sending…</span>}</div>
            </div>
          })}
        </div><div ref={messageEnd} />
      </div>
      <div className="composer-area">{scrolledUp && <Button className="latest-button" variant="secondary" onClick={() => { setScrolledUp(false); messageEnd.current?.scrollIntoView({ block: 'end' }) }}><ArrowDown aria-hidden="true" />Latest messages</Button>}{state.error && state.status === 'online' && <p className="composer-error" role="status">{state.error}</p>}<form className="composer" onSubmit={send}><Label htmlFor="message" className="sr-only">Message</Label><Textarea id="message" ref={textareaRef} placeholder="Message" value={draft} maxLength={MAX_MESSAGE_LENGTH} rows={1} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia('(pointer: fine)').matches) { event.preventDefault(); send() } }} /><Button size="icon" type="submit" className="send-button" disabled={!draft.trim()} aria-label="Send message"><ArrowRight aria-hidden="true" /></Button></form>{draft.length >= 3800 && <div className="composer-footer"><span className="message-counter near-limit">{draft.length.toLocaleString()} / 4,000</span></div>}</div>
    </main>{!mobileLayout && <aside className="desktop-sidebar">{controls}</aside>}</div>
    {mobileLayout && <Dialog open={peopleOpen} onOpenChange={setPeopleOpen}><DialogContent className="moment-dialog people-dialog" onEscapeKeyDown={event => { if (document.activeElement?.hasAttribute('data-rename')) event.preventDefault() }}><DialogHeader className="sr-only"><DialogTitle>Participants</DialogTitle><DialogDescription>View participants and manage requests to join.</DialogDescription></DialogHeader>{controls}</DialogContent></Dialog>}
    <Dialog open={endOpen} onOpenChange={setEndOpen}><DialogContent className="moment-dialog confirm-dialog"><DialogHeader><DialogTitle>End room?</DialogTitle><DialogDescription>Everyone will be disconnected and the chat cleared.</DialogDescription></DialogHeader><div className="confirm-actions"><Button variant="outline" onClick={() => setEndOpen(false)}>Cancel</Button><Button onClick={() => { setEndOpen(false); engine.leave() }}>End room</Button></div></DialogContent></Dialog>
    <Dialog open={!!removePerson} onOpenChange={open => { if (!open) setRemovePerson(null) }}><DialogContent className="moment-dialog confirm-dialog"><DialogHeader><DialogTitle>Remove {removePerson?.name}?</DialogTitle><DialogDescription>They’ll be disconnected and their chat will be cleared.</DialogDescription></DialogHeader><div className="confirm-actions"><Button variant="outline" onClick={() => setRemovePerson(null)}>Cancel</Button><Button onClick={() => { if (removePerson) engine.remove(removePerson.id); setRemovePerson(null) }}>Remove</Button></div></DialogContent></Dialog>
  </>
}
function PeoplePanel({ state, engine, identity, onRemove }: { state: RoomState; engine: RoomEngine; identity?: ReactNode; onRemove: (person: Participant) => void }) {
  const [renaming, setRenaming] = useState(false)
  return <div className="people-panel">
    {identity && <section className="panel-section">{identity}</section>}
    <section className="panel-section">
      <div className="sidebar-heading"><h2>People</h2><span>{`${state.participants.length} / ${MAX_PARTICIPANTS}`}</span></div>
      {state.participants.map(person => person.id === state.selfId && renaming
        // Enter or clicking away saves; Escape restores the old name first, so the blur save is a no-op.
        ? <div className="participant rename-row" key={person.id}>
          <Input aria-label="Your name" data-rename autoFocus maxLength={32} autoComplete="off" enterKeyHint="done" defaultValue={state.name} onFocus={event => event.target.select()}
            onBlur={event => { engine.rename(event.currentTarget.value); setRenaming(false) }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur()
              if (event.key === 'Escape') { event.currentTarget.value = state.name; event.currentTarget.blur() }
            }} />
        </div>
        : <div className={cn('participant', person.away && 'away')} key={person.id}>
          <span className="participant-name">{person.name}{person.id === state.selfId && <em> (you)</em>}</span>
          {person.host && <Crown className="host-mark" role="img" aria-label="Host" />}
          {person.away && <small>Away</small>}
          {state.isHost && person.host && <Button variant="ghost" size="icon" className="icon-action" onClick={() => setRenaming(true)} aria-label="Change your name"><Pencil aria-hidden="true" /></Button>}
          {state.isHost && !person.host && <Button variant="ghost" size="icon" className="icon-action" onClick={() => onRemove(person)} aria-label={`Remove ${person.name}`}><X aria-hidden="true" /></Button>}
        </div>)}
    </section>
    {state.isHost && state.requests.length > 0 && <section className="panel-section">
      <div className="sidebar-heading"><h2>Requests</h2><span>{state.requests.length}</span></div>
      {state.requests.map(request => <div className="participant" key={request.id}>
        <span className="participant-name">{request.name}</span>
        <Button variant="ghost" size="icon" className="icon-action" onClick={() => engine.decline(request.id)} aria-label={`Decline ${request.name}`}><X aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon" className="icon-action admit-action" onClick={() => engine.admit(request.id)} aria-label={`Admit ${request.name}`}><Check aria-hidden="true" /></Button>
      </div>)}
    </section>}
  </div>
}

// Room settings live behind a ⋯ button, using the native popover (light dismiss and Escape for free).
function RoomMenu({ state, engine, onLeave }: { state: RoomState; engine: RoomEngine; onLeave: () => void }) {
  const id = useId()
  const menu = useRef<HTMLDivElement>(null)
  return <>
    <Button variant="ghost" size="icon" className="room-menu-button" popoverTarget={`${id}menu`} aria-label="Room settings"><Ellipsis aria-hidden="true" /></Button>
    <div ref={menu} id={`${id}menu`} popover="auto" className="room-menu">
      {state.isHost && <>
        <div className="control-row"><Label htmlFor={`${id}auto-approve`}>Auto Admit</Label><Switch id={`${id}auto-approve`} checked={state.settings.autoApprove} onCheckedChange={value => engine.setAutoApprove(value)} /></div>
        <div className="control-row"><Label htmlFor={`${id}lock-entry`}>Lock Room</Label><Switch id={`${id}lock-entry`} checked={state.settings.locked} onCheckedChange={value => engine.setLocked(value)} /></div>
      </>}
      <Button variant="outline" className="leave-action" onClick={() => { menu.current?.hidePopover(); onLeave() }}>{state.isHost ? 'End room' : 'Leave room'}</Button>
    </div>
  </>
}
