import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Washer from '@/cloud/devices/FAFXU22007'
import Dryer from '@/cloud/devices/BDVG_FX0003_US'
import SideKick from '@/cloud/devices/MI2U7B'
import { MockHAConnection } from '@/tests/helpers/mocks'
import { MockLaundryDevice } from '@/tests/helpers/laundry'
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
        door: Buffer.from([0x0f, 0x0b, 0x01, 0x08, 0x0f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        finishLength: 99,
        finish: [12, 11, 1, 8, 12],
        doorKey: 'drawer',
    },
] as const

for (const c of cases)
    describe(`${c.modelId} live receipts and completion events`, () => {
        function setup() {
            const ha = new MockHAConnection()
            const meta = { modelId: c.modelId, modelName: 'Test', deviceType: '201' }
            const thinq = new MockLaundryDevice(c.modelId, meta)
            const dev = new c.Device(ha.asConnection(), thinq, meta)
            return { ha, thinq, dev, p: ha.devices[thinq.id].properties }
        }
        function receive(thinq: MockLaundryDevice, packet: Buffer) {
            thinq.onData(packet)
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
            assert.equal(p.load_waiting, undefined)
            assert.equal(p.last_report_at, undefined)
            assert.equal(p.last_door_report_at, undefined)
            assert.deepEqual(thinq.sent, [])
            assert.deepEqual(thinq.outbox, [])
            const unknown = frame(c.classByte, 0x86, Buffer.alloc(4), 0x1234)
            receive(thinq, unknown)
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
            for (const invalid of invalidFrames) receive(thinq, invalid)
            assert.equal(p.last_report_at, receipt)
            assert.equal(thinq.sent.length, 1)
            assert.equal(p.last_door_report_at, undefined)
            assert.equal(ha.devices[thinq.id].config!.components.last_report_at.platform, 'sensor')
        })

        test('processing failure leaves frame unacknowledged', (t) => {
            const { ha, thinq } = setup()
            const publish = ha.publishProperty.bind(ha)
            t.mock.method(ha, 'publishProperty', (id: string, key: string, value: string | number | undefined) => {
                if (key === 'status') throw new Error('publish failed')
                publish(id, key, value)
            })
            assert.throws(() => receive(thinq, active()), /publish failed/)
            assert.deepEqual(thinq.sent, [])
            assert.deepEqual(thinq.outbox, [])
        })

        test('ACK follows completion publication and does not replay events on discovery', (t) => {
            const { ha, thinq, dev } = setup()
            receive(thinq, active())
            const order: string[] = []
            const publish = ha.publishProperty.bind(ha)
            t.mock.method(ha, 'publishProperty', (id: string, key: string, value: string | number | undefined) => {
                order.push(key)
                publish(id, key, value)
            })
            thinq.on('sendData', (type) => {
                if (type === 'ack') order.push('ack')
            })
            const idle = Buffer.alloc(c.recordLength)
            idle[c.stateOffset] = 1
            receive(thinq, frame(c.classByte, 0xeb, idle))
            order.length = 0
            receive(thinq, active())
            assert.ok(order.indexOf('status') >= 0)
            assert.ok(order.indexOf('status') < order.indexOf('last_report_at'))
            assert.ok(order.indexOf('last_report_at') < order.indexOf('ack'))
            order.length = 0
            receive(thinq, finish())
            assert.ok(order.indexOf('cycle_finished') >= 0)
            assert.ok(order.indexOf('cycle_finished') < order.indexOf('last_report_at'))
            assert.ok(order.indexOf('last_report_at') < order.indexOf('ack'))
            order.length = 0
            dev.publishConfig()
            assert.equal(order.includes('cycle_finished'), false)
        })

        test('fresh repeated door receipts bypass value dedup without changing lifecycle', (t) => {
            let now = 1000
            t.mock.method(Date, 'now', () => now)
            const { ha, thinq, dev, p } = setup()
            const calls: string[] = []
            const original = ha.publishProperty.bind(ha)
            t.mock.method(ha, 'publishProperty', (id: string, key: string, value: string | number | undefined) => {
                calls.push(key)
                original(id, key, value)
            })
            const open = frame(c.classByte, 3, c.door)
            receive(thinq, open)
            assert.equal(p[c.doorKey], 'ON')
            assert.ok(calls.indexOf(c.doorKey) < calls.indexOf('last_door_report_at'))
            receive(thinq, finish()) // an unarmed startup retry is not a completion
            assert.equal(p.cycle_finished, undefined)
            now++
            receive(thinq, active())
            now++
            calls.length = 0
            receive(thinq, finish())
            assert.equal(calls.filter((key) => key === 'cycle_finished').length, 1)
            receive(thinq, finish())
            assert.equal(calls.filter((key) => key === 'cycle_finished').length, 1)
            // A new active receipt arms the next completion even if idle was missed.
            receive(thinq, active())
            receive(thinq, finish())
            assert.equal(calls.filter((key) => key === 'cycle_finished').length, 2)
            calls.length = 0
            const sends = thinq.sent.length
            const receipt = p.last_report_at
            dev.start()
            dev.publishConfig()
            assert.equal(p.last_report_at, receipt)
            assert.equal(calls.includes('last_report_at'), false)
            assert.equal(calls.includes('last_door_report_at'), false)
            assert.equal(calls.includes('cycle_finished'), false)
            assert.equal(thinq.sent.length, sends)
            now++
            calls.length = 0
            receive(thinq, open)
            assert.equal(p.last_report_at, new Date(now).toISOString())
            assert.equal(p.last_door_report_at, new Date(now).toISOString())
            assert.equal(calls.filter((key) => key === c.doorKey).length, 0)
            const next = setup()
            next.dev.start()
            receive(next.thinq, finish())
            assert.equal(next.p.cycle_finished, undefined)
            assert.equal(next.p.load_waiting, undefined)
            assert.equal(p.load_waiting, undefined)
            assert.equal(p.load_waiting_attributes, undefined)
            const components = ha.devices[thinq.id].config!.components
            assert.deepEqual(JSON.parse(JSON.stringify(components.load_waiting)), { platform: 'binary_sensor' })
            assert.deepEqual(JSON.parse(JSON.stringify(components.load_removed)), { platform: 'button' })
            assert.deepEqual(thinq.outbox, [])
        })
    })
