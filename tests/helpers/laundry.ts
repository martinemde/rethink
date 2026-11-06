import { Device } from '@/cloud/thinq2/device'
import type { Metadata } from '@/cloud/thinq'
import type { Broker } from '@/cloud/mqtt-broker'
import type { DeployAppInfo } from '@/cloud/thinq2/clip'

// Exercise the real packet/sendRaw transport; only the final broker publish is recorded.
export class MockLaundryDevice extends Device {
    outbox: Buffer[] = []
    sent: { cmd: string; type: number; data: string | object }[] = []

    constructor(id: string, meta: Metadata) {
        const broker = {
            publish: (packet: { payload: string }) => {
                const { cmd, type, data } = JSON.parse(packet.payload)
                if (cmd === 'packet') this.outbox.push(Buffer.from(data, 'hex'))
                else this.sent.push({ cmd, type, data })
            },
        } as unknown as Broker
        super(broker, 'mock/topic', id, meta, undefined as unknown as DeployAppInfo, undefined)
    }

    resetRecorder() {
        this.outbox = []
        this.sent = []
    }
}

const cloudStreams = new WeakMap<Device, ReturnType<Device['openStream']>>()

export function sendCloud(device: Device, packet: Buffer) {
    let stream = cloudStreams.get(device)
    if (!stream) {
        stream = device.openStream()
        cloudStreams.set(device, stream)
    }
    stream.send(Device.packet(packet))
}
