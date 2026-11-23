# Washer and dryer clock settings

FAFXU22007 (WM6700HBA) and BDVG_FX0003_US (DLEX6700B) expose two Configuration switches:

- **Clock 24 hour** (`time_format`): ON selects 24-hour time; OFF selects 12-hour time.
- **Clock date display** (`date_display`): ON shows the date; OFF hides it.

The existing **Clock on standby** (`current_time_display`, property `0x58`) is unchanged.
These switches do not synchronize time or fix an unset `--:--` clock.

## Confirmed protocol

The user confirmed reciprocal physical LG app tests on both models on 2026-11-08,
with matched E6 replies and current EC records. The original integration implementation
is martinemde/rethink commit `267c312a56b850bdf8c6e9d8ae296691be6fe09a`.
Raw captures and appliance identities remain private.

| Setting      | E5 singleton property            | Washer record      | Dryer record       |
| ------------ | -------------------------------- | ------------------ | ------------------ |
| 24-hour time | `0x59`: 0 = 12-hour, 1 = 24-hour | byte49 mask `0x02` | byte28 mask `0x40` |
| Date display | `0x5a`: 0 = hidden, 1 = shown    | byte49 mask `0x04` | byte28 mask `0x80` |

Writes use the existing `f0 e5 00 02 01 ff 01 <property> <value>` form and FIFO.
Only exact `ON` and `OFF` MQTT payloads are accepted. Commands require a passive
status reporting power on and Clock on standby enabled, checked both when queued
and when dispatched. This conservative command restriction is retained from the
physically validated integration, not claimed as an appliance-enforced interlock.
An accepted clock-visibility command alone does not enable the new setters.
No command automatically enables the clock or powers on the appliance.

Readback remains available while the clock is hidden. State comes from appliance
records, never from requested values. The washer keeps its existing E6 record
processing; the dryer reads accepted clock properties from the actual E6 record.
Existing FIFO reply attribution, transport validation and timeout behavior are
unchanged; this change does not claim stronger matching or transport guarantees.
No polling, startup query, retry, time synchronization, shared transport changes,
or automatic appliance actions are added.

Offline regression variants are explicitly synthetic mutations of existing
sanitized captured fixtures. They test decoding and command generation, not new
physical behavior. Preparing this contribution sent no appliance commands and did
not deploy anything.
