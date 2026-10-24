---
name: rethink-pr204
status: active
runtime: node-typescript
---

# PR204-based integration

Read `../project.md` before working. This independent checkout starts at
PR204 commit `e1f5b0d612435da15e5fcb8ee331cdf9a521251f` on branch
`local/pr204-improvements`. The preserved local implementation is `../ours`.
Do not wholesale overwrite upstream model handlers. Port verified improvements
in reviewed groups, preserving tests, upstream ancestry and investigation safety.
Production is unchanged. No ACK/query/startup/cloud behavior is authorized by
creating this checkout. Use mocked transports for offline tests.
