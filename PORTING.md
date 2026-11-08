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

## Clock display support (2026-10-31)

Source: `../upstream-review-2026-10-31.md` and trialskid's
[2026-10-26 PR204 comment](https://github.com/anszom/rethink/pull/204#issuecomment-6424596501),
reported for WM6700HBA / FAFXU22007 firmware 2.11.258. This is contributor
capture/acceptance evidence, not our own physical verification. Record indices
are assumed zero-based, consistent with the existing handler.

Washer adds one Configuration **Clock display** switch (`clock_display`),
E5 property `0x58`, values 0/1. Reported state is only record47 mask `0x80`.
Nozzle-clean mask `0x60` in the same byte and splash property `0x51` / record46
remain separate and unchanged. Clock participates in `RECORD_PROPERTIES`, the
existing serialized fail-closed queue, and bounded accepted-record reconciliation.
Only an actual matching successful E6 record supplies accepted clock feedback;
requested values are never echoed. The existing 30-second bound, course/Off
invalidation and 3000ms unanswered-write lockout remain unchanged.

At the user's explicit request, dryer adds Configuration **Hide clock** and
**Show clock** buttons (`hide_clock`, `show_clock`, empty press payload). These
assume the same E5 `0x58` boolean setter as the washer. **Dryer compatibility is
unverified**, and no dryer reported clock offset is established. There is no
dryer clock state, accepted-value overlay or optimistic requested echo. E6 replies
use existing exact-property matching to settle the queue and report refusal only.
The washer's record47 is not applied to the 42-byte dryer record.

All three controls explicitly use non-retained commands. Retained deliveries are
rejected by the existing MQTT router. Both models still require passive known
powered-on command context; hiding a clock while Off is rejected locally. No
automatic power-on, startup command, query, retry, time sync, ACK or clock change
was added. An Off dryer must first be powered on by the user and report valid
context before its button can send; this work must not be described as having
hidden either physical clock. Implementation and validation here were offline
with mocked transports; deployment/physical writes belong to a separate parent
operation.

The reviewed command strings were independently checked: both contain 13 bytes
(length `0x0d`), and the short checksum is the low 8 bits of the byte sum excluding
the checksum and final BB, XOR `0x55`. OFF's sum is `0xe7`, checksum `0xb2`;
ON's sum is `0xe8`, checksum `0xbd`. Thus the reviewed examples
`aa0df0e5000201ff015800b2bb` and `aa0df0e5000201ff015801bdbb` are checksum-valid.
These exact validated strings are tested; arbitrary unvalidated contributor
examples are not promoted to fixtures. New status/E6 cases are synthetic variants
of sanitized existing fixtures, not additional physical capture claims.

Enabling display is **not time synchronization** and does not fix the reported
`--:--` clock. No 12/24-hour or date controls, splash entries 12–14, dryer status
offset, or speculative clock protocol are added.

Changed constants: both models add `PROP_CLOCK_DISPLAY = 0x58`; washer adds
`CLOCK_DISPLAY_OFFSET = 47` and `CLOCK_DISPLAY_MASK = 0x80`. Existing constants,
framing/checksum algorithms, dependencies and lockfile are unchanged.

Initial clock implementation validation (subsequently committed as `c2591eb`):
**1152/1152 tests passed**, `mise exec -- npm run check`,
`GIT_REVISION=$(git rev-parse HEAD) mise exec -- npm run build` and
`git diff --check` passed. The build identifies the existing base HEAD `9f8e2b2`;
the feature edits were uncommitted at that validation point. Focused coverage includes invalid commands,
non-retained discovery/router delivery, checksum/length validation, mask isolation,
matched/refused/wrong-property E6 replies, actual-versus-requested values,
30-second expiry, matching status, queue coalescing, course/Off boundaries and
fail-closed timeout. No deployment or physical command was performed by this
implementation worker.

## Dryer clock display confirmation (2026-10-31)

This supersedes the earlier command-only dryer scope above. The user reported the
Charizard / BDVG_FX0003_US controls working ("It seems to work fine") and
reported a deliberate **off → on → off** test. Matching successful property
`0x58` E6 replies at
18:25:41.678, 18:25:52.543 and 18:25:55.639 UTC carried 42-byte records whose
record28 values were **3 → 35 → 3**. Comparing the full records changes only
record28 mask `0x20` apart from countdown/energy bytes. Existing KeepFresh
record28 mask `0x10` does not overlap.

Independent long-frame length and CRC16 validation found nearby EB record28=35
before the commands (18:25:33.863 UTC). EB remained35 at18:25:54.062 and
18:25:57.220, then became3 at18:26:11.961 and stayed3 through18:27:12.240.
Thus EB corroborates the final Off after delayed reporting; it did not capture
the brief first Off independently. Repeated identical reports are not additional
physical confirmations. Private captures and identities stay outside Git.

Dryer now exports one Configuration **Clock display** switch (`clock_display`),
replacing `hide_clock` / `show_clock` buttons entirely. E5 property `0x58` and
values0/1 remain unchanged; new constant `OPT5_CLOCK_DISPLAY = 0x20` uses existing
`OPT5_OFFSET = 28`. The washer's record47 mask0x80 remains model-specific.
Clock participates in dryer `recordValues`, normal reported-state publication
and bounded accepted-record reconciliation, without the old property0x58 skip.
An accepted reply only publishes clock feedback when its actual record matches
the request and differs from the pre-write observed baseline; requested values
alone never publish. Matching passive status can also confirm an accepted value.
The existing30-second confirmation bound, powered-on command gate, pending-intent
ownership, course/Off invalidation, retained-command rejection and3000ms
fail-closed unanswered-write lockout are unchanged. No compatibility routes for
the old buttons, automatic power-on, appliance queries, retries or ACKs were added.

Offline regressions cover every record28 bit in EB/current-half EC, nonoptimistic
switch discovery, removed buttons, exact commands/replies, refused/stale/absent
records, newer pending intent, delayed matching status, stale protection/expiry,
course/Off boundaries and timeout lockout. These generated fixture variants are
not extra physical evidence. This worker sent no appliance commands and performed
no commit, deployment or HA migration. Removing the two old button components
requires parent-owned explicit tombstones from the actual discovery envelope;
omission alone is not a migration.

Offline validation: **1158/1158 tests passed**, TypeScript check, native build
and `git diff --check` passed. No dependency or lockfile changes. The build
identifies existing base HEAD `c2591eb`; these edits are uncommitted.

## Integration observations, not laundry policy (2026-11-01)

This section supersedes the earlier no-ACK scope. The washer, dryer and SideKick
ACK strict-valid live frames **after** model processing. Retained appliance frames
are rejected before model delivery. No polling, query, settings or startup
commands were added.

The integration publishes observations: status, door/drawer, notification-only
`cycle_finished`, and diagnostic `last_report_at` / `last_door_report_at` receipt
timestamps. Generic receipt time is captured before model processing, then published after
interpretation and before ACK so HA can inspect the current status. Timestamp
publication bypasses value dedup; startup/discovery do not
fabricate receipts. Door/drawer value publishes before its receipt timestamp so
HA can inspect the current value when a repeated receipt triggers policy.
Receipt time is not a physical action time and cannot identify delayed old frames.

Completion uses a process-local latch: active arms, completion consumes the latch,
and Off/Standby disarms. A new active receipt after an accepted finish arms the
next cycle even if its idle boundary was missed, preserving the accepted lifecycle.
Repeated finish notifications without new active evidence remain consumed.
Discovery/broker reconnect does not replay events. A recreated handler or process
starts unarmed; restart-spanning completion dedup is deliberately not persisted.

Waiting-load expiry, pickup/clear rules, alerts and manual dismissal belong to
configurable Home Assistant policy. Native `load_waiting` and `load_removed` are
withdrawn with platform-only discovery tombstones; other components are preserved.
The historical `laundry-state.json` is no longer read or written. Leave any
production copy untouched; removal is not a deployment requirement.

## Confirmed time format and date display (2026-11-08)

The user confirmed reciprocal physical LG app tests on both models, with matched
E6 replies and current EC records. This supersedes the earlier exclusion of
12/24-hour and date controls; existing visibility property `0x58` is unchanged.
Only the relevant mappings are recorded here; complete packets and appliance
identities remain in private captures, not this repository.

| Setting      | E5 property/value                | Washer current record | Dryer current record |
| ------------ | -------------------------------- | --------------------- | -------------------- |
| Time format  | `0x59`: 0 = 12-hour, 1 = 24-hour | byte49 mask `0x02`    | byte28 mask `0x40`   |
| Date display | `0x5a`: 0 = Off, 1 = On          | byte49 mask `0x04`    | byte28 mask `0x80`   |

Both models expose `time_format` as a select and `date_display` as a switch,
alongside existing `clock_display`, all in Configuration. Changes require a
known powered-on context and **reported Clock display enabled**. The raw latest
status, not a requested/accepted visibility overlay, gates enqueue and dispatch.
An accepted visibility E6 alone does not unlock these setters until a subsequent
EB/EC confirms visibility; this conservative gate deliberately does not reuse the
bounded accepted-state overlay. A command queued before a hidden-clock report is
rejected when dispatched. No
command automatically enables the clock or powers on the appliance. Hiding the
clock does not clear or synthesize format/date readback.

These singleton properties join each model's existing matching-reply, bounded
30-second feedback and queue/arbitration paths. Washer overlays alter only each
field's mask; dryer reports/accepted feedback use separate property keys, keeping
Keep fresh and the visibility bit independent. The existing 3000ms fail-closed
timeout is unchanged. No polling, startup query, retry, time sync or new ACK
behavior is added. Packet inspector labels include both new fields.

Offline tests use synthetic variations of existing sanitized fixtures, not newly
claimed physical captures. They cover both values, hidden-clock readback,
EB/current EC selection, matching accepted/refused E6 feedback, exact singleton
checksums, invalid input, absent/Off context and dispatch-time visibility changes.
Implementation and validation send no appliance traffic; deployment and live HA
acceptance are separately owned by the parent operator.

## Confirmed dryer Smart Pairing command (2026-11-08)

`smart_pairing/set` is command-only, using the existing non-retained MQTT command
route; see README for exact topic, labels and last-reported idle gate. The body is
`F0 E5 00 01 01 FF 02 3D 01 0A <course>`, distinct from normal course-setting
header `00 02 01 FF`. The shared FIFO matches header family and exact property
sets for E6; transport receipts do not settle a write. Smart Pairing's 42-byte
reply record is deliberately excluded from normal accepted-course/option
reconciliation. No optimistic selected course, pending state, automatic pairing,
power-on/start, readback query or retry is introduced. Existing confirmation and
timeout constants, completion events and course mappings are unchanged.

Normal07 was captured from LG; Bedding04 and Towels02 were physically confirmed
in separately authorized one-shot tests. Property3D=01 is confirmed as part of the
whole command, not independently established as a flag. No pending-pairing bit,
clear command, expiry or downloaded-course encoding is established. Inspector
support explicitly recognizes this pairing header rather than relaxing normal
property header validation. Offline tests use synthetic strict frames based on
these confirmed bodies, not additional physical validation.
