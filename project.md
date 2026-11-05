---
name: rethink-pr204
status: active
runtime: node-typescript
---

# PR204-based integration

Read `../project.md` before working. This independent checkout starts at
PR204 commit `e1f5b0d612435da15e5fcb8ee331cdf9a521251f`. On 2026-11-05 the integration
was rebased onto `d1c93c0811d8ece6aa657b6dca28598c0f47c50b`; current working branch
is `local/packet-monitor-current`, also reflected in local `main`. See
`../pr204-rebase-result-2026-11-05.md`. The preserved local implementation is `../ours`.
Do not wholesale overwrite upstream model handlers. Port verified improvements
in reviewed groups, preserving tests, upstream ancestry and investigation safety.
Production is unchanged. No ACK/query/startup/cloud behavior is authorized by
creating this checkout. Use mocked transports for offline tests.


## Current laundry boundary (2026-11-01)

User approved strict-valid live frame ACKs after processing for washer, dryer and
SideKick. No polling, queries, settings or startup commands. Native integration
exports observations and receipt diagnostics only; waiting/pickup/expiry/manual
clear policy belongs in Home Assistant. Completion uses process-local
active arming and retry dedup, allowing new active evidence to rearm after finish
even if an idle boundary was missed. `laundry-state.json` is unused and must remain
untouched on production. Only native `load_waiting` and `load_removed` discovery
components are withdrawn. See the final section of `PORTING.md`.
