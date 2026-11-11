import assert from 'node:assert/strict'
import test from 'node:test'
import { Device } from '@/cloud/thinq2/device'
import type { Broker } from '@/cloud/mqtt-broker'
import { rxPacket, txPacket, txAck, type DeployAppInfo } from '@/cloud/thinq2/clip'

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

test('native ingress reaches streams and diagnostics once; physical close detaches streams', () => {
    const { dev } = setup()
    const stream = dev.openStream()
    const got: string[] = []
    dev.on('rawPacket', () => got.push('raw'))
    stream.on('packet', () => got.push('stream'))
    dev.onPacket(rxPacket(Buffer.from('hello')))
    assert.deepEqual(got, ['stream', 'raw'])
    dev.emit('close')
    assert.equal(dev.listenerCount('rawPacket'), 1, 'only explicit diagnostic listener remains')
    assert.equal(dev.listenerCount('close'), 0)
    dev.onPacket(rxPacket(Buffer.from('later')))
    assert.deepEqual(got, ['stream', 'raw', 'raw'])
})

test('native sends preserve payload metadata and report the published envelope', () => {
    const { dev, published } = setup()
    const raw: object[] = []
    dev.on('sendRawPacket', (body) => raw.push(body))
    const packet = Buffer.from('aabb', 'hex')
    const stream = dev.openStream()
    stream.send(txPacket(packet))
    stream.send(txAck(packet))
    const body = Object.freeze({ cmd: 'packet', type: 9, data: 'aAbB', extra: { original: true } })
    stream.send(body)
    assert.deepEqual(raw, published)
    assert.deepEqual(
        published.map(({ did, mid, ...rest }: any) => rest),
        [txPacket(packet), txAck(packet), body],
    )
    dev.emit('close')
    stream.send(txPacket(packet))
    assert.equal(published.length, 3, 'closed streams cannot send')
})
