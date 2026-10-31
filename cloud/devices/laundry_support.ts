import HADevice from './base'
import { LaundryStateStore } from '../laundry-state'

export const laundryComponents = (door: 'door' | 'drawer') => ({
    load_waiting: {
        platform: 'binary_sensor',
        unique_id: '$deviceid-load_waiting',
        state_topic: '$this/load_waiting',
        json_attributes_topic: '$this/load_waiting_attributes',
        name: 'Load waiting',
        icon: 'mdi:basket-check',
    },
    load_removed: {
        platform: 'button',
        unique_id: '$deviceid-load_removed',
        command_topic: '$this/load_removed/set',
        payload_press: '',
        retain: false,
        name: 'Load removed',
        icon: 'mdi:basket-minus',
    },
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

export class LaundrySupport {
    constructor(
        readonly device: HADevice,
        readonly store: LaundryStateStore,
    ) {}

    publish(force = false) {
        const state = this.store.get(this.device.id)
        const { waiting, armed, completed, ...attributes } = state
        const publish = (key: string, value: string | undefined) => {
            if (force) this.device.HA.publishProperty(this.device.id, key, value)
            else this.device.publishProperty(key, value)
        }
        publish('load_waiting_attributes', JSON.stringify(attributes))
        publish('load_waiting', state.waiting === null ? undefined : state.waiting ? 'ON' : 'OFF')
    }

    receipt() {
        // Deliberately bypass value cache: each validated live packet is a new receipt.
        this.device.HA.publishProperty(this.device.id, 'last_report_at', new Date(Date.now()).toISOString())
    }

    door(open: boolean) {
        const at = Date.now()
        this.device.HA.publishProperty(this.device.id, 'last_door_report_at', new Date(at).toISOString())
        if (open) {
            this.store.clear(this.device.id, 'door', at)
            this.publish()
        }
    }

    status(state: number, active: readonly number[]) {
        if ([0, 1].includes(state)) this.store.idle(this.device.id)
        else if (active.includes(state)) this.store.active(this.device.id)
        this.publish()
    }

    complete(): boolean {
        const before = this.store.get(this.device.id)
        const after = this.store.complete(this.device.id, {
            fault: '',
            cycle_minutes:
                Number(this.device.publishCache.get('initial_time') ?? this.device.publishCache.get('total_time')) ||
                undefined,
        })
        this.publish()
        return before.armed && after.completed && after.waiting === true
    }

    command(prop: string) {
        if (prop !== 'load_removed') return false
        this.store.clear(this.device.id, 'manual')
        this.publish()
        return true
    }
}
