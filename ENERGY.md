# Energy counter decoding evidence

Saved washer capture evidence supports **BE16 at record offset17**, rather than
upstream PR204's LE16 at offset18. Both the byte offset and byte order matter.
The accepted local decoding is now used by the washer handler.

## Observed counter carries

CRC/length-valid EB51 reports during the same TubClean run on2026-10-23 UTC:

| UTC (first received value) | Record bytes17–19 (hex) | BE16@17 | Upstream LE16@18 |
| --- | --- | ---: | ---: |
| 03:08:54.335 | `00 FC 00` | 252 | 252 |
| 03:09:10.260 | `01 00 00` | 256 | 0 |
| 03:24:31.934 | `01 E0 00` | 480 | 224 |
| 03:24:47.829 | `02 02 00` | 514 | 2 |

Course85 and state41 remain unchanged at both carries. These are EB reports,
not stale first halves of EC frames. Repeated receipts occurred between first
changes; do not interpret the last retry-to-next-report gap as measurement
cadence. Upstream loses the high byte and rolls backwards at both carries,
while BE16 preserves the increasing counter.

This is evidence for the **counter layout**. It does not independently prove
Wh calibration or every reset/accumulation rule. Byte19 was zero in the reviewed
records; no unrelated byte19-driven jump is claimed. Small values when both
bytes17 and19 are zero are identical under both formulas and cannot distinguish
them. The same washer evidence does not independently verify SideKick layout.

Private captures are not committed. Analysis used saved local snapshots only;
no appliance query, command, ACK or deployment was performed.

## Household energy cross-check (user observation)

The user reports an untracked household gap of about0.35kWh without the dryer,
and about0.65kWh during a period in which the dryer reports3kWh. Assuming similar
background untracked consumption, the incremental unexplained0.30kWh corresponds
to about10% of reported dryer energy (an implied correction near1.10x if all of
that increment were dryer under-reporting). This is a conditional estimate,
not a measured bound: background loads and comparison intervals may differ.

Working assumption: values are correctly scaled Wh, possibly with modest
calibration error. Do not apply a correction factor. An isolated dryer circuit
comparison is the planned way to verify calibration; no such test was performed
or authorized by this note. This household cross-check concerns the dryer and
does not independently calibrate the washer or SideKick.
