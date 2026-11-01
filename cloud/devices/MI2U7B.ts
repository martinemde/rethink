import HADevice from './base'
import { ReceiptSupport, receiptComponents } from './receipt_support'
import AABBDevice from './aabb_device'
import crc16 from '@/util/crc16'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { parseSideKickFrame } from './MI2U7B_status'

// Exact-model reports and protocol ACKs only; no polls or appliance setting commands.
export default class Device extends AABBDevice {
    protected override readonly ackAfterProcessing = true
    private readonly receipts: ReceiptSupport
    // A finish retry at startup is not a new completion. No lifecycle is persisted.
    private completionState: 'unarmed' | 'armed' | 'completed' = 'unarmed'

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.receipts = new ReceiptSupport(this)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG SideKick' }),
                components: {
                    ...receiptComponents('drawer'),
                    cycle_finished: {
                        platform: 'event',
                        unique_id: '$deviceid-cycle_finished',
                        state_topic: '$this/cycle_finished',
                        name: 'Cycle finished',
                        event_types: ['finished'],
                        enabled_by_default: true,
                    },
                    total_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-total_time',
                        state_topic: '$this/total_time',
                        name: 'Total Time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                    },
                    drawer: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drawer',
                        state_topic: '$this/drawer',
                        name: 'Drawer',
                        device_class: 'opening',
                    },
                },
            }),
        )
    }

    // Only long envelopes are verified for this model; short framing is not ACKed or interpreted.
    override processData(frame: Buffer) {
        if (
            frame.length < 18 ||
            frame[0] !== 0xaa ||
            frame[1] !== 0xff ||
            frame[2] !== 0x20 ||
            frame[3] !== 0x0a ||
            frame[frame.length - 1] !== 0xbb ||
            frame.readUInt16BE(4) !== frame.length ||
            frame.readUInt16BE(13) + 18 !== frame.length ||
            crc16(frame.subarray(0, -3)) !== frame.readUInt16BE(frame.length - 3)
        )
            return
        const receivedAt = Date.now()
        this.processReport(frame)
        super.processData(frame, () => this.receipts.receipt(receivedAt))
    }

    override processAABB(_buf: Buffer) {}

    private processReport(frame: Buffer) {
        const update = parseSideKickFrame(frame)
        if (!update) return
        if (update.kind === 'completion') {
            if (this.completionState !== 'armed') return
            this.completionState = 'completed'
            this.HA.publishProperty(this.id, 'cycle_finished', JSON.stringify({ event_type: 'finished' }), {
                retain: false,
            })
        } else if (update.kind === 'drawer') {
            this.publishProperty('drawer', update.drawer)
            if (update.drawer !== undefined) this.receipts.door()
        } else {
            if ([0, 1].includes(update.state_code)) this.completionState = 'unarmed'
            else if ([11, 12, 14].includes(update.state_code))
                this.completionState = 'armed'
            this.publishProperty('status', update.status)
            this.publishProperty('total_time', update.total_time)
            this.publishProperty('course', update.course)
            this.publishProperty('remaining_time', update.remaining_time)
            this.publishProperty('energy', update.energy)
        }
    }

    override setProperty(_prop: string, _value: string) {}
}
