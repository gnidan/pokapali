---
---

fix: add deploy storage diagnostics

Deploy script now reads --storage-path from the systemd
service file and logs relay-key.bin and datastore presence
before proceeding. Gives visibility into relay storage
state during deploys.
