# @pokapali/core

## 0.1.2

### Patch Changes

- [#286](https://github.com/gnidan/pokapali/issues/286)
  [`c4231b4`](https://github.com/gnidan/pokapali/commit/c4231b42aa5ee2904cdbbec32cff1cf33f0d189d)
  Verify CID hash of blocks fetched from pinner
  HTTP tip endpoints. Rejects blocks whose content does
  not match the claimed CID, preventing acceptance of
  tampered or corrupted data.
- [#325](https://github.com/gnidan/pokapali/issues/325)
  [`7597cf0`](https://github.com/gnidan/pokapali/commit/7597cf00d2b4ff0a21c516b7775d2a42e8410eac)
  Add @deprecated JSDoc markers to implementation
  getters and methods for all deprecated APIs (provider,
  tipCid, ackedBy, guaranteeUntil, retainUntil,
  loadingState, on, off). IDEs now show strikethrough
  and deprecation warnings on usage.
- [#318](https://github.com/gnidan/pokapali/issues/318)
  [`8d9b97c`](https://github.com/gnidan/pokapali/commit/8d9b97c1ca52b9e3a918387c079639e0e370ba73)
  Document persistence:false for non-browser
  environments in guide.md and getting-started.md.
  [#319](https://github.com/gnidan/pokapali/issues/319) Document ready()
  timeout behavior: timeoutMs
  option and TimeoutError rejection in guide.md and
  getting-started.md.
  [#321](https://github.com/gnidan/pokapali/issues/321) Note
  createAutoSaver browser-only limitation in
  guide.md and integration-guide.md.
  [#322](https://github.com/gnidan/pokapali/issues/322) Document
  doc.urls.best tier selection logic
  (admin > write > read fallback) in guide.md.

## 0.1.2

### Patch Changes

- [#286](https://github.com/gnidan/pokapali/issues/286)
  [`c4231b4`](https://github.com/gnidan/pokapali/commit/c4231b42aa5ee2904cdbbec32cff1cf33f0d189d)
  Verify CID hash of blocks fetched from pinner
  HTTP tip endpoints. Rejects blocks whose content does
  not match the claimed CID, preventing acceptance of
  tampered or corrupted data.
- [#325](https://github.com/gnidan/pokapali/issues/325)
  [`7597cf0`](https://github.com/gnidan/pokapali/commit/7597cf00d2b4ff0a21c516b7775d2a42e8410eac)
  Add @deprecated JSDoc markers to implementation
  getters and methods for all deprecated APIs (provider,
  tipCid, ackedBy, guaranteeUntil, retainUntil,
  loadingState, on, off). IDEs now show strikethrough
  and deprecation warnings on usage.
- [#318](https://github.com/gnidan/pokapali/issues/318)
  [`8d9b97c`](https://github.com/gnidan/pokapali/commit/8d9b97c1ca52b9e3a918387c079639e0e370ba73)
  Document persistence:false for non-browser
  environments in guide.md and getting-started.md.
  [#319](https://github.com/gnidan/pokapali/issues/319) Document ready()
  timeout behavior: timeoutMs
  option and TimeoutError rejection in guide.md and
  getting-started.md.
  [#321](https://github.com/gnidan/pokapali/issues/321) Note
  createAutoSaver browser-only limitation in
  guide.md and integration-guide.md.
  [#322](https://github.com/gnidan/pokapali/issues/322) Document
  doc.urls.best tier selection logic
  (admin > write > read fallback) in guide.md.
