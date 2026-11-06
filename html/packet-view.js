// Pure presentation helpers for the monitor: turn a decodePacket() result into contiguous byte chunks that
// cover every byte of the frame exactly once, plus the plain-text forms people copy out of the page.
// No DOM access here, so the layout rules can be tested under node.

export const toHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
const spaced = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')

/** The packet's direction as both ends name it: `rx` is device → rethink, `tx` is rethink → device. */
export function directionTag(direction) {
    return direction === 'rx' ? 'D→R' : 'R→D'
}

export function directionLabel(direction) {
    return direction === 'rx' ? 'Device → rethink' : 'Rethink → device'
}

// Multi-byte values in packet-decoder.js are assembled most significant byte first.
function widthType(width) {
    if (width === 1) return 'u8'
    if (width === 2) return 'u16 BE'
    if (width === 4) return 'u32 BE'
    return width + ' bytes'
}

function formatValue(value) {
    if (value === true) return 'yes'
    if (value === false) return 'no'
    return String(value)
}

const SEGMENT_KINDS = {
    framing: 'frame',
    header: 'type',
    checksum: 'check',
    unknown: 'unknown',
    previous: 'previous',
}

function segmentChunk(segment) {
    const width = segment.end - segment.start
    let kind = SEGMENT_KINDS[segment.kind] || 'field'
    if (kind === 'check' && segment.fields[0] && segment.fields[0].value !== true) kind = 'bad'
    // Only a segment that is one field read whole is a number; anything else is a run of bytes.
    const single = segment.fields.length === 1 && segment.fields[0].raw.length === width
    const value =
        kind === 'check'
            ? 'valid'
            : kind === 'bad'
              ? 'does not match'
              : kind === 'previous'
                ? 'the record before this change; the current one follows'
                : segment.fields.map((f) => f.label + ': ' + formatValue(f.value)).join(' · ')
    return {
        start: segment.start,
        end: segment.end,
        kind,
        label: segment.label,
        type:
            kind === 'unknown' || kind === 'previous'
                ? ''
                : single || width === 1
                  ? widthType(width)
                  : width + ' bytes',
        value,
    }
}

// A status record is one decoder segment; split it into one chunk per field, flag byte or unknown byte.
function statusChunks(segment, status) {
    const chunks = []
    const base = segment.start
    const record = status.record
    let offset = 0
    while (offset < record.length) {
        const plain = status.fields.filter((f) => f.offset === offset && f.mask === undefined)
        const known = plain.find((f) => f.confidence !== 'unknown')
        const bits = status.fields.filter((f) => f.offset === offset && f.mask !== undefined)
        if (known) {
            const width = known.width || 1
            chunks.push({
                start: base + offset,
                end: base + offset + width,
                kind: known.confidence === 'inferred' ? 'inferred' : 'field',
                label: known.label + (known.confidence === 'inferred' ? ' (inferred)' : ''),
                type: widthType(width),
                value: formatValue(known.value),
                recordOffset: offset,
            })
            offset += width
            continue
        }
        if (bits.length) {
            const byte = record[offset]
            const mapped = bits.reduce((m, f) => m | f.mask, 0)
            const stray = byte & ~mapped & 0xff
            chunks.push({
                start: base + offset,
                end: base + offset + 1,
                kind: stray ? 'flags-unknown' : 'flags',
                label: 'Flags',
                type: 'bits',
                value:
                    bits.map((f) => f.label + ' ' + (f.value ? 'on' : 'off')).join(' · ') +
                    (stray ? ' · unmapped bits set: 0x' + stray.toString(16).padStart(2, '0') : ''),
                bits: bits.map((f) => ({ mask: f.mask, label: f.label, value: f.value })),
                unmappedMask: ~mapped & 0xff,
                recordOffset: offset,
            })
            offset += 1
            continue
        }
        if (offset === 0 && !plain.length) {
            chunks.push({
                start: base,
                end: base + 1,
                kind: 'frame',
                label: 'Record marker',
                type: 'u8',
                value: String(record[0]),
                recordOffset: 0,
            })
            offset += 1
            continue
        }
        // A run of bytes no field explains is one chunk, so it reads as one gap rather than a row of them.
        let end = offset + 1
        while (
            end < record.length &&
            !status.fields.some((f) => f.offset === end && (f.mask !== undefined || f.confidence !== 'unknown'))
        )
            end++
        chunks.push({
            start: base + offset,
            end: base + end,
            kind: 'unknown',
            label: end - offset > 1 ? 'Unknown bytes ' + offset + '–' + (end - 1) : 'Unknown byte ' + offset,
            type: '',
            value: '',
            recordOffset: offset,
        })
        offset = end
    }
    return chunks
}

/**
 * Contiguous chunks covering every byte of `decoded.rawHex`, in order. Bytes no segment explains become
 * `unknown` chunks rather than disappearing.
 */
export function frameChunks(decoded) {
    const length = decoded.rawHex.length / 2
    const pieces = []
    for (const segment of decoded.segments) {
        if (segment.kind === 'status' && decoded.status) pieces.push(...statusChunks(segment, decoded.status))
        else pieces.push(segmentChunk(segment))
    }
    pieces.sort((a, b) => a.start - b.start)
    const chunks = []
    let at = 0
    const gap = (end) => {
        if (end > at) chunks.push({ start: at, end, kind: 'unknown', label: 'Not decoded', type: '', value: '' })
    }
    for (const piece of pieces) {
        if (piece.end <= at) continue
        if (piece.start < at) piece.start = at
        gap(piece.start)
        chunks.push(piece)
        at = piece.end
    }
    gap(length)
    return chunks
}

export function chunkRange(chunk) {
    return chunk.end - chunk.start > 1 ? 'bytes ' + chunk.start + '–' + (chunk.end - 1) : 'byte ' + chunk.start
}

/** Hover text: what the bytes are, where they sit, how they are read and what they say. */
export function chunkTitle(chunk) {
    const label = chunk.kind === 'unknown' ? chunk.label + ' (unmapped)' : chunk.label
    const where = chunkRange(chunk) + (chunk.type ? ' · ' + chunk.type : '')
    return [label, where, chunk.value].filter(Boolean).join('\n')
}

/** One line per frame: `D→R aa08…bb`. */
export function transcriptLine(direction, rawHex) {
    return directionTag(direction) + ' ' + rawHex
}

/** The frame with a comment line per chunk; the raw hex line stays pasteable on its own. */
export function annotatedText(frame) {
    const bytes = frame.rawHex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []
    const head = ['#', frame.model || 'unknown model', '·', frame.time, '·', directionLabel(frame.direction)]
    if (frame.number !== undefined) head.splice(1, 0, '#' + frame.number, '·')
    if (frame.summary) head.push('·', frame.summary)
    const lines = [head.join(' '), frame.rawHex]
    for (const chunk of frame.chunks) {
        const raw = spaced(bytes.slice(chunk.start, chunk.end))
        const shown = raw.length > 23 ? raw.slice(0, 20) + '…' : raw
        const text = [chunk.label, chunk.type && '(' + chunk.type + ')', chunk.value].filter(Boolean).join(' ')
        lines.push('# ' + String(chunk.start).padStart(3) + '  ' + shown.padEnd(24) + text)
    }
    return lines.join('\n')
}

/** Toggle a checkbox, or apply its new state to the visible range from the last click. */
export function pressFrame(selection, number, shiftKey = false, numbers = [number]) {
    const selected = new Set(selection?.selected ?? [])
    const checked = !selected.has(number)
    const anchor = shiftKey && selection ? selection.anchor : number
    const low = Math.min(anchor, number)
    const high = Math.max(anchor, number)
    for (const n of shiftKey && selection ? numbers.filter((n) => n >= low && n <= high) : [number]) {
        if (checked) selected.add(n)
        else selected.delete(n)
    }
    return { anchor: number, selected }
}

export function selectionBounds(selection) {
    if (!selection?.selected.size) return null
    return { low: Math.min(...selection.selected), high: Math.max(...selection.selected) }
}
