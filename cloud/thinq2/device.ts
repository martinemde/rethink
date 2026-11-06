// This class handles the devices connecting to the internal MQTT broker. This includes both device provisioning
// and minimal wrappers for actual data exchange. The device class is responsible for generating/parsing the payload.

import { generateDeployResponse } from './provisioning'
import { TypedEmitter } from 'tiny-typed-emitter'
import { Client, PublishPacket, type Broker } from '../mqtt-broker'
import { ClipDeployMessage, ClipMessage, DeployAppInfo, DeployPlatformInfo } from './clip'

import log from '@/util/logging'
import { Metadata } from '../thinq'
import { Multiplexer, type Stream } from './multiplexer'

// Some modems leave softVer empty (seen on 2REBGLUB_2P__ with clip_bkn_v1.9.238) and report
// their firmware only in appVersion, so fall back to it for the HA device's sw_version.
export function deployMetadata(deployMsg: ClipDeployMessage): Metadata {
    const appInfo = deployMsg.data?.appInfo
    return {
        modelId: deployMsg.kind,
        modelName: appInfo?.modelName,
        swVersion: appInfo?.softVer || appInfo?.appVersion,
        deviceType: appInfo?.DeviceType,
    }
}

type LegacyDeviceEvents = {
    data: (packet: Buffer) => void
    sendData: (type: 'packet' | 'ack', buf: Buffer) => void
    close: () => void
}

type DeviceEvents = LegacyDeviceEvents & {
    rawData: (packet: Buffer) => void
    sendRawData: (body: object) => void
}

interface DeviceListeners<Self> {
    (event: 'data' | 'rawData', listener: (packet: Buffer) => void): Self
    (event: 'sendData', listener: (type: 'packet' | 'ack', buf: Buffer) => void): Self
    (event: 'sendRawData', listener: (body: object) => void): Self
    (event: 'close', listener: () => void): Self
}

export class Device extends TypedEmitter<DeviceEvents> {
    // Concrete overloads preserve typed shared event calls on the AnyDevice union.
    declare on: DeviceListeners<this>
    declare off: DeviceListeners<this>
    declare once: DeviceListeners<this>
    declare removeListener: DeviceListeners<this>
    declare emit: {
        (event: 'data' | 'rawData', packet: Buffer): boolean
        (event: 'sendData', type: 'packet' | 'ack', buf: Buffer): boolean
        (event: 'sendRawData', body: object): boolean
        (event: 'close'): boolean
    }
    // this could be a stream but why bother...
    readonly platform = 'thinq2'
    managed: boolean = false // set to true if any rethink handler is assigned to the device

    constructor(
        readonly broker: Broker,
        readonly topic: string,
        readonly id: string,
        readonly meta: Metadata,
        // The device's real provisioning info, verbatim from its deploy message. The bridge
        // forwards these upstream so the real LG cloud sees the device's true firmware/protocol
        // version (esp. appInfo.protocolVer) — reporting the wrong protocolVer makes the cloud
        // pick a wire encoding the firmware ignores (e.g. the reservation "service" poll came
        // framed byte5=0xFD and the device never answered it).
        readonly deployAppInfo: DeployAppInfo,
        readonly deployPlatformInfo: DeployPlatformInfo,
    ) {
        super()
    }

    private mux?: Multiplexer
    private defaultStream?: Stream

    onData(buf: Buffer) {
        this.emit('rawData', buf)
        this.emit('data', buf)
    }

    setMux(mux: Multiplexer) {
        if (this.mux) throw new Error('Multiplexer already set')
        this.mux = mux
    }

    openStream() {
        this.mux ??= new Multiplexer(this)
        return this.mux.openStream()
    }

    sendRaw(body: object) {
        const message = body as { cmd?: string; data?: unknown }
        if ((message.cmd === 'packet' || message.cmd === 'ack') && typeof message.data === 'string')
            this.emit('sendData', message.cmd, Buffer.from(message.data, 'hex'))
        this.emit('sendRawData', body)
        const messagestr = JSON.stringify({ did: this.id, mid: Date.now(), ...body })
        this.broker.publish({ topic: this.topic, retain: false, qos: 0, dup: false, payload: messagestr }, null)
    }

    static packet(buf: Buffer) {
        return { cmd: 'packet', type: 1, data: buf.toString('hex').toUpperCase() }
    }

    static ack(buf: Buffer) {
        return { cmd: 'ack', type: 1, data: buf.toString('hex').toUpperCase() }
    }

    send(cmd: string, type: number, data: string | object) {
        this.defaultStream ??= this.openStream()
        this.defaultStream.send({ cmd, type, data })
    }

    send_packet(buf: Buffer) {
        this.defaultStream ??= this.openStream()
        this.defaultStream.send(Device.packet(buf))
    }

    send_ack(buf: Buffer) {
        this.defaultStream ??= this.openStream()
        this.defaultStream.send(Device.ack(buf))
    }
}

function trimNull(buf: Buffer) {
    if (!buf || !buf.length || buf[buf.length - 1]) return buf
    return buf.subarray(0, buf.length - 1)
}

type ClientWithExtra = Client & {
    deviceObj: undefined | Device
    deployMsg: undefined | ClipDeployMessage
}

type DeviceAcceptorEvents = {
    newDevice: (dev: Device) => void
    dropDevice: (id: string) => void
}

export class DeviceAcceptor extends TypedEmitter<DeviceAcceptorEvents> {
    clientsById: Record<string, Client> = {}
    constructor(readonly broker: Broker) {
        super()

        broker.on('publish', (packet, client) => {
            if (client) {
                log('incoming', packet.topic, packet.payload.toString('utf-8'), 'retain:', packet.retain)
            } else {
                log('outgoing', packet.topic, packet.payload.toString('utf-8'), 'retain:', packet.retain)
                return // don't process outgoing packets further
            }

            try {
                if (packet.topic.indexOf('clip/') >= 0) {
                    const payload = JSON.parse(trimNull(Buffer.from(packet.payload)).toString('utf-8'))
                    this.mqtt(packet.topic, payload, client as ClientWithExtra, packet.retain === true)
                }
            } catch (err) {
                console.warn(err, packet.payload.toString('hex'))
            }
        })

        broker.on('disconnect', this.disconnected.bind(this))
    }

    mqtt(topic: string, payload: ClipMessage, client: ClientWithExtra, retained = false) {
        // experiment: try to support devices which use other topic formats
        topic = topic.replace(/^.*\/clip/, 'clip')

        if (topic === 'clip/message/devices/' + payload.did) {
            if (payload.cmd === 'completeProvisioning_ack') {
                // @AndrewPaglusch reports that some devices don't send this packet at all.
            }

            if (payload.cmd === 'device_packet' && payload.did === client.deployMsg?.did) {
                // Retained application frames cannot establish a fresh appliance receipt.
                // Provisioning and timesync keep their existing handling below.
                if (retained) return
                if (client.deviceObj) {
                    const buf = Buffer.from(payload.data as string, 'hex')
                    client.deviceObj.onData(buf)
                }
            }

            if (payload.cmd === 'req_timesync' && client.deployMsg && payload.did === client.deployMsg.did) {
                this.timeSyncRequest(client)
            }
        }

        if (topic === 'clip/provisioning/devices/' + payload.did) {
            if (payload.cmd === 'preDeploy' || payload.cmd === 'deploy') {
                client.deployMsg = payload as ClipDeployMessage
                this.broker.publish(
                    {
                        topic: 'lime/devices/' + payload.did,
                        retain: false,
                        qos: 0,
                        dup: false,
                        payload: JSON.stringify(generateDeployResponse(payload as ClipDeployMessage)),
                    },
                    null,
                )

                if (!client.deviceObj) this.completeProvisioning(payload.did, client.deployMsg, client)
                else console.warn(`device ${payload.did} already set up`)
            }
        }
    }

    completeProvisioning(deviceId: string, deployMsg: ClipDeployMessage, client: ClientWithExtra) {
        if (this.clientsById[deviceId]) {
            console.warn(`device ${deviceId} already connected, dropping the old one`)
            this.clientsById[deviceId].destroy()
        }

        this.clientsById[deviceId] = client

        const meta = deployMetadata(deployMsg)

        const dev = new Device(
            this.broker,
            'lime/devices/' + deviceId,
            deviceId,
            meta,
            deployMsg.data.appInfo,
            deployMsg.data.platformInfo,
        )
        client.deviceObj = dev
        this.emit('newDevice', dev)
    }

    timeSyncRequest(client: ClientWithExtra) {
        const now = new Date()
        const buf = Buffer.alloc(7)
        buf[0] = now.getUTCFullYear() % 100
        buf[1] = now.getUTCMonth()
        buf[2] = now.getUTCDate()
        buf[3] = now.getUTCHours()
        buf[4] = now.getUTCMinutes()
        buf[5] = now.getUTCSeconds()
        buf[6] = now.getUTCDay()

        const deviceId = client.deployMsg?.did
        if (!deviceId) return

        this.broker.publish(
            {
                topic: 'lime/devices/' + deviceId,
                retain: false,
                qos: 0,
                dup: false,
                payload: JSON.stringify({
                    did: deviceId,
                    mid: Date.now(),
                    cmd: 'resp_timesync',
                    type: 1,
                    data: buf.toString('base64'),
                }),
            },
            null,
        )
    }

    disconnected(_client: Client) {
        let client = _client as ClientWithExtra
        if (client.deviceObj) {
            delete this.clientsById[client.deviceObj.id]
            this.emit('dropDevice', client.deviceObj.id)
            client.deviceObj.emit('close')
            client.deviceObj = undefined
        }
    }
}
