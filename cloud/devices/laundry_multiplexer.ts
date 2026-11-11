import AABBDevice from './aabb_device'
import { T2Multiplexer } from '../thinq2/multiplexer'
import { Device } from '../thinq2/device'
import { StreamBase, type Stream } from '../thinq2/multiplexer'
import { fromRxPacket, txPacket, type ClipPayload } from '../thinq2/clip'
import crc16 from '@/util/crc16'

type Callback = (response?: Buffer) => void
type Write = { stream: LaundryStream; inner: Buffer; body: ClipPayload; callback?: Callback }
type Pending = {
    stream: LaundryStream
    build: () => { inner: Buffer; body: ClipPayload } | undefined
    callback?: Callback
    coalescingKey?: string
}

// A timeout leaves replies without an owner. Only a new physical session can restore attribution.
const failedSessions = new WeakSet<Device>()
const WRITE_TIMEOUT = 3000

function unframe(packet: Buffer): Buffer | undefined {
    if (packet.length < 6 || packet[0] !== 0xaa || packet[packet.length - 1] !== 0xbb) return
    if (packet[1] === 0xff) {
        if (packet.length < 9 || packet.readUInt16BE(4) !== packet.length) return
        if (crc16(packet.subarray(0, -3)) !== packet.readUInt16BE(packet.length - 3)) return
        return packet.subarray(2, -3)
    }
    if (packet[1] !== packet.length) return
    const sum = packet.subarray(0, -2).reduce((a, b) => a + b, 0)
    if (((sum & 0xff) ^ 0x55) !== packet[packet.length - 2]) return
    return packet.subarray(2, -2)
}

// E5 values are byte-wide except for the dry/reservation time fields in captured bundles.
function properties(inner: Buffer, classByte: number): number[] | undefined {
    if (inner.length < 7) return
    const normal = inner.subarray(2, 5).equals(Buffer.from([0, 2, 1]))
    const pairing = classByte === 0x30 && inner.subarray(2, 6).equals(Buffer.from([0, 1, 1, 0xff]))
    if (!normal && !pairing) return
    if (inner[5] !== 0xff && inner[5] !== (classByte === 0x20 ? 0x33 : 0x34)) return
    const props: number[] = []
    let at = 7
    for (let i = 0; i < inner[6]; i++) {
        const prop = inner[at]
        if (prop === undefined || props.includes(prop)) return
        props.push(prop)
        at += prop === (classByte === 0x30 ? 0x70 : 0x7f) ? 3 : 2
    }
    if (at !== inner.length) return
    return props
}

export class LaundryStream extends StreamBase {
    destroyed = false
    onFailure?: (writes: readonly { stream: LaundryStream; inner: Buffer }[]) => void

    constructor(readonly mux: LaundryMultiplexer) {
        super()
    }

    send(body: ClipPayload, callback?: Callback) {
        if (this.destroyed) return callback?.()
        this.mux.send(this, body, callback)
    }

    queueWrite(builder: () => Buffer | undefined, keyOrCallback?: string | Callback, callback?: Callback) {
        const coalescingKey = typeof keyOrCallback === 'string' ? keyOrCallback : undefined
        if (typeof keyOrCallback === 'function') callback = keyOrCallback
        if (this.destroyed) return callback?.()
        this.mux.enqueue({
            stream: this,
            build: () => {
                const inner = builder()
                return inner && { inner: Buffer.from(inner), body: txPacket(AABBDevice.frame(inner)) }
            },
            callback,
            coalescingKey,
        })
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.mux.remove(this)
        this.removeAllListeners()
    }
}

/** The two laundry protocols have no transaction IDs: bridge and HA must share one FIFO. */
export class LaundryMultiplexer extends T2Multiplexer {
    private streams = new Set<LaundryStream>()
    private queue: Pending[] = []
    private active?: Write
    private completed?: Write
    private timer?: ReturnType<typeof setTimeout>
    private delivering = false
    private draining = false
    private closed = false

    constructor(
        dev: Device,
        readonly classByte: number,
    ) {
        super(dev)
        dev.on('rawPacket', this.onPacket)
        dev.on('close', this.onClose)
    }

    override openStream(): LaundryStream {
        const stream = new LaundryStream(this)
        if (!this.closed) this.streams.add(stream)
        else stream.destroyed = true
        return stream
    }

    get writesBlocked() {
        return failedSessions.has(this.dev)
    }

    writeAnswered(type: number): { stream: Stream; inner: Buffer } | undefined {
        if (this.completed?.inner[1] === type) return this.completed
    }

    private tracked(inner: Buffer) {
        return (
            inner[0] === 0xf0 &&
            (inner[1] === 0xe5 || inner[1] === 0x24 || (this.classByte === 0x30 && inner[1] === 0xed))
        )
    }

    send(stream: LaundryStream, body: ClipPayload, callback?: Callback) {
        const message = body as { cmd?: string; data?: unknown }
        const packet =
            message.cmd === 'packet' && typeof message.data === 'string' ? Buffer.from(message.data, 'hex') : undefined
        const inner = packet && unframe(packet)
        // A malformed tracked packet must not bypass serialization and reach the appliance.
        if (packet && this.tracked(packet.subarray(2)) && !inner) return callback?.()
        if (inner && this.tracked(inner)) {
            // Retain the bridge body verbatim; never rebuild it from HA's state.
            this.enqueue({ stream, build: () => ({ inner: Buffer.from(inner), body }), callback })
        } else {
            if (!this.closed) this.dev.sendRaw(body)
            callback?.()
        }
    }

    enqueue(pending: Pending) {
        if (this.closed || failedSessions.has(this.dev)) return pending.callback?.()
        if (pending.coalescingKey !== undefined) {
            for (let i = this.queue.length - 1; i >= 0; i--) {
                const entry = this.queue[i]
                if (entry.coalescingKey === undefined) break
                if (entry.stream === pending.stream && entry.coalescingKey === pending.coalescingKey) {
                    this.queue[i] = pending
                    return
                }
            }
        }
        this.queue.push(pending)
        this.drain()
    }

    remove(stream: LaundryStream) {
        this.streams.delete(stream)
        const cancelled = this.queue.filter((pending) => pending.stream === stream)
        this.queue = this.queue.filter((pending) => pending.stream !== stream)
        for (const pending of cancelled) pending.callback?.()
        // An already-sent write keeps its original owner until reply or timeout.
    }

    private drain() {
        if (this.draining) return
        this.draining = true
        try {
            while (
                this.queue.length &&
                !this.delivering &&
                !this.active &&
                !this.closed &&
                !failedSessions.has(this.dev)
            ) {
                const pending = this.queue.shift()!
                const built = pending.build()
                if (!built || this.closed || failedSessions.has(this.dev) || pending.stream.destroyed) {
                    pending.callback?.()
                    continue
                }
                this.active = { ...built, stream: pending.stream, callback: pending.callback }
                this.timer = setTimeout(() => this.fail(), WRITE_TIMEOUT)
                this.timer.unref()
                this.dev.sendRaw(built.body)
            }
        } finally {
            this.draining = false
        }
    }

    private matches(inner: Buffer, request: Buffer) {
        if (inner[0] !== this.classByte) return false
        if (request[1] === 0x24) return inner.length === 4 && inner[1] === 0 && inner[2] === 0x24
        if (request[1] === 0xed) {
            return inner.length === 13 + 42 && inner[1] === 0x0a && inner[10] === 0xeb && inner.readUInt16BE(11) === 42
        }
        if (request[1] !== 0xe5 || inner[1] !== 0xe6 || inner.length < 7) return false
        const props = properties(request, this.classByte)
        if (!props?.length || inner[6] !== props.length || !inner.subarray(2, 5).equals(request.subarray(2, 5)))
            return false
        if (inner[5] !== 0xff && !(this.classByte === 0x20 && inner[5] === 0x33)) return false
        const end = 7 + props.length * 2
        if (this.classByte === 0x30) {
            if (inner.length !== end && inner.length !== end + 42) return false
        } else if (inner.length !== end + 51 || inner[end] !== 0) return false
        const received = Array.from({ length: inner[6] }, (_, i) => inner[7 + 2 * i])
        return new Set(received).size === props.length && props.every((prop) => received.includes(prop))
    }

    private onPacket = (payload: ClipPayload) => {
        const packet = fromRxPacket(payload)
        const inner = packet && unframe(packet)
        const answered = this.active && inner && this.matches(inner, this.active.inner) ? this.active : undefined
        if (answered) {
            clearTimeout(this.timer)
            this.timer = undefined
            this.active = undefined
        }
        this.delivering = true
        this.completed = answered
        // Busy replies can repeat for seconds. Quarantine before calling any external listener.
        const busy =
            answered &&
            inner?.[1] === 0xe6 &&
            Array.from({ length: inner[6] }, (_, i) => inner[8 + 2 * i]).includes(0x13)
        if (busy) failedSessions.add(this.dev)
        try {
            for (const stream of [...this.streams]) {
                if (!stream.destroyed) stream.emit('packet', payload)
            }
            answered?.callback?.(packet)
        } finally {
            this.completed = undefined
            this.delivering = false
            if (busy) this.fail(answered)
            this.drain()
        }
    }

    private fail(answered?: Write) {
        const firstFailure = !failedSessions.has(this.dev) || answered !== undefined
        failedSessions.add(this.dev)
        const cancelled = this.queue
        const active = this.active
        this.active = undefined
        this.queue = []
        clearTimeout(this.timer)
        this.timer = undefined
        if (firstFailure) {
            const writes = active ? [active] : answered ? [answered] : []
            for (const stream of this.streams) stream.onFailure?.(writes)
        }
        active?.callback?.()
        for (const pending of cancelled) pending.callback?.()
    }

    private onClose = () => {
        this.closed = true
        this.dev.removeListener('rawPacket', this.onPacket)
        this.dev.removeListener('close', this.onClose)
        this.fail()
        for (const stream of this.streams) stream.destroy()
    }
}
