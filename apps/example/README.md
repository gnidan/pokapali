# @pokapali/example

Example app for [Pokapali](../../docs/guide.md) — a
collaborative rich-text editor built with React, Tiptap,
and `@pokapali/core`.

## Running

```sh
npm run dev --workspace @pokapali/example
```

## Features

- **Create / open documents** via the landing page or
  by navigating to a capability URL
- **Recent documents** list persisted in localStorage
- **Rich-text editing** with Tiptap (Collaboration +
  CollaborationCursor)
- **Share panel** with copy-to-clipboard for admin,
  write, and read URLs, plus invite link generation
- **Connection status bar** showing IPFS peers, relay
  connectivity, editor count, and document sync state
- **Expandable diagnostics** panel with GossipSub stats,
  clock sum, IPNS sequence, and pinner ack count
- **Pinner ack display** — "Saved to N relay(s)" when
  relays confirm snapshot receipt
- **Auto-save** via `createAutoSaver()` — debounced
  snapshots, beforeunload prompt, visibility-change save
- **Auto-open** from capability URLs with cancel button
- **Reader ready timeout** — 60s fallback so readers
  aren't stuck on "Loading…" if fetch never completes
- **Accessibility** — aria-labels on all interactive
  elements, `aria-live` regions for status changes,
  `aria-expanded` on toggle buttons, focus management
  (share panel focus on open, name button focus on
  edit complete), visible text labels on status dots
- **Browser history** integration — pushState/popState
  for back/forward navigation between landing and docs
