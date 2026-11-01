import HADevice from './base'
import { tombstone } from '../homeassistant'

export const receiptComponents = (door: 'door' | 'drawer') => ({
    // Withdraw integration-owned policy; waiting and manual clearing belong in HA.
    load_waiting: tombstone('binary_sensor'),
    load_removed: tombstone('button'),
    last_report_at: {
        platform: 'sensor',
        unique_id: '$deviceid-last_report_at',
        state_topic: '$this/last_report_at',
        name: 'Last report',
        device_class: 'timestamp',
        entity_category: 'diagnostic',
    },
    last_door_report_at: {
        platform: 'sensor',
        unique_id: '$deviceid-last_door_report_at',
        state_topic: '$this/last_door_report_at',
        name: door === 'drawer' ? 'Last drawer report' : 'Last door report',
        device_class: 'timestamp',
        entity_category: 'diagnostic',
    },
})

// Freshness is receipt time, not a value transition or proof of physical pickup.
export class ReceiptSupport {
    constructor(readonly device: HADevice) {}

    receipt(at: number) {
        this.device.HA.publishProperty(this.device.id, 'last_report_at', new Date(at).toISOString())
    }

    door() {
        this.device.HA.publishProperty(this.device.id, 'last_door_report_at', new Date(Date.now()).toISOString())
    }
}
