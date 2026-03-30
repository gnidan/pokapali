---
"@pokapali/core": patch
---

Wire Y.Doc edit bridge for P2P reconciliation

Bridge local Y.Doc edits to the epoch tree so the
reconciliation protocol has edits to send (send side).
Apply received reconciliation edits back to the Y.Doc
so remote changes appear in the editor (receive side).
Remove remote peer awareness states on data channel
close. Add transport send/receive diagnostic logging.
