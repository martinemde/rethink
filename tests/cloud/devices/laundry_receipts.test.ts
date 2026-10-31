import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Washer from '@/cloud/devices/FAFXU22007'
import Dryer from '@/cloud/devices/BDVG_FX0003_US'
import SideKick from '@/cloud/devices/MI2U7B'
import { LaundryStateStore } from '@/cloud/laundry-state'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import crc16 from '@/util/crc16'

function frame(classByte: number, type: number, payload: Buffer, sequence = 1) {
    const frame = Buffer.alloc(payload.length + 18)
    frame.set([0xaa, 0xff, classByte, 0x0a])
    frame.writeUInt16BE(frame.length, 4)
    frame.writeUInt16BE(sequence, 7)
    frame[12] = type
    frame.writeUInt16BE(payload.length, 13)
    payload.copy(frame, 15)
    frame[frame.length - 1] = 0xbb
    frame.writeUInt16BE(crc16(frame.subarray(0, -3)), frame.length - 3)
    return frame
}

const cases = [
    {
        modelId: 'FAFXU22007',
        Device: Washer,
        classByte: 0x20,
        recordLength: 51,
        stateOffset: 21,
        active: 11,
        door: Buffer.from([0x10, 0x0b, 1, 0x0b, 0x10, 1]),
        finishLength: 121,
        finish: [8, 11, 1, 11, 8, 2],
        doorKey: 'door',
    },
    {
        modelId: 'BDVG_FX0003_US',
        Device: Dryer,
        classByte: 0x30,
        recordLength: 42,
        stateOffset: 13,
        active: 7,
        door: Buffer.from([0x0a, 0x0a, 2, 4, 0x0a, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]),
        finishLength: 28,
        finish: [3, 10, 2, 4, 3, 3],
        doorKey: 'door',
    },
    {
        modelId: 'MI2U7B',
        Device: SideKick,
        classByte: 0x20,
        recordLength: 49,
        stateOffset: 21,
        active: 12,
        door: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        finishLength: 99,
        finish: [12, 11, 1, 8, 12],
        doorKey: 'drawer',
    },
] as const

for (const c of cases)
    describe(`${c.modelId} live receipts and shared laundry state`, () => {
        function setup(store = new LaundryStateStore()) {
            const ha = new MockHAConnection()
            const meta = { modelId: c.modelId, modelName: 'Test', deviceType: '201' }
            const thinq = new MockThinq2Device(c.modelId, meta)
            const dev = new c.Device(ha.asConnection(), thinq, meta, store)
            return { ha, thinq, dev, store, p: ha.devices[thinq.id].properties }
        }
        function active() {
            const payload = Buffer.alloc(c.recordLength)
            payload[c.stateOffset] = c.active
            return frame(c.classByte, 0xeb, payload)
        }
        function finish() {
            const payload = Buffer.alloc(c.finishLength)
            payload.set(c.finish)
            return frame(c.classByte, 3, payload)
        }

        test('startup/reconnect never fabricate receipts; validated unknown frames ACK after no-op interpretation', (t) => {
            let now = 1000
            t.mock.method(Date, 'now', () => now)
            const { ha, thinq, dev, p } = setup()
            dev.start()
            dev.publishConfig()
            assert.equal(p.load_waiting, 'None')
            assert.equal(p.last_report_at, undefined)
            assert.equal(p.last_door_report_at, undefined)
            assert.deepEqual(thinq.sent, [])
            assert.deepEqual(thinq.outbox, [])
            const unknown = frame(c.classByte, 0x86, Buffer.alloc(4), 0x1234)
            thinq.emit('data', unknown)
            assert.equal(p.last_report_at, new Date(now).toISOString())
            assert.deepEqual(thinq.sent, [{ cmd: 'ack', type: 1, data: 'AA0AF0000A041234ADBB' }])
            const receipt = p.last_report_at
            const bad = Buffer.from(unknown)
            bad[15] ^= 1
            const invalidFrames = [bad, unknown.subarray(0, -1), Buffer.alloc(0)]
            // Recompute CRC so these exercise header validation, not checksum rejection.
            for (const offset of [2, 5, 14]) {
                const malformed = Buffer.from(unknown)
                malformed[offset] ^= 1
                malformed.writeUInt16BE(crc16(malformed.subarray(0, -3)), malformed.length - 3)
                invalidFrames.push(malformed)
            }
            now++
            for (const invalid of invalidFrames) thinq.emit('data', invalid)
            assert.equal(p.last_report_at, receipt)
            assert.equal(thinq.sent.length, 1)
            assert.equal(p.last_door_report_at, undefined)
            assert.equal(ha.devices[thinq.id].config!.components.last_report_at.platform, 'sensor')
        })

        test('persistence failure leaves completion unacknowledged for retry', (t) => {
            const { thinq, store } = setup()
            thinq.emit('data', active())
            thinq.resetRecorder()
            const failure = t.mock.method(store, 'complete', () => {
                throw new Error('disk unavailable')
            })
            assert.throws(() => thinq.emit('data', finish()), /disk unavailable/)
            assert.deepEqual(thinq.sent, [])
            assert.deepEqual(thinq.outbox, [])
            assert.equal(store.get(thinq.id).armed, true)
            failure.mock.restore()
            thinq.emit('data', finish())
            assert.equal(store.get(thinq.id).waiting, true)
            assert.equal(thinq.sent.length, 1)
        })

        test('fresh repeated open receipts clear waiting before value-cache dedup, not a fabricated edge', (t) => {
            let now = 1000
            t.mock.method(Date, 'now', () => now)
            const { ha, thinq, dev, p, store } = setup()
            const calls: string[] = []
            const original = ha.publishProperty.bind(ha)
            t.mock.method(ha, 'publishProperty', (id: string, key: string, value: string | number | undefined) => {
                calls.push(key)
                original(id, key, value)
            })
            const open = frame(c.classByte, 3, c.door)
            thinq.emit('data', open)
            assert.equal(p[c.doorKey], 'ON')
            thinq.emit('data', finish()) // unarmed startup retry is not a completion
            assert.equal(store.get(thinq.id).waiting, null)
            now++
            thinq.emit('data', active())
            now++
            calls.length = 0
            thinq.emit('data', finish())
            assert.equal(p.load_waiting, 'ON')
            assert.ok(calls.indexOf('load_waiting/attributes') < calls.indexOf('load_waiting'))
            const attributes = JSON.parse(p['load_waiting/attributes'] as string)
            assert.equal(attributes.finished_ts, new Date(now).toISOString())
            const finished = store.get(thinq.id).completionReceivedAt
            // Simulate loss of retained broker state without losing the integration's cache.
            delete p.load_waiting
            delete p['load_waiting/attributes']
            calls.length = 0
            const sends = thinq.sent.length
            dev.publishConfig()
            assert.equal(p.load_waiting, 'ON')
            assert.equal(JSON.parse(p['load_waiting/attributes'] as string).finished_ts, attributes.finished_ts)
            assert.ok(calls.indexOf('load_waiting/attributes') < calls.indexOf('load_waiting'))
            assert.equal(calls.includes('last_report_at'), false)
            assert.equal(calls.includes('last_door_report_at'), false)
            assert.equal(calls.includes('cycle_finished'), false)
            assert.equal(thinq.sent.length, sends)
            thinq.emit('data', finish())
            assert.equal(store.get(thinq.id).completionReceivedAt, finished)
            // Same physical value and even same sequence: this is a later live receipt, not a new edge.
            now++
            calls.length = 0
            thinq.emit('data', open)
            assert.equal(p.load_waiting, 'OFF')
            assert.equal(p.last_door_report_at, new Date(now).toISOString())
            assert.equal(calls.filter((key) => key === c.doorKey).length, 0)
            const next = setup(store)
            next.dev.start()
            assert.equal(next.p.load_waiting, 'OFF')
            assert.equal(next.p.last_report_at, undefined)
            next.thinq.emit('data', finish())
            assert.equal(next.p.load_waiting, 'OFF')
            assert.equal(next.p.cycle_finished, undefined)
            const sentBeforeCommand = thinq.sent.length
            dev.setProperty('load_removed', '')
            assert.equal(p.load_waiting, 'OFF')
            assert.equal(thinq.sent.length, sentBeforeCommand)
            assert.deepEqual(thinq.outbox, [])
        })
    })
