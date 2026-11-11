// Laundry-only legacy write attribution and verified bundle handling over native packet streams.
import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import type { LaundryMultiplexer, LaundryStream } from './laundry_multiplexer'
import type { Stream } from '../thinq2/multiplexer'
import { fromRxPacket, fromTxPacket, txPacket, txAck, type ClipPayload } from '../thinq2/clip'

// Frame types the cloud does not ack: the appliance's own acks, the c3 heartbeat, and the eb/ec status
// records outside an envelope. Checked against the cloud, bridged as FAFXU22007 and Y_VB_Y___W.B32QEUK.
const UNACKED_TYPES = new Set([0x00, 0xc3, 0xeb, 0xec])
const FRAME_TYPE_ENVELOPE = 0x0a
const ENVELOPE_SEQ_OFFSET = 5
const ENVELOPE_INNER_TYPE_OFFSET = 10
const ENVELOPE_INNER_LEN_OFFSET = 11
// the envelope header, up to and including the 16-bit inner length; the cloud ignores anything shorter
const ENVELOPE_MIN_LEN = 13
// AA FF marks the long framing, whose 16-bit checksum leaves one byte on the end of `inner`
const LONG_FRAME = 0xff

// f0 00 <type> 04 [<seq16>], sent under the MQTT `ack` command. `00` in place of `04`, or `packet` in
// place of `ack`, stops the retransmits but leaves the content sync re-running every 5 s.
const CLOUD_ACK = [0xf0, 0x00]
const CLOUD_ACK_STATUS = 0x04

// A write sent to the appliance: by us, or by the LG cloud while bridged
export type AwaitedWrite = { type: number; own: boolean; inner: Buffer }
type QueuedWrite = { build: () => Buffer | undefined; coalescingKey?: string }

export default class LaundryDevice extends HADevice {
    protected readonly stream?: LaundryStream
    private readonly transport: Stream
    private readonly onDevicePacket = (packet: ClipPayload) => {
        const data = fromRxPacket(packet)
        if (data) this.processData(data)
    }
    private readonly onSentPacket = (packet: ClipPayload) => {
        const data = fromTxPacket(packet)
        if (!data) return
        if (this.mux) this.onMuxSendData('packet', data)
        else this.onSendData('packet', data)
    }

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        readonly autoAck: boolean,
        readonly mux?: LaundryMultiplexer,
    ) {
        super(HA, thinq.id, thinq.meta.modelId)
        if (mux) thinq.setMux(mux)
        this.transport = thinq.openStream()
        this.transport.on('packet', this.onDevicePacket)
        thinq.on('sendRawPacket', this.onSentPacket)
        if (mux) {
            this.stream = this.transport as LaundryStream
            this.stream.onFailure = (writes) =>
                this.writeTimedOut(
                    writes.map((write) => ({
                        type: write.inner[1],
                        own: write.stream === this.stream,
                        inner: write.inner,
                    })),
                )
        }
    }

    drop() {
        this.transport.off('packet', this.onDevicePacket)
        this.transport.destroy()
        this.thinq.off('sendRawPacket', this.onSentPacket)
        clearTimeout(this.writeTimer)
        this.writeTimer = undefined
        this.writeQueue.length = 0
        this.awaiting.length = 0
        super.drop()
    }

    // AA [length] ...inner [checksum] BB
    static frame(inner: Buffer): Buffer {
        const packet = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0x00])])
        const sum = packet.reduce((pv, cv) => pv + cv, 0)
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55
        packet[packet.length - 1] = 0xbb
        return packet
    }

    send(inner: Buffer) {
        const packet = LaundryDevice.frame(inner)
        this.transport.send(txPacket(packet))
    }

    // One write at a time: the LG laundry machines answer a write that arrives while the previous one is
    // still being applied with result 0x13 (busy). While bridged, the LG cloud's writes pass through
    // the same transport too, so they are tracked like ours. The next write goes out once every write sent
    // has been answered. Legacy devices also resume after WRITE_TIMEOUT_MS; strict devices instead block
    // further writes after a timeout. Entries build their bytes when sent; undefined skips one.
    private readonly writeQueue: QueuedWrite[] = []
    // Writes sent and not yet answered, oldest first, with their inner bytes. The replies carry no sequence
    // number, so each is taken to answer the oldest write of its type.
    private readonly awaiting: AwaitedWrite[] = []
    private writeTimer?: NodeJS.Timeout
    private sendingOwn = false
    static readonly WRITE_TIMEOUT_MS = 3000
    protected readonly strictWriteTracking: boolean = false
    private writeBlocked = false

    protected get writesBlocked() {
        return this.mux?.writesBlocked ?? this.writeBlocked
    }

    // Strict devices can clear pending model state and publish a diagnostic here. A late reply cannot
    // safely identify which write it answered, so only dropping/recreating the device permits recovery.
    protected writeTimedOut(writes: readonly AwaitedWrite[]) {}

    // The type of write an outgoing frame's inner bytes carry, if it is one the device answers; devices
    // that call queueWrite override this.
    protected writeType(inner: Buffer): number | undefined {
        return undefined
    }

    // Keys identify replaceable settings. An unkeyed entry is an action/order barrier: never coalesce
    // across it. Only unsent callbacks are replaced; model-owned pending values remain the model's job.
    protected queueWrite(build: () => Buffer | undefined, coalescingKey?: string) {
        if (this.stream) {
            this.stream.queueWrite(build, coalescingKey)
            return
        }
        if (this.writeBlocked) return
        if (coalescingKey !== undefined) {
            for (let i = this.writeQueue.length - 1; i >= 0; i--) {
                const entry = this.writeQueue[i]
                if (entry.coalescingKey === undefined) break
                if (entry.coalescingKey === coalescingKey) {
                    entry.build = build
                    return
                }
            }
        }
        this.writeQueue.push({ build, coalescingKey })
        this.nextWrite()
    }

    // Call on a reply to a write of `type`: returns the write it answers, or undefined if none awaits one.
    // The next write goes out once processAABB returns, so a bundle built then includes what this one
    // changed.
    protected writeAnswered(type: number, matches?: (write: AwaitedWrite) => boolean): AwaitedWrite | undefined {
        if (this.mux) {
            const slot = this.mux.writeAnswered(type)
            if (!slot) return undefined
            const write = { type, own: slot.stream === this.stream, inner: slot.inner }
            return !matches || matches(write) ? write : undefined
        }
        if (this.writeBlocked) return undefined
        const i = this.awaiting.findIndex((w) => w.type === type)
        // Do not skip an older same-type write: replies have no sequence number. Models validate the
        // reply and compare property sets before allowing an E5 write to settle.
        if (i < 0 || (matches && !matches(this.awaiting[i]))) return undefined
        const [write] = this.awaiting.splice(i, 1)
        if (this.awaiting.length === 0) {
            clearTimeout(this.writeTimer)
            this.writeTimer = undefined
        }
        return write
    }

    private nextWrite() {
        if (this.writeBlocked || this.awaiting.length > 0) return
        let frame: Buffer | undefined
        while (frame === undefined && this.writeQueue.length > 0) frame = this.writeQueue.shift()!.build()
        if (frame === undefined) return
        this.sendingOwn = true
        try {
            this.send(frame)
        } finally {
            this.sendingOwn = false
        }
    }

    // Models may attach actual-send bookkeeping to writeType (e.g. dryer query context).
    private readonly onMuxSendData = (type: 'packet' | 'ack', packet: Buffer) => {
        if (type === 'packet' && packet.length >= 4 && packet[0] === 0xaa && packet[packet.length - 1] === 0xbb)
            this.writeType(packet.subarray(2, packet.length - 2))
    }

    private readonly onSendData = (type: 'packet' | 'ack', buf: Buffer) => {
        if (this.writeBlocked || type !== 'packet' || buf.length < 4 || buf[0] !== 0xaa || buf[buf.length - 1] !== 0xbb)
            return
        const inner = buf.subarray(2, buf.length - 2)
        const writeType = this.writeType(inner)
        if (writeType === undefined) return
        this.awaiting.push({ type: writeType, own: this.sendingOwn, inner: Buffer.from(inner) })
        clearTimeout(this.writeTimer)
        this.writeTimer = setTimeout(() => {
            const expired = this.awaiting.splice(0)
            this.writeTimer = undefined
            if (this.strictWriteTracking) {
                this.writeBlocked = true
                this.writeQueue.length = 0
                this.writeTimedOut(expired)
                return
            }
            this.nextWrite()
        }, LaundryDevice.WRITE_TIMEOUT_MS).unref()
    }

    // Opt-in handlers finish interpreting validated reports before acknowledging delivery.
    protected readonly ackAfterProcessing: boolean = false

    processData(buf: Buffer, afterProcessing?: () => void) {
        if (buf.length >= 4 && buf[0] == 0xaa && buf[buf.length - 1] == 0xbb) {
            const inner = buf.subarray(2, buf.length - 2)
            if (this.autoAck && !this.ackAfterProcessing) this.ack(inner, buf[1] === LONG_FRAME)
            this.processAABB(inner)
            afterProcessing?.()
            if (this.autoAck && this.ackAfterProcessing) this.ack(inner, buf[1] === LONG_FRAME)
            this.nextWrite()
        }
    }

    private sendAck(packet: Buffer) {
        this.transport.send(txAck(packet))
    }

    // Envelopes (<class> 0a ...) are acked by sequence number, whatever their delivery class; other
    // types by type.
    private ack(inner: Buffer, longFrame: boolean) {
        const type = inner[1]
        if (UNACKED_TYPES.has(type)) return
        if (type === FRAME_TYPE_ENVELOPE) {
            if (inner.length - (longFrame ? 1 : 0) < ENVELOPE_MIN_LEN) return
            const seq = inner.subarray(ENVELOPE_SEQ_OFFSET, ENVELOPE_SEQ_OFFSET + 2)
            this.sendAck(LaundryDevice.frame(Buffer.from([...CLOUD_ACK, type, CLOUD_ACK_STATUS, ...seq])))
        } else {
            this.sendAck(LaundryDevice.frame(Buffer.from([...CLOUD_ACK, type, CLOUD_ACK_STATUS])))
        }
    }

    processAABB(buf: Buffer) {
        throw new Error('To be overriden')
    }

    // 0xEB/0xEC is a pattern used in nearly all AABB devices. Call this in your processAABB handler
    // `handler` will commonly be this.processStatus, so it is called with `this` bound.
    processCommonStatus(buf: Buffer, classByte: number, statusLength: number, handler: (status: Buffer) => void) {
        // XX EB [status block]
        if (buf[0] === classByte && buf[1] == 0xeb && buf.length === 2 + statusLength) {
            handler.call(this, buf.subarray(2))
            return true
        }

        // XX EC [previous block] [status block]
        if (buf[0] === classByte && buf[1] == 0xec && buf.length === 2 + statusLength * 2) {
            handler.call(this, buf.subarray(2 + statusLength))
            return true
        }

        return false
    }

    // Some appliances wrap the EB/EC records in an envelope instead; same `handler` contract as above.
    processEnvelopedStatus(buf: Buffer, classByte: number, statusLength: number, handler: (status: Buffer) => void) {
        // XX 0a [len16] [seq16] .. .. .. [EB/EC] [inner len16] [records] (+ the long framing's checksum byte)
        if (buf.length < ENVELOPE_MIN_LEN || buf[0] !== classByte || buf[1] !== FRAME_TYPE_ENVELOPE) return false

        const innerLen = buf.readUInt16BE(ENVELOPE_INNER_LEN_OFFSET)
        // anything past the records, other than that one checksum byte, means the layout isn't what we think
        const trailing = buf.length - ENVELOPE_MIN_LEN - innerLen
        if (trailing !== 0 && trailing !== 1) return false
        const records = buf.subarray(ENVELOPE_MIN_LEN, ENVELOPE_MIN_LEN + innerLen)

        const type = buf[ENVELOPE_INNER_TYPE_OFFSET]
        if (type === 0xeb && innerLen === statusLength) {
            handler.call(this, records)
            return true
        }

        if (type === 0xec && innerLen === statusLength * 2) {
            handler.call(this, records.subarray(statusLength))
            return true
        }

        return false
    }
}
