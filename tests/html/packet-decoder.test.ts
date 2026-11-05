import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodePacket as decodeBrowserPacket } from '../../html/packet-decoder.js'
// The browser module is plain JavaScript; assertions below check its output contract.
const decodePacket: (input: unknown, options?: { model?: string }) => any = decodeBrowserPacket
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
const washer = 'FAFXU22007',
    dryer = 'BDVG_FX0003_US'
test('strict hexadecimal, framing, short checksum and length validation', () => {
    const frame = short([0x20, 0xc3, 1, 2])
    assert.equal(decodePacket(frame).valid, true)
    for (const input of ['', 'a', 'aa xx bb', [256], frame.subarray(0, -1)])
        assert.equal(decodePacket(input).valid, false)
    for (const offset of [1, 4, frame.length - 2]) {
        const bad = Buffer.from(frame)
        bad[offset] ^= 1
        assert.equal(decodePacket(bad).valid, false)
        assert.equal(decodePacket(bad).status, null)
    }
    const decoded = decodePacket(frame.toString('hex'))
    assert.match(decoded.summary, /C3/)
    assert.deepEqual(decoded.unknowns[0].bytes, [1, 2])
})
test('washer E5 variable width does not shift subsequent properties', () => {
    const decoded = decodePacket(short([0xf0, 0xe5, 0, 2, 1, 0xff, 3, 0x7f, 1, 44, 0x13, 2, 0x1f, 14]), {
        model: washer,
    })
    assert.equal(decoded.valid, true)
    assert.deepEqual(
        decoded.fields.filter((f: any) => f.key.startsWith('property_')).map((f: any) => f.value),
        [300, 2, 14],
    )
    const unknown = decodePacket(short([0xf0, 0xe5, 0, 2, 1, 0xff, 1, 0xfe, 1, 2]), { model: washer })
    assert.deepEqual(unknown.unknowns[0].bytes, [0xfe, 1, 2])
})
test('dryer bundle minute width is two bytes', () => {
    const decoded = decodePacket(short([0xf0, 0xe5, 0, 2, 1, 0xff, 3, 0x20, 5, 0x70, 0, 60, 0x13, 4]), { model: dryer })
    assert.equal(decoded.valid, true)
    assert.deepEqual(
        decoded.fields.filter((f: any) => f.key.startsWith('property_')).map((f: any) => f.value),
        [5, 60, 4],
    )
})
test('E6 result tuples are one byte even for two-byte properties, followed by record', () => {
    const record = Array(51).fill(0)
    record[21] = 11
    const decoded = decodePacket(short([0x20, 0xe6, 0, 2, 1, 0xff, 2, 0x7f, 0x13, 0x13, 0, ...record]), {
        model: washer,
    })
    assert.equal(decoded.valid, true)
    assert.equal(decoded.status.source, 'E6')
    assert.equal(decoded.status.fields.find((f: any) => f.label === 'State').value, 11)
    assert.match(decoded.fields.find((f: any) => f.key === 'property_127').value, /busy/)
})
test('long EB CRC and both lengths validated; status is detached and includes unknown bytes', () => {
    const record = Array(42).fill(0)
    record[9] = 1
    record[10] = 2
    record[17] = 3
    record[18] = 4
    const frame = envelope(0x30, 0xeb, record)
    const decoded = decodePacket(frame, { model: dryer })
    assert.equal(decoded.valid, true)
    assert.equal(decoded.status.sequence, 0x1234)
    assert.equal(decoded.status.fields.find((f: any) => f.label === 'Remaining minutes').value, 258)
    assert.equal(decoded.status.fields.find((f: any) => f.label === 'Energy Wh').confidence, 'inferred')
    assert.ok(decoded.status.fields.some((f: any) => f.confidence === 'unknown'))
    frame[15] = 9
    assert.equal(decoded.status.record[0], 0)
    for (const offset of [4, 13, 16, frame.length - 3]) {
        const bad = envelope(0x30, 0xeb, record)
        bad[offset] ^= 1
        assert.equal(decodePacket(bad, { model: dryer }).valid, false)
    }
    const bad = envelope(0x30, 0xeb, record)
    bad[14]--
    bad.writeUInt16BE(crc16(bad.subarray(0, -3)), bad.length - 3)
    assert.equal(decodePacket(bad, { model: dryer }).status, null)
})
test('EC selects current half and preserves previous; bare EB supported', () => {
    const previous = Array(51).fill(0),
        current = Array(51).fill(0)
    previous[21] = 1
    current[21] = 14
    current[13] = 1
    current[14] = 2
    current[15] = 3
    current[16] = 4
    current[47] = 128
    const decoded = decodePacket(envelope(0x20, 0xec, [...previous, ...current]), { model: washer })
    assert.equal(decoded.valid, true)
    assert.equal(decoded.status.record[21], 14)
    assert.equal(decoded.status.fields.find((f: any) => f.label === 'Remaining minutes').value, 258)
    assert.equal(decoded.status.fields.find((f: any) => f.label === 'Total minutes').value, 772)
    assert.equal(decoded.status.fields.find((f: any) => f.label === 'Clock display').value, true)
    assert.equal(decoded.status.fields.find((f: any) => f.label === 'Clock display').width, 1)
    assert.deepEqual(
        decoded.segments.map((s: any) => s.start),
        decoded.segments.map((s: any) => s.start).sort((a: number, b: number) => a - b),
    )
    assert.equal(decoded.segments.find((s: any) => s.kind === 'previous').bytes[21], 1)
    assert.equal(decodePacket(short([0x20, 0xeb, ...current])).status.source, 'EB')
    assert.equal(decodePacket(envelope(0x20, 0xec, current)).valid, false)
})
test('receipt and delivery ACKs retain independent meanings', () => {
    assert.equal(decodePacket(short([0x20, 0, 0x24, 0])).summary, 'Receipt ACK')
    const ack = decodePacket(short([0xf0, 0, 0x0a, 4, 0x12, 0x34]))
    assert.equal(ack.valid, true)
    assert.equal(ack.summary, 'Delivery ACK')
    assert.equal(ack.fields.find((f: any) => f.key === 'sequence').value, 0x1234)
    assert.equal(decodePacket(short([0xf0, 0, 0xc3, 4])).valid, true)
})

test('washer EC validates both markers; dryer records do not require a zero marker', () => {
    const previous = Array(51).fill(0), current = Array(51).fill(0)
    previous[0] = 1
    assert.equal(decodePacket(envelope(0x20, 0xec, [...previous, ...current]), { model: washer }).valid, false)
    previous[0] = 0
    current[0] = 1
    assert.equal(decodePacket(envelope(0x20, 0xec, [...previous, ...current]), { model: washer }).valid, false)
    const dryerRecord = Array(42).fill(0)
    dryerRecord[0] = 7
    assert.equal(decodePacket(envelope(0x30, 0xeb, dryerRecord), { model: dryer }).valid, true)
    assert.equal(decodePacket(envelope(0x30, 0xec, [...dryerRecord, ...dryerRecord]), { model: dryer }).valid, true)
})
