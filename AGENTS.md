# AGENTS.md

Moment: browser-only, peer-to-peer temporary chat room (React 19 + Vite + PeerJS). Deployed to GitHub Pages at chat.zices.com.

## Commands
- `npm run dev` (127.0.0.1:5173, strict port)
- `npm test` (vitest), `npm run build` (`tsc -b` + vite build)
- CI runs `npm ci && npm test && npm run build` on Node 22. Both must pass.

## Privacy invariants (do not break)
- No message server. Chat payloads travel only over WebRTC data channels.
- STUN only, **never add TURN servers**: a TURN server could relay chat traffic.
- No persistence: Room state, resume tokens, message buffers, and file blobs live only in `RoomEngine` memory. Revoke every object URL when it is no longer shown.
- No new network endpoints or third-party scripts without asking.

## Architecture
- `src/lib/protocol.ts`: types, limits (`MAX_PARTICIPANTS`, `MAX_MESSAGE_LENGTH`, `MAX_FILES`, `MAX_FILE_SIZE`, `FILE_CHUNK`, `RECONNECT_MS`), validators, name sanitizers, room-code parsing.
- `src/lib/room.ts`: `RoomEngine`, the whole room state machine. Star topology: guests connect only to the host, and the host relays messages, renames, file chunks, and roster updates to everyone.
- Files ride the same JSON data channel: a `message` carries `files` metadata, then base64 `chunk`s follow in order (`FILE_CHUNK` keeps each under PeerJS's 16,300-byte limit). Guests ack a file event only after its bytes arrive, so the host resends unacked files after a reconnect.
- `src/App.tsx`: all screens. It reads the engine via `useSyncExternalStore(engine.subscribe, engine.getSnapshot)`.
- `src/components/ui/`: shadcn-style primitives. There is no shadcn CLI config, so edit them by hand.
- Dialogs: static info (About, Privacy) uses a native `<dialog>` via `showModal()`; interactive ones (people, confirmations) use the Radix `Dialog`.
- Peer IDs are `PEER_PREFIX + roomCode`. Invite links are `/<CODE>`, which works on Pages only because CI copies `index.html` to `404.html`.

## Rules
- Treat every inbound peer message as untrusted: check it with `isRecord` / `validId` / `validText` / `validFiles` before using it. Outgoing messages carry `v: 1`; bump the version only for breaking wire changes.
- Pass received names through `displayName` / `fileName` (they strip bidi and control characters). Preview a file inline only if `previewKind` allows its MIME type, and store blobs with `safeMime`; never preview SVG, HTML, or anything that can run script.
- Change limits only through the constants in `protocol.ts`.
- Protocol or engine changes need a matching case in `room.test.ts` or `protocol.test.ts`; UI behaviour goes in `App.test.tsx` (jsdom). Tests sit next to the source.
- Every export gets a TSDoc comment.
- Use the `@/` import alias for `src/`. Tailwind v4 is configured in `src/index.css` (`@theme`); there is no tailwind.config.
- Match the existing dense style. Add no new dependencies without asking.

## Design language
- Colours come only from the tokens in `:root` in `src/index.css`. No raw hex or rgb in components or rules; derive tints with `color-mix(in srgb, var(--token) N%, transparent)`.
- High contrast, dark only. Surfaces step up in lightness: `--background` (page) → `--card` (sidebar, bubbles, inputs, dialogs) → `--secondary` (own bubbles, menus, raised controls) → `--accent` (hover).
- Text: `--foreground` for content and headings; `--muted-foreground` only for secondary details (counts, timestamps, "(you)", "Away"). Keep ≥ 4.5:1 on every surface.
- `--primary` (#8fd0ff) is the single accent: primary buttons, links, focus, host crown, brand. `--violet` only tints the landing bubbles for own messages. `--danger` only for errors.
- Borders only on interactive controls (inputs, composer, outline buttons), using `--border`, which keeps ≥ 3:1 on every surface. No decorative dividers: separate sections with spacing or a surface step.
- People are told apart by name only: no avatars or initial circles. Names (sidebar, message sender, rename and name inputs) always use `--font-mono`. The host is marked with the crown icon, not a pill.
- Fonts are bundled so every device renders the same: DM Sans (`--font-sans`, everything) and DM Mono (`--font-mono`, names only). Don't add system font fallbacks.
- No all-caps micro-labels, no outlined pills or badges.
- Capitalisation: Title Case for buttons, links, toggles, menu items, and headings; sentence case for sentences (descriptions, status, errors).