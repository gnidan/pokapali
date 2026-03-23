# @pokapali/react

## 0.1.6

### Patch Changes

- [`33c69df`](https://github.com/gnidan/pokapali/commit/33c69df1f5ae6492fbde12f85a16db17f5ee96bb)
  Add useSaveLabel, useLastUpdated, and useStatusLabel hooks
  that extract indicator logic from the deprecated SaveIndicator,
  LastUpdated, and StatusIndicator components. Consumers can now
  build custom indicator UIs without depending on library markup.

## 0.1.5

### Patch Changes

- [`6015aa6`](https://github.com/gnidan/pokapali/commit/6015aa611dec9d0331d8bb7d3a2b1ab1ccf4fabd)
  Add design tokens (tokens.css) and Design System
  Storybook section with visual stories for type scale,
  status colors, text colors, backgrounds, borders,
  spacing, radii, and font weights
- [`68d1160`](https://github.com/gnidan/pokapali/commit/68d116059a91085e38d9d6bbd8c230e28de878c6)
  Fix SaveIndicator button font size: replace `font: inherit`
  with `font-family: inherit` so the CSS shorthand doesn't
  reset font-size from 0.75rem to the parent's size
- [`a5fb8a9`](https://github.com/gnidan/pokapali/commit/a5fb8a933486e96e2416d1b0b6945012367cead9)
  Adopt design tokens and rename BEM prefix from pkp- to poka-

## 0.1.4

### Patch Changes

- [`4d7f81a`](https://github.com/gnidan/pokapali/commit/4d7f81ad58a95a3f09b99acd3e4b6c746d54edbe)
  Extract SaveIndicator and LastUpdated components to
  @pokapali/react with pkp- prefixed BEM classes, labels
  interface for i18n, and indicators.css stylesheet
- [`9cc4259`](https://github.com/gnidan/pokapali/commit/9cc42591a6e28f0f1e990e874d17edd7a42fcfbe)
  Extract StatusIndicator component to @pokapali/react with
  pkp- prefixed BEM classes, labels interface for i18n, and
  indicators.css stylesheet
- [#363](https://github.com/gnidan/pokapali/issues/363)
  [`b6be158`](https://github.com/gnidan/pokapali/commit/b6be158e7cfe5c812d3171d6e5f00ee2e80e01c1)
  Default formatAuthor fallback shows "Anonymous"
  instead of truncated pubkey hex.
- [`378c99e`](https://github.com/gnidan/pokapali/commit/378c99e482d20c4c911233fbc98d8eb094323ef2)
  Revert "servers" back to "pinners" in SaveIndicator default labels

  "Pinner" is the correct domain term — it describes what the node does
  (pins your content). The rename to "servers" in !212 was a mistake.

- [`f8c4c46`](https://github.com/gnidan/pokapali/commit/f8c4c4697b1da0493ee6fb4e47790468dc9283df)
  Fix comment sidebar rendering too tall in Storybook by using
  top/bottom pinning instead of height: 100%
- [`40a2a99`](https://github.com/gnidan/pokapali/commit/40a2a999b8b30867b3ac366b4daffe0bd39284d5)
  Document SaveIndicator, LastUpdated, and
  StatusIndicator components in @pokapali/react README.
- [`1139d34`](https://github.com/gnidan/pokapali/commit/1139d349a7a33715b64445cd7dcb99523b253cab)
  Extract TopologyMap component from example app to @pokapali/react

  Adds TopologyMap with d3-force layout, particle animations, and SVG
  rendering. Leaked internals removed: no peer IDs on infra nodes, no
  guarantee halos/labels, simplified tooltips ("You", display names,
  "Relay/Pinner — connected/has your latest changes"). Includes
  TopologyMapLabels interface for i18n, topology-map.css stylesheet,
  and 6 stories (Just You, Two Editors, Full Network, Editor
  Disconnected, Server Down, Solo Offline).

- Updated dependencies
  - @pokapali/core@0.1.5

## 0.1.3

### Patch Changes

- [`4453b8a`](https://github.com/gnidan/pokapali/commit/4453b8a17dd817e15f08022e5abadc8b434c274e)
  Add comment UI components: CommentSidebar, CommentPopover, useComments
  hook, spatialLayout utility, i18n label interfaces with English
  defaults, and comments.css stylesheet with BEM pkp- naming
  ([#328](https://github.com/gnidan/pokapali/issues/328))
- [`f09a9f2`](https://github.com/gnidan/pokapali/commit/f09a9f2a804bd4cb7c80849306caee1ca8aa994c)
  Make remaining hardcoded English strings configurable via labels: add
  toolbarAriaLabel to CommentPopoverLabels and unverifiedSuffix to
  CommentSidebarLabels
  ([#329](https://github.com/gnidan/pokapali/issues/329))
- [#350](https://github.com/gnidan/pokapali/issues/350)
  [`9e0a14f`](https://github.com/gnidan/pokapali/commit/9e0a14f3d5403de5a0652f9e7d57f36f3b866a08)
  Update README with comment component docs:
  useComments hook, CommentSidebar, CommentPopover,
  labels/i18n system, CSS import, spatialLayout
  utility, and updated peer dependencies.
- Updated dependencies
  - @pokapali/core@0.1.4

## 0.1.2

### Patch Changes

- [#314](https://github.com/gnidan/pokapali/issues/314)
  [`ca36041`](https://github.com/gnidan/pokapali/commit/ca36041bf3e5da46e6b6829a44b5204f47fbbf25)
  Fix package.json metadata: update test-utils
  description to reflect consumer-facing status, add
  missing engines field to react.
