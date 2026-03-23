# @pokapali/example

## 0.0.6

### Patch Changes

- [`a654419`](https://github.com/gnidan/pokapali/commit/a6544194c6988a4c7baa3a5bb1a896b11b399e6d)
  Import tokens.css in example app entry point so
  design token custom properties resolve at runtime
- [`af9235f`](https://github.com/gnidan/pokapali/commit/af9235f88bf35d913d9fbc830f0c22caba9df16c)
  Add example app stories glob to Storybook config and
  decompose ConnectionStatus into hook + presentational view
- [`bfc77c1`](https://github.com/gnidan/pokapali/commit/bfc77c1de78310dfb2c9adf0a5fda21c11fa5bf0)
  Replace deprecated component re-exports with local
  implementations using useSaveLabel, useLastUpdated,
  and useStatusLabel hooks from @pokapali/react.
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

## 0.0.5

### Patch Changes

- [`a5fb8a9`](https://github.com/gnidan/pokapali/commit/a5fb8a933486e96e2416d1b0b6945012367cead9)
  Adopt design tokens and rename BEM prefix from pkp- to poka-
- Updated dependencies
  - @pokapali/react@0.1.5

## 0.0.4

### Patch Changes

- [`2ac537e`](https://github.com/gnidan/pokapali/commit/2ac537e21f6c7b88c9360aa96d544ee4000e73ec)
  Replace unclear "Available" status label with "Loaded"
  in block requests drawer
- [`842ec6c`](https://github.com/gnidan/pokapali/commit/842ec6ccd997f418f724edfa7d054e7034be5f48)
  Reduce editor min-height so content drives height, cap
  connection status detail panel at 300px
- [`da64113`](https://github.com/gnidan/pokapali/commit/da64113f9d2c04350c4defbec4614ae0e4e123ff)
  Split header into two rows: identity (back, title,
  lock, badge, name) and toolbar (status, save,
  Share/History/Comments)
- Updated dependencies
  - @pokapali/core@0.1.6
  - @pokapali/comments@0.1.2

## 0.0.3

### Patch Changes

- [`d55f92b`](https://github.com/gnidan/pokapali/commit/d55f92b386f78c8772eed565633e39ec20d80a06)
  Distinguish archived from unavailable versions in version
  history — thinned versions show "archived" instead of
  "unavailable"
- [`4d7f81a`](https://github.com/gnidan/pokapali/commit/4d7f81ad58a95a3f09b99acd3e4b6c746d54edbe)
  Extract SaveIndicator and LastUpdated components to
  @pokapali/react with pkp- prefixed BEM classes, labels
  interface for i18n, and indicators.css stylesheet
- [`9cc4259`](https://github.com/gnidan/pokapali/commit/9cc42591a6e28f0f1e990e874d17edd7a42fcfbe)
  Extract StatusIndicator component to @pokapali/react with
  pkp- prefixed BEM classes, labels interface for i18n, and
  indicators.css stylesheet
- Updated dependencies
  - @pokapali/react@0.1.4
  - @pokapali/core@0.1.5

## 0.0.2

### Patch Changes

- [`aa2dc35`](https://github.com/gnidan/pokapali/commit/aa2dc3566cd06692d6d7a477d5a61e4bb14bf1a0)
  Migrate example app to use CommentSidebar, CommentPopover, and
  useComments from @pokapali/react instead of local copies
  ([#328](https://github.com/gnidan/pokapali/issues/328))
- Updated dependencies
  - @pokapali/core@0.1.4
  - @pokapali/comments-tiptap@0.1.2
  - @pokapali/react@0.1.3

## 0.0.1

### Patch Changes

- [#332](https://github.com/gnidan/pokapali/issues/332)
  [`d969b45`](https://github.com/gnidan/pokapali/commit/d969b45e5b57f5296e31eca73e491aa7c5129cdc)
  Keep block request details visible after load.
  Block request dropdown now shows all version entries
  including loaded ones (dimmed). SyncSummary persists
  with "N versions loaded" label.
- Updated dependencies
  - @pokapali/react@0.1.2
