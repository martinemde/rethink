import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodePacket as decodeBrowserPacket } from '../../html/packet-decoder.js'
import * as view from '../../html/packet-view.js'
// Both browser modules are plain JavaScript; assertions below check their output contracts.
const decodePacket: (input: unknown, options?: { model?: string }) => any = decodeBrowserPacket
const { annotatedText, chunkTitle, frameChunks, pressFrame, selectionBounds, transcriptLine } = view as any
import crc16 from '../../util/crc16'

function short(body: number[]) {
    const b = [0xaa, body.length + 4, ...body]
    return Buffer.from([...b, (b.reduce((a, b) => a + b, 0) & 255) ^ 0x55, 0xbb])
}
function envelope(classByte: number, type: number, payload: number[]) {
    const b = Buffer.from([
        0xaa,
        0xff,
        classByte,
        0x0a,
        0,
        0,
        0,
        0x12,
        0x34,
        0,
        1,
        1,
        type,
        payload.length >> 8,
        payload.length & 255,
        ...payload,
        0,
        0,
        0xbb,
    ])
    b.writeUInt16BE(b.length, 4)
    b.writeUInt16BE(crc16(b.subarray(0, -3)), b.length - 3)
    return b
}
const washer = 'FAFXU22007'

// Every byte appears in exactly one chunk, in order: what the stream draws is the whole frame.
function assertCovers(chunks: any[], length: number) {
    let at = 0
    for (const chunk of chunks) {
        assert.equal(chunk.start, at, 'chunk starts where the previous one ended')
        assert.ok(chunk.end > chunk.start, 'chunk is not empty')
        at = chunk.end
    }
    assert.equal(at, length)
}

test('chunks cover every byte of short, long, invalid and unrecognised frames', () => {
    const record = Array(51).fill(0)
    record[34] = 0x20 | 0x02
    record[13] = 0x01
    record[14] = 0x2e
    const frames = [
        short([0xf0, 0xe5, 0, 2, 1, 0xff, 1, 2, 1]),
        short([0x20, 0, 0xe5, 0]),
        short([0xf0, 0, 0x0a, 4, 0x7f, 0xc1]),
        short([0x20, 0xe6, 0, 2, 1, 0xff, 1, 2, 0x10, ...record]),
        envelope(0x20, 0xeb, record),
        envelope(0x20, 0xec, [...record, ...record]),
        short([0x20, 0xc3, 1, 2]),
        Buffer.from('aa0df0e5000201ff010201c8bb', 'hex'), // bad checksum
        Buffer.from('0102', 'hex'),
    ]
    for (const frame of frames) {
        const decoded = decodePacket(frame, { model: washer })
        assertCovers(frameChunks(decoded), frame.length)
    }
    assert.deepEqual(frameChunks(decodePacket('')), [])
})

test('status records split into fields, multi-byte values, flag bytes and unknown bytes', () => {
    const record = Array(51).fill(0)
    record[13] = 0x00
    record[14] = 0x2e
    record[34] = 0x20 | 0x02 // Turbo wash, plus a bit nothing maps
    record[22] = 0x09
    const decoded = decodePacket(envelope(0x20, 0xeb, record), { model: washer })
    assert.equal(decoded.valid, true)
    const chunks = frameChunks(decoded)
    const at = (recordOffset: number) => chunks.find((c: any) => c.recordOffset === recordOffset)

    const remaining = at(13)
    assert.equal(remaining.end - remaining.start, 2)
    assert.equal(remaining.type, 'u16 BE')
    assert.equal(remaining.kind, 'inferred')
    assert.equal(remaining.value, '46')

    const flags = at(34)
    assert.equal(flags.kind, 'flags-unknown')
    assert.match(flags.value, /Turbo wash on/)
    assert.match(flags.value, /unmapped bits set: 0x02/)
    assert.equal(flags.bits.length, 3)

    const unknown = chunks.find(
        (c: any) => c.kind === 'unknown' && c.recordOffset <= 22 && c.recordOffset + c.end - c.start > 22,
    )
    assert.equal(unknown.label, 'Unknown bytes 22–27')
    assert.equal(at(0).label, 'Record marker')
    assert.match(chunkTitle(unknown), /^Unknown bytes 22–27 \(unmapped\)\nbytes \d+–\d+$/)
    assert.match(chunkTitle(remaining), /Remaining minutes \(inferred\)\nbytes \d+–\d+ · u16 BE\n46/)
})

test('framing, type and checksum chunks are labelled; a bad checksum is flagged', () => {
    const good = frameChunks(decodePacket('aa0af0000a047fc1a7bb'))
    assert.deepEqual(
        good.map((c: any) => c.kind),
        ['frame', 'type', 'field', 'check', 'frame'],
    )
    assert.match(good[2].value, /Sequence: 32705/)
    assert.deepEqual(
        good.map((c: any) => c.type),
        ['2 bytes', '2 bytes', '4 bytes', 'u8', 'u8'],
    )
    const bad = frameChunks(decodePacket('aa0af0000a047fc1a8bb'))
    assert.ok(bad.some((c: any) => c.kind === 'bad'))
    assert.ok(bad.some((c: any) => c.kind === 'unknown' && c.label === 'Unvalidated body'))
})

test('transcript and annotated text keep the raw frame copyable', () => {
    assert.equal(transcriptLine('rx', 'aa082000e500e2bb'), 'D→R aa082000e500e2bb')
    assert.equal(transcriptLine('tx', 'aa0df0e5000201ff010201c7bb'), 'R→D aa0df0e5000201ff010201c7bb')
    const decoded = decodePacket('aa0df0e5000201ff010201c7bb', { model: washer })
    const text = annotatedText({
        number: 12,
        model: washer,
        time: '18:20:24',
        direction: 'tx',
        summary: decoded.summary,
        rawHex: decoded.rawHex,
        chunks: frameChunks(decoded),
    })
    const lines = text.split('\n')
    assert.equal(lines[1], 'aa0df0e5000201ff010201c7bb')
    assert.ok(lines.every((line: string, i: number) => i === 1 || line.startsWith('#')))
    assert.match(lines[0], /#12 · FAFXU22007 · 18:20:24 · Rethink → device · Property write \(E5\)/)
    assert.ok(lines.some((line: string) => /Power result|Power/.test(line)))
})

test('checkboxes toggle independently and Shift applies the clicked state across a range', () => {
    const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    let selection = pressFrame(null, 2)
    selection = pressFrame(selection, 5)
    assert.deepEqual([...selection.selected], [2, 5])
    selection = pressFrame(selection, 8, true, numbers)
    assert.deepEqual([...selection.selected].sort(), [2, 5, 6, 7, 8])
    selection = pressFrame(selection, 5, true, numbers)
    assert.deepEqual([...selection.selected], [2])
    selection = pressFrame(selection, 2)
    assert.equal(selectionBounds(selection), null)
    assert.equal(selectionBounds(null), null)
    // An unchecked anchor remains available for Shift-click, just like a checked one.
    selection = pressFrame(selection, 4, true, numbers)
    assert.deepEqual([...selection.selected], [2, 3, 4])
})

test('Shift ranges work upwards, skip hidden frames and start with one frame without an anchor', () => {
    const first = pressFrame(null, 8, true, [1, 3, 5, 8])
    assert.deepEqual([...first.selected], [8])
    const selection = pressFrame(first, 3, true, [1, 3, 5, 8])
    assert.deepEqual([...selection.selected].sort(), [3, 5, 8])
    assert.deepEqual(selectionBounds(selection), { low: 3, high: 8 })
})
