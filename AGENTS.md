# AGENTS.md

Rules and must-knows for AI agents working in this repo. Tools, commands and
layout are in the code and README.md.

## Before you finish

- `npm run typecheck`, `npm test` and `npm run build` all pass.
- Tests assume the default config. `KIWI_*` variables in your shell (for
  example from a `.env` loaded by mise) break them. Run
  `env -u KIWI_SCREENSHOT_WIDTH -u KIWI_INVERT_SCROLL npm test`.
- Tests can't cover real hardware (serial timing, capture, how the target
  reacts to input). Verify those on a real Kiwi, or say plainly that you
  couldn't.
- Tool or setting changes also update README.md (Tools / Configuration tables)
  and `.env.example`.
- If your change makes anything in this file wrong, or adds something every
  agent must know, update this file in the same change.

## Rules

- The CLI, `npm run dev` / `npm run serve` and the MCP tools drive a real
  computer through the Kiwi. When testing a change, don't send input to it
  unless the user asked.
- The HTTP server binds to `127.0.0.1` only and checks the Host and Origin
  headers. Never loosen that: anyone who reaches the port controls the target
  computer.
- Never commit `.env`, screenshots, or identifiers from a real device (serial
  numbers, unique IDs). Use obvious placeholders.
- MCP tool handlers run inside `guarded()` or `act()` so the Kiwi is claimed
  first, and return `errorResult()` instead of throwing.
- `src/protocol.ts` stays pure (no I/O). A byte layout change ships with
  updated `test/protocol.test.ts` and `docs/PROTOCOL.md`.
- No em-dashes (—) anywhere: code, comments, docs, UI text, commit messages.

## Versioning

- Calendar versions `YYYY.M.N`, where `N` counts releases within the month from
  0. No leading zeros: npm rejects `2026.01.0`.
- The version lives only in `package.json`. Release with
  `npm version 2026.11.1 && git push --follow-tags`.
- Never amend or force-push a tagged commit.
