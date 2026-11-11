import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import AABBDevice from '@/cloud/devices/aabb_device'
import { LaundryMultiplexer, type LaundryStream } from '@/cloud/devices/laundry_multiplexer'
import { txPacket, txAck, fromRxPacket } from '@/cloud/thinq2/clip'
import crc16 from '@/util/crc16'
import { buf } from '@/tests/helpers/mocks'
import { MockLaundryDevice } from '@/tests/helpers/laundry'
class MockThinq2Device extends MockLaundryDevice {
    inject(packet: Buffer) {
        this.onData(packet)
    }
}

// Captured fixtures from the imported WM6700HBA / DLEX6700B tests, not generated packets.
const W_REPLY = buf(
    'aa4020e6000201ff01130000030d0e0f2e00000000000000002e002e0001002e01000600000001150102002d1e20000000000c380000000000000401000491bb',
)
const D_REPLY = buf(
    'aa3730e6000201ff01131000030004002c00000000290029010000020000001b00000000000081030000000001000000000000000010bb',
)
const D_STATUS = buf(
    'aaff300a003c000294000100eb002a000000050015000000000a000a0100000200000412000000200000010300000000010000000000000000d9d1bb',
)
const CHIME = buf('aa0df0e5000201ff011301f6bb')
const COMMAND = buf('AA09F0241001018CBB')
const COMMAND_REPLY = buf('aa0820002400a3bb')
const QUERY = Buffer.from('F0ED112101000000180411120000', 'hex')

function setup(classByte = 0x20) {
    const dev = new MockThinq2Device('laundry', { modelId: 'test', modelName: 'test' })
    const mux = new LaundryMultiplexer(dev, classByte)
    dev.setMux(mux)
    const ha = dev.openStream() as LaundryStream
    const bridge = dev.openStream() as LaundryStream
    return { dev, mux, ha, bridge }
}

// The exceptional sequences below are synthetic. Replies are reframed only to test validation.
function frame(inner: Buffer) {
    return AABBDevice.frame(inner)
}
function alteredReply(change: (inner: Buffer) => void) {
    const inner = Buffer.from(W_REPLY.subarray(2, -2))
    change(inner)
    return frame(inner)
}

function longFrame(change: (packet: Buffer) => void) {
    const packet = Buffer.from(D_STATUS)
    change(packet)
    packet.writeUInt16BE(crc16(packet.subarray(0, -3)), packet.length - 3)
    return packet
}

describe('laundry shared multiplexer', () => {
    test('native non-device packet payloads fan out unchanged without releasing a laundry write', () => {
        const { dev, ha, bridge } = setup()
        bridge.send(txPacket(CHIME))
        ha.queueWrite(() => COMMAND.subarray(2, -2))
        const payload = Object.freeze({ cmd: 'custom_response', type: 7, data: { status: 'ready' } })
        const received: unknown[] = []
        ha.on('packet', (packet) => received.push(packet))
        bridge.on('packet', (packet) => received.push(packet))
        dev.onPacket(payload)
        assert.equal(received.length, 2)
        assert.ok(received.every((packet) => packet === payload))
        assert.deepEqual(dev.outbox, [CHIME])
        dev.inject(W_REPLY)
        assert.deepEqual(dev.outbox, [CHIME, COMMAND])
        dev.emit('close')
    })

    test('bridge writes, HA builders and commands share FIFO; all delivery precedes the next build', () => {
        const { dev, mux, ha, bridge } = setup()
        const body = Object.freeze({ ...txPacket(CHIME), extra: 'bridge metadata' })
        const sent: object[] = []
        dev.on('sendRawPacket', (message) => sent.push(message))
        let seen = 0
        let callback = 0
        ha.on('packet', () => {
            const answered = mux.writeAnswered(0xe5)
            assert.equal(answered?.stream, bridge)
            assert.deepEqual(answered?.inner, CHIME.subarray(2, -2))
            seen++
        })
        bridge.on('packet', () => seen++)
        bridge.send(body, (reply) => {
            assert.deepEqual(reply, W_REPLY)
            callback++
        })
        ha.queueWrite(() => {
            assert.equal(seen, 2)
            assert.equal(callback, 1)
            return COMMAND.subarray(2, -2)
        })
        bridge.send(txPacket(CHIME))
        assert.equal(dev.outbox.length, 1)
        dev.inject(W_REPLY)
        const { did, mid, ...forwarded } = sent[0] as typeof body & { did: string; mid: number }
        assert.equal(did, dev.id)
        assert.equal(typeof mid, 'number')
        assert.deepEqual(forwarded, body)
        assert.deepEqual(dev.outbox, [CHIME, COMMAND])
        assert.equal(mux.writeAnswered(0xe5), undefined)
        ha.removeAllListeners('packet')
        dev.inject(COMMAND_REPLY)
        assert.deepEqual(dev.outbox, [CHIME, COMMAND, CHIME])
        dev.emit('close')
    })

    test('synthetic cancellation builder does not send or obstruct the next write', () => {
        const { dev, ha, bridge } = setup()
        bridge.send(txPacket(CHIME))
        ha.queueWrite(() => undefined)
        ha.queueWrite(() => CHIME.subarray(2, -2))
        dev.inject(W_REPLY)
        assert.deepEqual(dev.outbox, [CHIME, CHIME])
        dev.emit('close')
    })

    test('synthetic malformed, wrong-class, wrong-property/count and unrelated frames never release E5', () => {
        const { dev, ha, bridge } = setup()
        bridge.send(txPacket(CHIME))
        ha.queueWrite(() => COMMAND.subarray(2, -2))
        const badChecksum = Buffer.from(W_REPLY)
        badChecksum[badChecksum.length - 2] ^= 1
        const badLength = Buffer.from(W_REPLY)
        badLength[1]--
        const got: Buffer[] = []
        ha.on('packet', (packet) => got.push(fromRxPacket(packet)!))
        const invalid = [
            badChecksum,
            badLength,
            W_REPLY.subarray(0, -1),
            alteredReply((i) => {
                i[0] = 0x30
            }),
            alteredReply((i) => {
                i[6] = 2
            }),
            alteredReply((i) => {
                i[7] = 2
            }),
            alteredReply((i) => {
                i[3] = 3
            }),
            COMMAND_REPLY,
            D_STATUS,
        ]
        for (const packet of invalid) dev.inject(packet)
        assert.deepEqual(got, invalid)
        assert.equal(dev.outbox.length, 1)
        dev.inject(W_REPLY)
        assert.deepEqual(dev.outbox, [CHIME, COMMAND])
        dev.emit('close')
    })

    test('dryer ED barrier requires a valid single-record status and updates both streams first', () => {
        const { dev, ha, bridge } = setup(0x30)
        let deliveries = 0
        ha.on('packet', () => deliveries++)
        bridge.on('packet', () => deliveries++)
        ha.queueWrite(() => QUERY)
        ha.queueWrite(() => {
            assert.equal(deliveries, 8)
            return CHIME.subarray(2, -2)
        })
        const corrupt = Buffer.from(D_STATUS)
        corrupt[corrupt.length - 3] ^= 1
        dev.inject(corrupt)
        dev.inject(
            longFrame((p) => {
                p[12] = 0xec
            }),
        )
        dev.inject(
            longFrame((p) => {
                p[4] = 1
            }),
        )
        assert.equal(dev.outbox.length, 1)
        dev.inject(D_STATUS)
        assert.equal(dev.outbox.length, 2)
        dev.inject(D_REPLY)
        dev.emit('close')
    })

    test('synthetic stream destruction cancels unsent work but preserves in-flight ownership', () => {
        const { dev, mux, ha, bridge } = setup()
        let cancelled = 0
        let replied = 0
        bridge.send(txPacket(CHIME), (reply) => {
            assert.deepEqual(reply, W_REPLY)
            replied++
        })
        bridge.send(txPacket(CHIME), (reply) => {
            assert.equal(reply, undefined)
            cancelled++
        })
        ha.queueWrite(() => COMMAND.subarray(2, -2))
        bridge.destroy()
        assert.equal(cancelled, 1)
        const later = dev.openStream()
        later.on('packet', () => assert.equal(mux.writeAnswered(0xe5)?.stream, bridge))
        dev.inject(W_REPLY)
        assert.equal(replied, 1)
        assert.deepEqual(dev.outbox, [CHIME, COMMAND])
        dev.emit('close')
    })

    test('synthetic timeout closes the physical session gate permanently, callbacks exactly once', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { dev, mux, ha, bridge } = setup()
        const replies: (Buffer | undefined)[] = []
        bridge.send(txPacket(CHIME), (r) => replies.push(r))
        ha.queueWrite(
            () => COMMAND.subarray(2, -2),
            (r) => replies.push(r),
        )
        t.mock.timers.tick(3000)
        assert.equal(replies.length, 2)
        assert.equal(replies.filter((reply) => reply !== undefined).length, 0)
        bridge.send(txPacket(CHIME), (r) => replies.push(r))
        ha.queueWrite(() => {
            assert.fail('failed-session builder must not run')
        })
        const later = dev.openStream()
        later.on('packet', () => assert.equal(mux.writeAnswered(0xe5), undefined))
        dev.inject(W_REPLY)
        t.mock.timers.tick(30000)
        assert.equal(dev.outbox.length, 1)
        assert.deepEqual(replies, [undefined, undefined, undefined])
        // Even replacing the mux on the same physical Device cannot create a new attribution domain.
        const replacement = new LaundryMultiplexer(dev, 0x20)
        replacement.openStream().send(txPacket(CHIME))
        assert.equal(dev.outbox.length, 1)
        dev.emit('close')
        assert.equal(dev.listenerCount('rawPacket'), 0)
        assert.equal(dev.listenerCount('close'), 0)
    })

    test('synthetic busy reply completes the owner then fails closed against duplicate busy replies', () => {
        const { dev, mux, ha, bridge } = setup()
        let completed = 0
        bridge.send(txPacket(CHIME), (r) => {
            assert.ok(r)
            completed++
        })
        ha.queueWrite(
            () => CHIME.subarray(2, -2),
            (r) => {
                assert.equal(r, undefined)
                completed++
            },
        )
        const busy = alteredReply((i) => {
            i[8] = 0x13
        })
        dev.inject(busy)
        assert.equal(completed, 2)
        ha.on('packet', () => assert.equal(mux.writeAnswered(0xe5), undefined))
        dev.inject(busy)
        bridge.send(txPacket(CHIME))
        assert.equal(dev.outbox.length, 1)
        dev.emit('close')
    })

    test('synthetic skipped-builder callback reentrancy cannot dispatch two active writes', () => {
        const { dev, ha, bridge } = setup()
        bridge.send(txPacket(CHIME))
        ha.queueWrite(
            () => undefined,
            () => ha.queueWrite(() => CHIME.subarray(2, -2)),
        )
        ha.queueWrite(() => COMMAND.subarray(2, -2))
        dev.inject(W_REPLY)
        assert.deepEqual(dev.outbox, [CHIME, COMMAND])
        dev.inject(COMMAND_REPLY)
        assert.deepEqual(dev.outbox, [CHIME, COMMAND, CHIME])
        dev.emit('close')
    })

    test('synthetic builder-triggered close cannot send after the session ends', () => {
        const { dev, ha } = setup()
        let calls = 0
        ha.queueWrite(
            () => {
                dev.emit('close')
                return CHIME.subarray(2, -2)
            },
            () => calls++,
        )
        assert.equal(dev.outbox.length, 0)
        assert.equal(calls, 1)
        assert.equal(dev.listenerCount('rawPacket'), 0)
    })

    test('synthetic streams opened during delivery do not receive the current packet', () => {
        const { dev, ha } = setup()
        let laterDeliveries = 0
        ha.once('packet', () => dev.openStream().on('packet', () => laterDeliveries++))
        dev.inject(W_REPLY)
        assert.equal(laterDeliveries, 0)
        dev.inject(W_REPLY)
        assert.equal(laterDeliveries, 1)
        dev.emit('close')
    })

    test('synthetic throwing busy listener cannot reopen the gate', () => {
        const { dev, ha, bridge } = setup()
        bridge.send(txPacket(CHIME))
        ha.queueWrite(() => CHIME.subarray(2, -2))
        ha.once('packet', () => {
            throw new Error('listener failed')
        })
        assert.throws(
            () =>
                dev.inject(
                    alteredReply((i) => {
                        i[8] = 0x13
                    }),
                ),
            /listener failed/,
        )
        ha.queueWrite(() => CHIME.subarray(2, -2))
        assert.equal(dev.outbox.length, 1)
        dev.emit('close')
    })

    test('synthetic malformed tracked bridge packets cannot bypass an active transaction', () => {
        const { dev, bridge } = setup()
        bridge.send(txPacket(CHIME))
        const malformed = Buffer.from(COMMAND)
        malformed[malformed.length - 2] ^= 1
        let rejected = 0
        bridge.send(txPacket(malformed), (reply) => {
            assert.equal(reply, undefined)
            rejected++
        })
        assert.equal(rejected, 1)
        assert.equal(dev.outbox.length, 1)
        dev.emit('close')
    })

    test('ACKs bypass the blocked FIFO and close removes timers and listeners', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { dev, ha, bridge } = setup()
        let calls = 0
        bridge.send(txPacket(CHIME), () => calls++)
        ha.queueWrite(
            () => COMMAND.subarray(2, -2),
            () => calls++,
        )
        const ack = txAck(COMMAND)
        bridge.send(ack)
        assert.deepEqual(
            dev.sent.filter((body) => body.cmd === 'ack'),
            [ack],
        )
        dev.emit('close')
        assert.equal(calls, 2)
        t.mock.timers.tick(3000)
        assert.equal(calls, 2)
        assert.equal(dev.listenerCount('rawPacket'), 0)
        assert.equal(dev.listenerCount('close'), 0)
    })
    test('model-native buzzer markers and dryer no-record E6 release the exact slot', () => {
        for (const classByte of [0x20, 0x30]) {
            const { dev, ha } = setup(classByte)
            const request = Buffer.from(CHIME.subarray(2, -2))
            request[5] = classByte === 0x20 ? 0x33 : 0x34
            ha.queueWrite(() => request)
            ha.queueWrite(() => COMMAND.subarray(2, -2))
            const reply = classByte === 0x20 ? W_REPLY : frame(Buffer.from([0x30, 0xe6, 0, 2, 1, 0xff, 1, 0x13, 0]))
            dev.inject(reply)
            assert.equal(dev.outbox.length, 2)
            dev.emit('close')
        }
    })

    test('keyed coalescing keeps unrelated choices and never crosses an action barrier', () => {
        const { dev, ha, bridge } = setup()
        bridge.send(txPacket(CHIME))
        const built: string[] = []
        const build = (name: string) => () => {
            built.push(name)
            return undefined
        }
        ha.queueWrite(build('old-a'), 'a')
        ha.queueWrite(build('b'), 'b')
        ha.queueWrite(build('new-a'), 'a')
        ha.queueWrite(build('action'))
        ha.queueWrite(build('after-action-a'), 'a')
        dev.inject(W_REPLY)
        assert.deepEqual(built, ['new-a', 'b', 'action', 'after-action-a'])
        dev.emit('close')
    })
})
