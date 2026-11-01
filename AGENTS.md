# AGENTS.md

Moment: browser-only, peer-to-peer temporary chatroom (React 19 + Vite + PeerJS). Deployed to GitHub Pages at chat.zices.com.

## Commands
- `npm run dev` (127.0.0.1:5173, strict port)
- `npm test` (vitest), `npm run build` (`tsc -b` + vite build)
- CI runs `npm ci && npm test && npm run build` on Node 22. Both must pass.

## Privacy invariants (do not break)
- No message server. Chat payloads travel only over WebRTC data channels.
- STUN only, **never add TURN servers**: a TURN server could relay chat traffic.
- No persistence: Room state, resume tokens, and message buffers live only in `RoomEngine` memory.
- No new network endpoints or third-party scripts without asking.

## Architecture
- `src/lib/protocol.ts`: types, limits (`MAX_PARTICIPANTS`, `MAX_MESSAGE_LENGTH`, `RECONNECT_MS`), validators, room-code parsing.
- `src/lib/room.ts`: `RoomEngine`, the whole room state machine. Star topology: guests connect only to the host, and the host relays messages and roster updates to everyone.
- `src/App.tsx`: all screens. It reads the engine via `useSyncExternalStore(engine.subscribe, engine.getSnapshot)`.
- `src/components/ui/`: shadcn-style primitives. There is no shadcn CLI config, so edit them by hand.
- Peer IDs are `PEER_PREFIX + roomCode`. Invite links are `/<CODE>`, which works on Pages only because CI copies `index.html` to `404.html`.

## Rules
- Treat every inbound peer message as untrusted: check it with `isRecord` / `validId` / `validText` before using it. Outgoing messages carry `v: 1`; bump the version only for breaking wire changes.
- Change limits only through the constants in `protocol.ts`.
- Protocol or engine changes need a matching case in `room.test.ts` or `protocol.test.ts` (tests sit next to the source).
- Use the `@/` import alias for `src/`. Tailwind v4 is configured in `src/index.css` (`@theme`); there is no tailwind.config.
- Match the existing dense style. Add no new dependencies without asking.