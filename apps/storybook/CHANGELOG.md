# @pokapali/storybook

## 0.1.3

### Patch Changes

- [`af9235f`](https://github.com/gnidan/pokapali/commit/af9235f88bf35d913d9fbc830f0c22caba9df16c)
  Add example app stories glob to Storybook config and
  decompose ConnectionStatus into hook + presentational view
- [`68c24a1`](https://github.com/gnidan/pokapali/commit/68c24a1726b1447373efd2a0be250fd820a45607)
  Add Storybook CSS overrides to neutralize absolute
  positioning on encryption popover, version history
  drawer, and block requests dropdown so components
  render in normal document flow within stories.
- [`a1205a6`](https://github.com/gnidan/pokapali/commit/a1205a689a0fbcc99fd8c7b93e749adc4024ea09)
  Move 3 pattern stories (HistoryPreview,
  NetworkDiagnostics, ShareAccess) and TopologyMap
  component story to example app, co-located with
  real components. Rewrite patterns to use
  VersionHistory, ConnectionStatusView, SharePanel,
  and EncryptionInfo directly instead of inline fakes.
- [`b4e6600`](https://github.com/gnidan/pokapali/commit/b4e6600cbc761af75f4c36653b6eb7c0f277fdfd)
  Move 5 component stories (ConnectionStatus, EncryptionInfo,
  SharePanel, ValidationWarning, VersionHistory) from storybook
  app to example app, co-located with real components. Rewrite
  to import actual components with prop-driven mock data.
- Updated dependencies
  - @pokapali/react@0.1.6

## 0.1.2

### Patch Changes

- [`6015aa6`](https://github.com/gnidan/pokapali/commit/6015aa611dec9d0331d8bb7d3a2b1ab1ccf4fabd)
  Add design tokens (tokens.css) and Design System
  Storybook section with visual stories for type scale,
  status colors, text colors, backgrounds, borders,
  spacing, radii, and font weights
- [`6359360`](https://github.com/gnidan/pokapali/commit/635936034b3a1d3f3b428e7de3c8dff77f190de8)
  Add bold weight and accent color specimens to Design System stories
- [`fe5232c`](https://github.com/gnidan/pokapali/commit/fe5232c70a54ac81dfd1986bcba36df8ab6c3081)
  Add component and pattern stories for full Storybook coverage
- Updated dependencies
  - @pokapali/react@0.1.5

## 0.1.1

### Patch Changes

- [`3a3f9ee`](https://github.com/gnidan/pokapali/commit/3a3f9ee8c6e050b4e53613506ebb24bf280cfd4a)
  Reduce comment sidebar story decorator height and trim
  ActiveConversation to 3 comments
- [`028fc6c`](https://github.com/gnidan/pokapali/commit/028fc6c7aac382b8304e29e89a6bf34d51696a5e)
  Add SaveIndicator, LastUpdated, and StatusIndicator stories
- [`e55dfb6`](https://github.com/gnidan/pokapali/commit/e55dfb6c2b2d3a8ea27efa25c5d2ea53c26e1d6d)
  Add apps/storybook package with Storybook 10, Vite workspace aliases,
  CI build integration, and co-located story support from packages/react
- Updated dependencies
  - @pokapali/react@0.1.4
  - @pokapali/core@0.1.5

## 0.1.1

### Patch Changes

- [`3a3f9ee`](https://github.com/gnidan/pokapali/commit/3a3f9ee8c6e050b4e53613506ebb24bf280cfd4a)
  Reduce comment sidebar story decorator height and trim
  ActiveConversation to 3 comments
- [`028fc6c`](https://github.com/gnidan/pokapali/commit/028fc6c7aac382b8304e29e89a6bf34d51696a5e)
  Add SaveIndicator, LastUpdated, and StatusIndicator stories
- [`e55dfb6`](https://github.com/gnidan/pokapali/commit/e55dfb6c2b2d3a8ea27efa25c5d2ea53c26e1d6d)
  Add apps/storybook package with Storybook 10, Vite workspace aliases,
  CI build integration, and co-located story support from packages/react
- Updated dependencies
  - @pokapali/react@0.1.4
  - @pokapali/core@0.1.5
