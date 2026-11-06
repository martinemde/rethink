import assert from 'node:assert/strict'
import test from 'node:test'
import { Device } from '@/cloud/thinq2/device'
import type { Broker } from '@/cloud/mqtt-broker'
import type { DeployAppInfo } from '@/cloud/thinq2/clip'

function setup() {
    const published: object[] = []
    const broker = {
        publish(packet: { payload: string }) {
            published.push(JSON.parse(packet.payload))
        },
    } as unknown as Broker
    const dev = new Device(
        broker,
        'test/topic',
        'test',
        { modelId: 'test', modelName: 'test' },
        undefined as unknown as DeployAppInfo,
        undefined,
    )
    return { dev, published }
}

test('native ingress emits raw and legacy data once; stream close detaches ingress', () => {
    const { dev } = setup()
    const stream = dev.openStream()
    const got: string[] = []
    dev.on('rawData', () => got.push('raw'))
    dev.on('data', () => got.push('legacy'))
    stream.on('data', () => got.push('stream'))
    dev.onData(Buffer.from('hello'))
    assert.deepEqual(got, ['stream', 'raw', 'legacy'])
    dev.emit('close')
    assert.equal(dev.listenerCount('rawData'), 1, 'only explicit diagnostic listener remains')
    assert.equal(dev.listenerCount('close'), 0)
})

test('legacy send methods retain sendData while raw body metadata survives unchanged', () => {
    const { dev, published } = setup()
    const diagnostics: string[] = []
    const raw: object[] = []
    dev.on('sendData', (type, buf) => diagnostics.push(type + ':' + buf.toString('hex')))
    dev.on('sendRawData', (body) => raw.push(body))
    const packet = Buffer.from('aabb', 'hex')
    dev.send_packet(packet)
    dev.send_ack(packet)
    const body = Object.freeze({ cmd: 'packet', type: 9, data: 'aAbB', extra: { original: true } })
    dev.openStream().send(body)
    assert.deepEqual(diagnostics, ['packet:aabb', 'ack:aabb', 'packet:aabb'])
    assert.equal(raw[2], body)
    assert.deepEqual(
        published.map(({ did, mid, ...rest }: any) => rest),
        [Device.packet(packet), Device.ack(packet), body],
    )
    dev.emit('close')
})
