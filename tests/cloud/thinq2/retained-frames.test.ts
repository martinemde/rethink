import assert from 'node:assert/strict'
import test from 'node:test'
import { Broker, type Client } from '../../../cloud/mqtt-broker'
import { DeviceAcceptor, type Device } from '../../../cloud/thinq2/device'
import { fromRxPacket } from '../../../cloud/thinq2/clip'

// Exercise the broker publish event: this is where retain metadata previously disappeared.
test('retained application frames are suppressed without blocking provisioning or fresh frames', () => {
    const broker = new Broker()
    const acceptor = new DeviceAcceptor(broker)
    const client = { destroy() {} } as unknown as Client
    let device: Device | undefined
    const data: Buffer[] = []
    acceptor.on('newDevice', (created) => {
        device = created
        created.on('rawPacket', (packet) => {
            const buf = fromRxPacket(packet)
            if (buf) data.push(buf)
        })
    })
    const publish = (cmd: string, retain: boolean, payload: unknown, provisioning = false) => {
        broker.publish(
            {
                topic: `clip/${provisioning ? 'provisioning' : 'message'}/devices/test-device`,
                retain,
                qos: 0,
                dup: false,
                payload: Buffer.from(
                    JSON.stringify({ did: 'test-device', kind: 'MI2U7B', cmd, mid: 1, type: 1, data: payload }),
                ),
            },
            client,
        )
    }
    publish('deploy', true, { appInfo: { modelName: 'SideKick' } }, true)
    assert.ok(device, 'retained provisioning retains its existing behavior')
    publish('device_packet', true, 'aa01bb')
    assert.equal(data.length, 0)
    publish('device_packet', false, 'aa02bb')
    assert.deepEqual(data, [Buffer.from('aa02bb', 'hex')])
    publish('device_packet', true, 'aa03bb')
    assert.equal(data.length, 1)
    let syncResponses = 0
    broker.on('publish', (packet, source) => {
        if (!source && JSON.parse(packet.payload.toString()).cmd === 'resp_timesync') syncResponses++
    })
    publish('req_timesync', true, {})
    assert.equal(syncResponses, 1, 'non-application traffic retains its existing behavior')
})
