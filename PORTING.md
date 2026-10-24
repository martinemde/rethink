# Local enhancements on PR204

Current policy: historical HA migration is dropped, not pending. SideKick
fields and events are supported features, not provisional entities. Confidence
classification is removed; concrete mismatches belong in debugging notes.
Read the later scope-update sections as superseding the initial exclusions.
Current scope includes user-approved energy, SideKick provisional phases, total
time and completion; other raw diagnostic candidates remain excluded.

Base: upstream PR204 `e1f5b0d612435da15e5fcb8ee331cdf9a521251f`.
This branch is for offline review; it is not deployed.

## Scope

Keep upstream handlers, native property names, controls, captured fixtures and
Git ancestry. Port confirmed local mappings, exact completion notifications,
strict framing checks, explicit-only command safety, presentation improvements,
and command reconciliation/coalescing. Reject retained MQTT command replay.
Add passive SideKick support only for confirmed observations.

Do not import local raw-byte sensors, status-confidence diagnostics, provisional
energy/dosing interpretations or provisional SideKick completion. Existing
upstream fields are not removed merely because local evidence is incomplete.
No dependency upgrade or dirty lockfile is included.

## Operational boundaries

No startup/on-demand query, automatic ACK, retry, cloud bridge enablement or
synthetic appliance event is introduced. Only explicit supported commands may
write. Local safety opts laundry into fail-closed timeout handling while other
AABB models retain their previous defaults. Production configuration and
recorders are untouched.

This branch uses PR-native identities, not production's historical identity
layout. Deployment needs a separately reviewed HA migration and rollback plan;
checking registry presence alone is insufficient. No deployment is implied by
passing offline tests.

## Evidence

Exact-model local confirmed mappings are summarized in the sibling infrastructure
workspace `docs/rethink-confirmed-mappings.md`; full private captures are never
committed. Washer accepted E6 reply records precede older repeated EB reports
in the 2026-10-24 soil/buzzer observations. Dryer reply records may contain old
values: acceptance alone is not a reported-state echo.

## Review notes and exclusions

- SideKick's state names are restricted to confirmed Standby and TubClean
  Rinsing; other status values remain Unknown. Its provisional completion and
  total/energy candidates are deliberately excluded.
- Existing upstream washer dose enums and energy interpretations remain as in
  PR204. This port is not new physical verification of those upstream values.
- Presentation uses upstream component keys. No historical production entity
  migration, tombstones or private IDs are committed on this branch.
- Washer Total Time is the physically confirmed record byte16. Dryer uses its
  accepted existing duration field; no local candidate energy counters added.
- Automatic acknowledgements remain disabled for these laundry handlers; any
  future ACK experiment requires explicit approval and independent evidence.

## Command reconciliation policy

The existing wire reply timeout stays 3000ms. Laundry opts into blocking after
an unanswered write until handler recreation; other model defaults are unchanged.
Queued replaceable settings coalesce only before dispatch; actions are ordering
barriers and in-flight writes cannot be cancelled. Reply correlation is limited
by the protocol's unsequenced replies; property-set matching is required.

Confirmed setting protection is bounded to 30 seconds, a new engineering bound,
not a measured protocol latency. It must expire on mismatch and report the
conflict instead of hiding appliance state indefinitely. Course/power/session
boundaries invalidate old accepted overlays. Actual reply record values, not
requested echoes, are eligible for immediate reported-state publication.

The 30-second protection is evaluated when passive status is processed; it does
not schedule an appliance poll or manufacture a status event. A differing report
after expiry becomes authoritative and sets the existing Problem diagnostic.
Dryer accepted reply values that are unchanged/stale remain a private bundle
baseline; they do not become Home Assistant requested-value echoes.

## Known protocol limits

Replies do not carry a usable write sequence ID. Serialization and exact
property-set matching prevent many wrong matches but cannot distinguish an
otherwise identical duplicated same-property reply. Timeout therefore never
retries and blocks until handler recreation.

Washer remote-maintain has no E6 record confirmation. After an exact successful
command ACK, its requested value is shown as accepted, not observed. This assumes
result 0 acknowledges acceptance of the correlated request; it does not prove the
record bit changed. The raw record remains separate command context. Conflicting
reports are held for at most 30 seconds; a matching report clears the overlay,
and a mismatch after expiry publishes observed state with a diagnostic.

Accepted power still invalidates command context. Washer power feedback uses the
actual matched successful E6 record value, never a request guess. Dryer power
feedback requires both a matched successful E6 and a record agreeing with the
request; absent or stale records do not echo the requested power. Power feedback
has the same 30-second bound, without changing observed status/course or implying
that a cycle started. Course/session boundaries discard these overlays. Dryer
remote-maintain remains an observed-only standby sensor: its bit is state, not a
setting, and no new command is introduced. Start/Pause/Resume never echo state.
The existing 3000 ms fail-closed queue timeout and no-retry policy are unchanged.

## Validation and ancestry

Offline baseline: 1083 tests and TypeScript check passed. The enhanced final
suite is run before the commits are closed out, alongside TypeScript check,
native build and whitespace validation. Lockfile/dependencies are unchanged.
All appliance fixtures added here are synthetic or already upstream; private
captures and production identifiers are not committed.

Changes are separate commits atop PR204; no upstream history was replaced.
Model regressions cover exact property sets/headers, partial outcomes, latest
unsent setting ownership across action barriers, stale status/expiry, Off/course
boundaries (including downloaded-course identity), timeout lockout and malformed
frames. Presentation keeps PR-native IDs while adding verified icons and events.

Final offline result (2026-10-24): **1130/1130 tests passed**, TypeScript check,
native build and `git diff --check` passed. No dependency files changed.

## Energy scope update

User requested SideKick energy after the initial selective port. It now exposes
big-endian record bytes17/18 as `energy`, Wh, `total_increasing`, matching the
local candidate implementation. This is the user's selected interpretation,
not an independent calibration claim; previous energy-exclusion notes above
apply to the initial port. No other SideKick candidates were added.

Washer and dryer energy remain exactly upstream: washer LE16 at18, dryer BE16
at17. Washer local BE16 at17 was deliberately not applied pending user review.
The washer difference involves both offset and endianness, not endianness alone.

## Expanded user-authorized scope

The user subsequently requested the remaining provisional SideKick phases,
completion notification and total-time field, plus local energy decoding.
These additions intentionally supersede the initial conservative exclusions.
Washer energy now uses BE16 at17 (rather than upstream LE16 at18), dryer already
uses BE16 at17, and SideKick keeps BE16 at17. Units/statistics remain Wh and
`total_increasing`. Calibration is not claimed by the port itself.

SideKick's total-time LE16 at16 overlaps the high byte of the energy field at17;
the observed zero high total byte does not settle field width for all cycles.
Provisional phase labels and the completion signature retain that evidence limit.

Washer BE16@17 is supported by two saved within-run high-byte carries where
upstream LE16@18 drops backwards. See `ENERGY.md`; this establishes counter
layout evidence separately from Wh calibration.
