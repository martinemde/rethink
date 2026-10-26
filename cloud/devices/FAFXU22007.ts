import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice, { type AwaitedWrite } from './aabb_device'
import { Enum } from '@/util/enum'
import crc16 from '@/util/crc16'

// LG WM6700HBA front-load washer. FAFXU25006's framing, but a 51-byte record and different
// temperature codes.
//
//     aa ff 20 0a 00 78 00 05 94 00 01 00 ec 00 66 <payload> <chk16> bb
//           │  │  └─┬─┘    └─┬─┘       │  │  └─┬─┘
//           │  │    │        │         │  │    └ buf[11:13] payload length
//           │  │    │        │         │  └ buf[10] inner type
//           │  │    │        │         └ buf[9] delivery class: 0 sent once, else repeated until acked
//           │  │    │        └ buf[5:7] sequence
//           │  │    └ buf[2:4] frame length
//           │  └ buf[1] 0a envelope
//           └ buf[0] class, 0x20
//
// Inner types: 0xEC previous + current record; 0xEB current record (status query reply); 0x03 event.

const CLASS_BYTE = 0x20
const ENVELOPE_TYPE = 0x0a
const INNER_TYPE_OFFSET = 10
const INNER_LEN_OFFSET = 11

const RECORD_LEN = 51

const STATUS_FRAME_TYPE = 0xec
const STATUS_INNER_LEN = 2 * RECORD_LEN
const STATUS_RECORD_OFFSET = 13 + RECORD_LEN // skip the "previous state" record
const STATUS_BUF_LEN = 13 + STATUS_INNER_LEN + 1

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_INNER_LEN = RECORD_LEN
const SINGLE_RECORD_OFFSET = 13
const SINGLE_BUF_LEN = 13 + SINGLE_INNER_LEN + 1

// The door is only an event, never in the record, and not sent at power-on:
//
//     10 0b 01 0b 10 01
//     │              │
//     │              └ 1 open, 2 shut
//     └ id 10: door (11, the panel menu, has the same length)
const EVENT_FRAME_TYPE = 0x03
const DOOR_EVENT_INNER_LEN = 6
const DOOR_EVENT_BUF_LEN = 13 + DOOR_EVENT_INNER_LEN + 1

const DOOR_EVENT_PREFIX = Buffer.from([0x10, 0x0b, 0x01, 0x0b, 0x10])
const COMPLETION_PREFIX = Buffer.from([0x08, 0x0b, 0x01, 0x0b, 0x08, 0x02])
const COMPLETION_INNER_LEN = 121
const DOOR_EVENT_VALUE_OFFSET = 18

const DOOR_OPEN = 1
const DOOR_SHUT = 2

//     aa 07 20 d8 17 <chk> bb
//              │  │
//              │  └ 0 open, else the wash count (rec[28])
//              └ ezDispense drawer
const DRAWER_FRAME_TYPE = 0xd8
const DRAWER_BUF_LEN = 3
const DRAWER_OPEN = 0

// Set property:
//
//     aa 0f f0 e5 00 02 01 ff 02 0a 4e 03 01 bb bb
//                             │  └────┬────┘
//                             │       └ (prop, value) × count; Delay Start (0x7f) takes 2 bytes, big-endian
//                             └ count
const SET_PROPERTY = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff]
const PROP_POWER = 0x02
const PROP_CYCLE = 0x03
const PROP_COURSE = 0x0a // 0xff, then PROP_DOWNLOADED_COURSE, for a downloaded course
const PROP_DOWNLOADED_COURSE = 0x0b
const PROP_BUZZER = 0x13
const PROP_CYCLE_OPTIMIZATION = 0x4c
const PROP_SPLASH_SCREEN = 0x51
const PROP_QUICK_LOAD_SENSE = 0x56

const COURSE_DOWNLOADED = 0xff
const CYCLE = Enum.of({ start: 1, pause: 2, resume: 3 })

// The app always writes these together, in this order.
const BUNDLE = [
    { prop: 0x1f, key: 'temp', width: 1 },
    { prop: 0x21, key: 'spin', width: 1 },
    { prop: 0x1e, key: 'soil', width: 1 },
    { prop: 0x20, key: 'rinse', width: 1 },
    { prop: 0x3e, key: 'steam', width: 1 },
    { prop: 0x34, key: 'pre_wash', width: 1 },
    { prop: 0x38, key: 'cold_wash', width: 1 },
    { prop: 0x35, key: 'turbo_wash', width: 1 },
    { prop: 0x44, key: 'fresh_care', width: 1 },
    { prop: 0x7f, key: 'reserve_time', width: 2 },
] as const
type BundleKey = (typeof BUNDLE)[number]['key']
const BUNDLE_SWITCHES: BundleKey[] = ['steam', 'pre_wash', 'cold_wash', 'turbo_wash', 'fresh_care']

// The app sets these with Cold Wash on and offers no soil above Medium; the washer enforces neither.
const COLD_WASH_TEMP = 14 // Cold
const COLD_WASH_SOIL = 3 // Medium

// Delay Start; 0 cancels
const RESERVE_TIME_MIN = 60
const RESERVE_TIME_MAX = 1140
const RESERVE_TIME_STEP = 30

// Write reply. Results: 0x00 accepted, 0x11 unchanged, 0x03 refused (e.g. chime while off), 0x13 busy. The
// dryer also answers 0x10 (accepted) and 0x17 (refused).
//
//     aa 40 20 e6 00 02 01 ff 01 13 00 <record> <chk> bb
//                             │  └─┬─┘ │
//                             │    │   └ status: current, unless the write was refused or busy
//                             │    └ (prop, result) × count
//                             └ buf[6] count
//
// A busy reply's status is taken when the write arrives, and can predate a write accepted just before it;
// the washer then re-sends that reply, unchanged, for some 15 s.
const WRITE_REPLY_TYPE = 0xe6
const WRITE_OK = new Set([0x00, 0x10, 0x11])

// Command, and its reply (only result 0x00 seen):
//
//     aa 09 f0 24 10 01 01 8c bb        aa 08 20 00 24 00 a3 bb
//                 │     │                     │  │  └ result
//                 │     └ value               │  └ command frame type
//                 └ command                   └ appliance ack
const COMMAND = [0xf0, 0x24]
const COMMAND_REMOTE_MAINTAIN = 0x10
const COMMAND_REPLY_TYPE = 0x00
const COMMAND_OK = 0x00

// Never a course; the matching dryer reported it while stuck after a remote power-on (see BDVG_FX0003_US)
const NO_COURSE = 0
const NO_COURSE_REASON = 'No course selected: choose a course first'

const SOIL_OFFSET = 1
const TEMP_OFFSET = 2
const RINSE_OFFSET = 3
const SPIN_OFFSET = 4
const COURSE_OFFSET = 5
const RESERVE_TIME_OFFSET = 11 // minutes, big-endian unlike the other counts
const REMAIN_TIME_OFFSET = 14
const INITIAL_TIME_OFFSET = 16
const SPENT_POWER_OFFSET = 17 // Wh, big-endian; user-selected local interpretation
const LOADED_COURSE_OFFSET = 20 // = rec[5], except where rec[5] is 0xff (a downloaded course)
const STATE_OFFSET = 21
const TUB_CLEAN_COUNT_OFFSET = 28
const BUZZER_OFFSET = 29
const DETERGENT_LEVEL_OFFSET = 30
const SOFTENER_LEVEL_OFFSET = 31
const DETERGENT_AMOUNT_OFFSET = 32 // mL
const SOFTENER_AMOUNT_OFFSET = 33 // mL
const DOOR_LOCK_OFFSET = 38
const SPLASH_SCREEN_OFFSET = 46
const SOFTENER_TANK_USE_OFFSET = 48

const NOZZLE_CLEAN_OFFSET = 47
const NOZZLE_CLEAN_MASK = 0x60

const OPT1_OFFSET = 34
const OPT1_COLD_WASH = 0x04
const OPT1_TURBO_WASH = 0x20
const OPT1_PRE_WASH = 0x40

const OPT2_OFFSET = 35
const OPT2_STEAM = 0x10

const OPT3_OFFSET = 36
const OPT3_FRESH_CARE = 0x40

const OPT4_OFFSET = 37
const OPT4_CONTROL_LOCK = 0x20
const OPT4_REMOTE_START = 0x10
const DOOR_LOCK_MASK = 0x01

const OPT5_OFFSET = 39
const OPT5_DELAY_START = 0x80
const OPT5_DRAWER_CLOSED = 0x04

const OPT6_OFFSET = 40
// Set and cleared with f0 24 10 01 <1|0>, which the cloud sends in answer to the washer's 7f 03 after a
// reconnect; the LG cloud sends this washer 0, overriding a setting from HA. While set, a cycle ends in End remote maintain on and the washer stays
// on, instead of reporting End and powering itself off ~17 s later.
const OPT6_REMOTE_MAINTAIN = 0x04
const OPT6_CYCLE_OPTIMIZATION = 0x08

const OPT7_OFFSET = 50
const OPT7_QUICK_LOAD_SENSE = 0x04

const CONFIRMED_STATE_MS = 30_000
const STATE_POWEROFF = 0

// modelJSON state indices
const STATE = Enum.of({
    Off: 0,
    Standby: 1,
    Paused: 2,
    Detecting: 3,
    Filling: 5,
    'Detecting load': 6,
    Reserved: 7,
    Soak: 8,
    'Pre-wash': 9,
    Washing: 11,
    Rinsing: 12,
    'Rinse hold': 13,
    Spinning: 14,
    Drying: 15,
    Finished: 16,
    Refreshing: 21,
    'Error auto off': 23,
    'Frozen prevent initial': 27,
    'Frozen prevent pause': 28,
    'Frozen prevent running': 29,
    'Audible diagnosis': 34,
    'Auto DT open pause': 35,
    'Confirm start for control': 36,
    'Clothing recognition': 37,
    'Detergent input': 38,
    'Softener input': 39,
    'Pollution detecting': 40,
    'Tub Cleaning': 41,
    'End remote maintain on': 42,
    Steam: 43,
    'Laundry care': 47,
    'EZDispense cleaning': 48,
})

const COURSE = Enum.of({
    Allergiene: 5,
    Bedding: 13,
    'Color Care': 18,
    Delicates: 22,
    'Hand/Wool': 34,
    'Heavy Duty': 35,
    Jeans: 38,
    'Kids Wear': 39,
    Normal: 46,
    'Overnight Wash': 47,
    'Perm. Press': 48,
    'Rinse + Spin': 55,
    Sanitary: 60,
    'Small Load': 68,
    'Quick Wash': 74,
    'Spin Only': 78,
    Towels: 84,
    'Tub Clean': 85,
    'Bright Whites': 90,
    'Active Wear': 99,
    'Sweat Stains': 113,
    'AI Wash': 114,
    'ezDispense Nozzle Clean': 128,
    Swimwear: 130,
    Dresses: 131,
    'Large Load': 132,
    'X Large Load': 133,
})

// download ids, which differ from the rec[20] codes
const DOWNLOADED_COURSE_ID: Partial<Record<string, number>> = {
    'Overnight Wash': 106,
}

// 0 on courses without the setting, here and for temp and spin
const SOIL = Enum.of({
    Light: 1,
    'Med. Light': 2,
    Medium: 3,
    'Med. Heavy': 4,
    Heavy: 5,
})

const TEMP = Enum.of({
    'Tap Cold': 13,
    Cold: 14,
    Warm: 16,
    Hot: 18,
    'Ex. Hot': 19,
})

const RINSE = Enum.of({
    Normal: 14,
    '+1': 15,
    '+2': 16,
    '+3': 17,
})

const SPIN = Enum.of({
    'No Spin': 12,
    Low: 13,
    Medium: 14,
    High: 15,
    'Ex. High': 16,
})

const BUZZER = Enum.of({
    Off: 0,
    Low: 1,
    Medium: 2,
    High: 3,
    'Very High': 4,
})

// panel order
const DISPENSE_LEVEL = Enum.of({
    Off: 0,
    Minimum: 4,
    Less: 1,
    Normal: 2,
    More: 3,
    Maximum: 5,
})

const SOFTENER_TANK_USE = Enum.of({
    Softener: 0,
    'Link Tanks': 1,
})

const NOZZLE_CLEAN = Enum.of({
    'Detergent Tank': 0x20,
    'Softener Tank': 0x40,
    'Both Tanks': 0x60,
})

// modelJSON INIT_LCD_<n> keys (not label indices)
const SPLASH_SCREEN = new Enum<string>([
    ['Normal', 0],
    ['Snowman 1', 1],
    ['Snowman 2', 2],
    ['Hello Winter', 3],
    ['Sprout', 4],
    ['Earth Day', 5],
    ['The Sun', 6],
    ['Beach Umbrella', 7],
    ['Fall Leaves', 8],
    ['Halloween', 9],
    ['Happy New Year', 10],
    ['Christmas', 11],
])

const onOff = (v: boolean) => (v ? 'ON' : 'OFF')
const hex2 = (v: number) => v.toString(16).padStart(2, '0')
const bit = (byte: number, mask: number) => ((byte & mask) !== 0 ? 1 : 0)

const RECORD_PROPERTIES = [
    { prop: 0x1f, key: 'temp', offset: 2 },
    { prop: 0x21, key: 'spin', offset: 4 },
    { prop: 0x1e, key: 'soil', offset: 1 },
    { prop: 0x20, key: 'rinse', offset: 3 },
    { prop: 0x3e, key: 'steam', offset: 35, mask: 0x10 },
    { prop: 0x34, key: 'pre_wash', offset: 34, mask: 0x40 },
    { prop: 0x38, key: 'cold_wash', offset: 34, mask: 0x04 },
    { prop: 0x35, key: 'turbo_wash', offset: 34, mask: 0x20 },
    { prop: 0x44, key: 'fresh_care', offset: 36, mask: 0x40 },
    { prop: 0x7f, key: 'reserve_time', offset: 11, width: 2 },
    { prop: 0x13, key: 'buzzer', offset: 29 },
    { prop: 0x4c, key: 'cycle_optimization', offset: 40, mask: 0x08 },
    { prop: 0x56, key: 'quick_load_sense', offset: 50, mask: 0x04 },
    { prop: 0x51, key: 'splash_screen', offset: 46 },
] as const

function recordValue(rec: Buffer, field: (typeof RECORD_PROPERTIES)[number]): number {
    if ('mask' in field) return bit(rec[field.offset], field.mask)
    return 'width' in field ? rec.readUInt16BE(field.offset) : rec[field.offset]
}
function applyRecordValue(rec: Buffer, field: (typeof RECORD_PROPERTIES)[number], value: number) {
    if ('mask' in field) rec[field.offset] = (rec[field.offset] & ~field.mask) | (value ? field.mask : 0)
    else if ('width' in field) rec.writeUInt16BE(value, field.offset)
    else rec[field.offset] = value
}
function propertyIds(inner: Buffer): number[] | undefined {
    if (
        inner.length < 7 ||
        inner[0] !== 0xf0 ||
        inner[1] !== 0xe5 ||
        inner[2] !== 0 ||
        inner[3] !== 2 ||
        inner[4] !== 1 ||
        ![0xff, 0x33].includes(inner[5])
    )
        return
    const ids: number[] = []
    let offset = 7
    for (let i = 0; i < inner[6]; i++) {
        if (offset >= inner.length) return
        const id = inner[offset]
        ids.push(id)
        offset += id === 0x7f ? 3 : 2
    }
    if (offset !== inner.length || new Set(ids).size !== ids.length) return
    return ids
}

export default class Device extends AABBDevice {
    protected override readonly strictWriteTracking = true
    private acceptedPower?: { value: boolean; until: number }
    private acceptedRemoteMaintain?: { value: boolean; until: number }
    private generation = 0
    private lastRecord?: Buffer
    private readonly sentGenerations: { inner: string; generation: number }[] = []
    private readonly confirmed = new Map<number, { value: number; until: number }>()
    private readonly pending = new Map<string, number>()
    private readonly pendingOwners = new Map<string, object>()
    private publishingRecord = false
    private bundleGroup?: Map<BundleKey, number>
    private bundleGroupId = 0
    private confirmedCourse?: {
        code: number
        loaded: number
        previousCode?: number
        previousLoaded?: number
        until: number
    }
    private readonly trackGeneration = (type: string, frame: Buffer) => {
        if (
            type === 'packet' &&
            !this.writesBlocked &&
            frame[0] === 0xaa &&
            frame[frame.length - 1] === 0xbb &&
            this.writeType(frame.subarray(2, -2)) !== undefined
        )
            this.sentGenerations.push({ inner: frame.subarray(2, -2).toString('hex'), generation: this.generation })
    }
    private writeGeneration(write: AwaitedWrite): number | undefined {
        const i = this.sentGenerations.findIndex((entry) => entry.inner === write.inner.toString('hex'))
        return i < 0 ? undefined : this.sentGenerations.splice(i, 1)[0].generation
    }
    protected override writeTimedOut() {
        this.acceptedPower = undefined
        this.acceptedRemoteMaintain = undefined
        this.bundle.clear()
        this.pending.clear()
        this.pendingOwners.clear()
        this.confirmed.clear()
        this.confirmedCourse = undefined
        this.sentGenerations.length = 0
        this.lastRecord = undefined
        this.bundleGroup = undefined
        this.setProblem('Command timed out; reconnect before sending more commands')
    }
    override drop() {
        this.acceptedPower = undefined
        this.acceptedRemoteMaintain = undefined
        this.thinq.off('sendData', this.trackGeneration)
        this.pending.clear()
        this.pendingOwners.clear()
        this.confirmed.clear()
        this.sentGenerations.length = 0
        super.drop()
    }
    override publishProperty(prop: string, value: string | number | undefined) {
        if (this.publishingRecord && this.pending.has(prop)) return
        super.publishProperty(prop, value)
    }
    private context(requireCourse = true) {
        if (this.writesBlocked) return false
        const r = this.lastRecord
        if (!r || !STATE.map(r[21]) || r[21] === 0 || (requireCourse && r[5] === 0)) {
            this.setProblem(
                requireCourse && r?.[5] === 0 ? NO_COURSE_REASON : 'Command needs a current known powered-on status',
            )
            return false
        }
        return true
    }

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        thinq.on('sendData', this.trackGeneration)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:power',
                    },
                    cycle_finished: {
                        platform: 'event',
                        unique_id: '$deviceid-cycle_finished',
                        state_topic: '$this/cycle_finished',
                        name: 'Cycle finished',
                        event_types: ['finished'],
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start',
                        icon: 'mdi:remote',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATE.options,
                    },
                    course: {
                        platform: 'select',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        command_topic: '$this/course/set',
                        options: COURSE.options,
                        name: 'Course',
                        icon: 'mdi:washing-machine',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        payload_press: '',
                        name: 'Resume',
                        icon: 'mdi:play-pause',
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
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Total Time',
                        icon: 'mdi:timer-sand',
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
                    reserve_time: {
                        platform: 'number',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        command_topic: '$this/reserve_time/set',
                        min: 0,
                        max: RESERVE_TIME_MAX,
                        step: RESERVE_TIME_STEP,
                        mode: 'box',
                        name: 'Delay Start time',
                        icon: 'mdi:clock-start',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    delay_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_start',
                        state_topic: '$this/delay_start',
                        name: 'Delay Start',
                        icon: 'mdi:clock-plus-outline',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    drawer: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drawer',
                        state_topic: '$this/drawer',
                        name: 'ezDispense drawer',
                        device_class: 'opening',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since drum clean',
                        icon: 'mdi:washing-machine-alert',
                        // no state_class: resets at each Tub Clean
                        entity_category: 'diagnostic',
                    },
                    // refused while off
                    buzzer: {
                        platform: 'select',
                        unique_id: '$deviceid-buzzer',
                        state_topic: '$this/buzzer',
                        command_topic: '$this/buzzer/set',
                        options: BUZZER.options,
                        name: 'Buzzer',
                        icon: 'mdi:volume-high',
                        entity_category: 'config',
                    },
                    soil: {
                        platform: 'select',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        command_topic: '$this/soil/set',
                        options: SOIL.options,
                        name: 'Soil level',
                        icon: 'mdi:water',
                    },
                    spin: {
                        platform: 'select',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        command_topic: '$this/spin/set',
                        options: SPIN.options,
                        name: 'Spin',
                        icon: 'mdi:rotate-right',
                    },
                    temp: {
                        platform: 'select',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        command_topic: '$this/temp/set',
                        options: TEMP.options,
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    rinse: {
                        platform: 'select',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        command_topic: '$this/rinse/set',
                        options: RINSE.options,
                        name: 'Extra Rinse',
                        icon: 'mdi:water',
                    },
                    turbo_wash: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        command_topic: '$this/turbo_wash/set',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    cold_wash: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        command_topic: '$this/cold_wash/set',
                        name: 'Cold Wash',
                        icon: 'mdi:water',
                    },
                    pre_wash: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        command_topic: '$this/pre_wash/set',
                        name: 'Pre-wash',
                        icon: 'mdi:water',
                    },
                    steam: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        command_topic: '$this/steam/set',
                        name: 'Steam',
                        icon: 'mdi:weather-windy',
                    },
                    fresh_care: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        command_topic: '$this/fresh_care/set',
                        name: 'Fresh Care',
                        icon: 'mdi:weather-windy',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Control Lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    ez_dispense_detergent: {
                        platform: 'sensor',
                        unique_id: '$deviceid-ez_dispense_detergent',
                        state_topic: '$this/ez_dispense_detergent',
                        name: 'Detergent Level',
                        icon: 'mdi:cup-water',
                        device_class: 'enum',
                        options: DISPENSE_LEVEL.options,
                    },
                    ez_dispense_softener: {
                        platform: 'sensor',
                        unique_id: '$deviceid-ez_dispense_softener',
                        state_topic: '$this/ez_dispense_softener',
                        name: 'Softener Level',
                        icon: 'mdi:cup-water',
                        device_class: 'enum',
                        options: DISPENSE_LEVEL.options,
                    },
                    detergent_amount: {
                        platform: 'sensor',
                        unique_id: '$deviceid-detergent_amount',
                        state_topic: '$this/detergent_amount',
                        name: 'Default detergent amount',
                        icon: 'mdi:flask',
                        device_class: 'volume',
                        unit_of_measurement: 'mL',
                    },
                    softener_amount: {
                        platform: 'sensor',
                        unique_id: '$deviceid-softener_amount',
                        state_topic: '$this/softener_amount',
                        name: 'Default softener amount',
                        icon: 'mdi:flower',
                        device_class: 'volume',
                        unit_of_measurement: 'mL',
                    },
                    softener_tank_use: {
                        platform: 'sensor',
                        unique_id: '$deviceid-softener_tank_use',
                        state_topic: '$this/softener_tank_use',
                        name: 'Softener Tank Use',
                        icon: 'mdi:link-variant',
                        device_class: 'enum',
                        options: SOFTENER_TANK_USE.options,
                        entity_category: 'diagnostic',
                    },
                    nozzle_clean_tank: {
                        platform: 'sensor',
                        unique_id: '$deviceid-nozzle_clean_tank',
                        state_topic: '$this/nozzle_clean_tank',
                        name: 'Nozzle Clean tank',
                        icon: 'mdi:spray-bottle',
                        device_class: 'enum',
                        options: NOZZLE_CLEAN.options,
                        entity_category: 'diagnostic',
                    },
                    cycle_optimization: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-cycle_optimization',
                        state_topic: '$this/cycle_optimization',
                        command_topic: '$this/cycle_optimization/set',
                        name: 'Cycle Optimization',
                        icon: 'mdi:auto-fix',
                        entity_category: 'config',
                    },
                    quick_load_sense: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-quick_load_sense',
                        state_topic: '$this/quick_load_sense',
                        command_topic: '$this/quick_load_sense/set',
                        name: 'QuickLoadSense',
                        icon: 'mdi:scale',
                        entity_category: 'config',
                    },
                    splash_screen: {
                        platform: 'select',
                        unique_id: '$deviceid-splash_screen',
                        state_topic: '$this/splash_screen',
                        command_topic: '$this/splash_screen/set',
                        options: SPLASH_SCREEN.options,
                        name: 'Splash screen',
                        icon: 'mdi:monitor',
                        entity_category: 'config',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                        payload_on: 'OFF',
                        payload_off: 'ON',
                        entity_category: 'diagnostic',
                    },
                    remote_maintain: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-remote_maintain',
                        state_topic: '$this/remote_maintain',
                        command_topic: '$this/remote_maintain/set',
                        name: 'Remote maintain',
                        icon: 'mdi:remote',
                        entity_category: 'config',
                    },
                    problem: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-problem',
                        state_topic: '$this/problem',
                        name: 'Problem',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    problem_reason: {
                        platform: 'sensor',
                        unique_id: '$deviceid-problem_reason',
                        state_topic: '$this/problem_reason',
                        name: 'Problem reason',
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    start() {
        this.publishProblem()
    }

    // Process-local: a finish notification at startup is never a new completion.
    private completionState: 'unarmed' | 'armed' | 'completed' = 'unarmed'

    override processData(frame: Buffer) {
        if (frame.length < 4 || frame[0] !== 0xaa || frame[frame.length - 1] !== 0xbb) return
        if (frame[1] === 0xff) {
            if (
                frame.length < 18 ||
                frame[2] !== CLASS_BYTE ||
                frame[3] !== ENVELOPE_TYPE ||
                frame.readUInt16BE(4) !== frame.length ||
                frame.readUInt16BE(13) !== frame.length - 18 ||
                crc16(frame.subarray(0, -3)) !== frame.readUInt16BE(frame.length - 3)
            )
                return
            if (
                frame[12] === STATUS_FRAME_TYPE &&
                (frame[13] !== 0 || frame[14] !== STATUS_INNER_LEN || frame[15] !== 0 || frame[15 + RECORD_LEN] !== 0)
            )
                return
            if (frame[12] === SINGLE_STATUS_FRAME_TYPE && frame[15] !== 0) return
        } else {
            if (frame[1] !== frame.length) return
            const sum = frame.subarray(0, -2).reduce((a, b) => a + b, 0)
            if (((sum & 0xff) ^ 0x55) !== frame[frame.length - 2]) return
        }
        super.processData(frame)
    }

    // BUNDLE values from the last record, plus writes not yet reflected in one
    private readonly bundle = new Map<BundleKey, number>()
    private course?: { code: number; loaded: number; on: boolean }

    // Why the last command from HA failed; cleared by the next one that goes through, or, for NO_COURSE_REASON,
    // by a record with a course.
    private problem?: string

    private setProblem(reason: string | undefined) {
        if (reason === this.problem) return
        this.problem = reason
        this.publishProblem()
    }

    private publishProblem() {
        this.publishProperty('problem', onOff(this.problem !== undefined))
        this.publishProperty('problem_reason', this.problem ?? 'OK')
    }

    private writeProps(...pairs: number[]) {
        const inner = Buffer.from([...SET_PROPERTY, pairs.length / 2, ...pairs])
        const courseStart =
            pairs[0] === PROP_COURSE &&
            pairs.length === 4 &&
            pairs[2] === PROP_CYCLE &&
            pairs[3] === CYCLE.unmap('start')
        const barrier = [PROP_COURSE, PROP_POWER, PROP_CYCLE].includes(pairs[0])
        this.bundleGroup = undefined
        this.bundleGroupId++
        const owner = {}
        const field = RECORD_PROPERTIES.find((field) => field.prop === pairs[0])
        const key = barrier ? undefined : `singleton:${pairs[0]}`
        if (field) {
            this.pending.set(field.key, pairs[1])
            this.pendingOwners.set(field.key, owner)
        }
        if (pairs[0] === PROP_COURSE) {
            this.pending.set('course', pairs[1])
            this.pendingOwners.set('course', owner)
        }
        if (pairs[0] === PROP_POWER) {
            this.pending.set('power', pairs[1])
            this.pendingOwners.set('power', owner)
        }
        this.queueWrite(() => {
            if (field && this.pendingOwners.get(field.key) === owner) {
                this.pending.delete(field.key)
                this.pendingOwners.delete(field.key)
            }
            if (pairs[0] === PROP_COURSE && this.pendingOwners.get('course') === owner) {
                this.pending.delete('course')
                this.pendingOwners.delete('course')
            }
            if (pairs[0] === PROP_POWER && this.pendingOwners.get('power') === owner) {
                this.pending.delete('power')
                this.pendingOwners.delete('power')
            }
            if (pairs[0] !== PROP_POWER && !this.context(false)) return
            if (pairs[0] === PROP_POWER && this.writesBlocked) return
            if (courseStart) {
                if (!this.course || this.course.code === COURSE_DOWNLOADED) {
                    this.setProblem('Downloaded Start is not captured and is unsupported')
                    return
                }
                // A preceding course write may have settled while Start waited in the queue.
                inner[8] = this.course.code
            }
            if (pairs[0] === PROP_BUZZER) inner[5] = 0x33
            return inner
        }, key)
    }

    private writeCommand(command: number, value: number) {
        this.bundleGroup = undefined
        this.bundleGroupId++
        const inner = Buffer.from([...COMMAND, command, 0x01, value])
        const owner = {}
        this.pending.set('remote_maintain', value)
        this.pendingOwners.set('remote_maintain', owner)
        this.queueWrite(() => {
            if (this.pendingOwners.get('remote_maintain') === owner) {
                this.pending.delete('remote_maintain')
                this.pendingOwners.delete('remote_maintain')
            }
            return this.context(false) ? inner : undefined
        })
    }

    protected writeType(inner: Buffer) {
        if (inner[0] !== SET_PROPERTY[0]) return undefined
        return inner[1] === SET_PROPERTY[1] || inner[1] === COMMAND[1] ? inner[1] : undefined
    }

    private processCommandReply(buf: Buffer) {
        if (buf.length !== 4 || buf[2] !== COMMAND[1]) return
        const write = this.writeAnswered(COMMAND[1])
        if (!write) return
        const generation = this.writeGeneration(write)
        if (generation !== this.generation) return
        if (write.own) this.setProblem(buf[3] === COMMAND_OK ? undefined : `Command refused (0x${hex2(buf[3])})`)
        // This ACK has no record: acceptance of the exact request is not an observed setting.
        if (
            buf[3] === COMMAND_OK &&
            write.inner.length === 5 &&
            write.inner[2] === COMMAND_REMOTE_MAINTAIN &&
            write.inner[3] === 1 &&
            [0, 1].includes(write.inner[4])
        ) {
            this.acceptedRemoteMaintain = { value: write.inner[4] === 1, until: Date.now() + CONFIRMED_STATE_MS }
            if (!this.pending.has('remote_maintain'))
                this.publishProperty('remote_maintain', onOff(this.acceptedRemoteMaintain.value))
        }
    }

    private writeBundle(key: BundleKey, value: number) {
        if (!this.context() || this.bundle.size !== BUNDLE.length) return
        if (!this.bundleGroup) this.bundleGroupId++
        const groupId = this.bundleGroupId
        const edits = this.bundleGroup ?? new Map<BundleKey, number>()
        this.bundleGroup = edits
        edits.set(key, value)
        this.pending.set(key, value)
        this.pendingOwners.set(key, edits)
        if (key === 'cold_wash' && value === 1) {
            edits.set('temp', COLD_WASH_TEMP)
            edits.set('soil', COLD_WASH_SOIL)
            this.pending.set('temp', COLD_WASH_TEMP)
            this.pending.set('soil', COLD_WASH_SOIL)
            this.pendingOwners.set('temp', edits)
            this.pendingOwners.set('soil', edits)
        }
        this.queueWrite(() => {
            if (this.bundleGroup === edits) this.bundleGroup = undefined
            for (const key of edits.keys())
                if (this.pendingOwners.get(key) === edits) {
                    this.pending.delete(key)
                    this.pendingOwners.delete(key)
                }
            if (!this.context() || this.bundle.size !== BUNDLE.length) return
            const values = new Map(this.bundle)
            if (this.lastRecord)
                for (const field of RECORD_PROPERTIES) {
                    const confirmed = this.confirmed.get(field.prop)
                    if (confirmed && Date.now() >= confirmed.until && BUNDLE.some((entry) => entry.key === field.key)) {
                        this.confirmed.delete(field.prop)
                        values.set(field.key as BundleKey, recordValue(this.lastRecord, field))
                    }
                }
            for (const [key, value] of edits) values.set(key, value)
            if (
                values.get('cold_wash') === 1 &&
                (values.get('temp') !== COLD_WASH_TEMP || values.get('soil')! > COLD_WASH_SOIL)
            ) {
                this.setProblem('Cold Wash requires Cold temperature and soil no higher than Medium')
                return
            }
            if (
                ![0, ...Object.keys(TEMP.forward).map(Number)].includes(values.get('temp')!) ||
                ![0, ...Object.keys(SPIN.forward).map(Number)].includes(values.get('spin')!) ||
                ![0, ...Object.keys(SOIL.forward).map(Number)].includes(values.get('soil')!) ||
                ![0, ...Object.keys(RINSE.forward).map(Number)].includes(values.get('rinse')!) ||
                !(
                    values.get('reserve_time') === 0 ||
                    (values.get('reserve_time')! >= RESERVE_TIME_MIN &&
                        values.get('reserve_time')! <= RESERVE_TIME_MAX &&
                        values.get('reserve_time')! % RESERVE_TIME_STEP === 0)
                )
            ) {
                this.setProblem('Incomplete or unsupported settings in current status')
                return
            }
            const body = BUNDLE.flatMap(({ prop, key, width }) => {
                const v = values.get(key)!
                return width === 2 ? [prop, v >> 8, v & 0xff] : [prop, v]
            })
            return Buffer.from([...SET_PROPERTY, BUNDLE.length, ...body])
        }, `bundle:${groupId}`)
    }

    // The app sends Start with the course: 0a <code> 03 01.
    private writeCycle(cycle: number) {
        if (cycle !== CYCLE.unmap('start')) return this.writeProps(PROP_CYCLE, cycle)
        if (!this.course) return
        if (this.course.code !== COURSE_DOWNLOADED)
            return this.writeProps(PROP_COURSE, this.course.code, PROP_CYCLE, cycle)
        this.setProblem('Downloaded Start is not captured and is unsupported')
    }

    setProperty(prop: string, value: string) {
        if (this.writesBlocked) return
        if (prop !== 'power' && !this.context(false)) return
        const cycle = CYCLE.unmap(prop)
        if (cycle !== undefined) return this.writeCycle(cycle)
        if (BUNDLE_SWITCHES.includes(prop as BundleKey)) {
            if (value === 'ON' || value === 'OFF') this.writeBundle(prop as BundleKey, value === 'ON' ? 1 : 0)
            return
        }
        const setting = { soil: SOIL, temp: TEMP, rinse: RINSE, spin: SPIN }[prop]
        if (setting) {
            const idx = setting.unmap(value)
            if (idx === undefined) return
            const coldWash = this.pending.get('cold_wash') ?? this.bundle.get('cold_wash')
            if (prop === 'soil' && coldWash === 1 && idx > COLD_WASH_SOIL) return
            this.writeBundle(prop as BundleKey, idx)
            return
        }

        if (prop === 'power') {
            if (value === 'ON' || value === 'OFF') this.writeProps(PROP_POWER, value === 'ON' ? 1 : 0)
        } else if (prop === 'buzzer') {
            const idx = BUZZER.unmap(value)
            if (idx !== undefined) this.writeProps(PROP_BUZZER, idx)
        } else if (prop === 'reserve_time') {
            const minutes = Number(value)
            if (
                Number.isInteger(minutes) &&
                (minutes === 0 || (minutes >= RESERVE_TIME_MIN && minutes <= RESERVE_TIME_MAX)) &&
                minutes % RESERVE_TIME_STEP === 0
            )
                this.writeBundle('reserve_time', minutes)
        } else if (prop === 'cycle_optimization' || prop === 'quick_load_sense') {
            if (value !== 'ON' && value !== 'OFF') return
            const p = prop === 'quick_load_sense' ? PROP_QUICK_LOAD_SENSE : PROP_CYCLE_OPTIMIZATION
            this.writeProps(p, value === 'ON' ? 1 : 0)
        } else if (prop === 'remote_maintain') {
            if (value === 'ON' || value === 'OFF') this.writeCommand(COMMAND_REMOTE_MAINTAIN, value === 'ON' ? 1 : 0)
        } else if (prop === 'splash_screen') {
            const idx = SPLASH_SCREEN.unmap(value)
            if (idx !== undefined) this.writeProps(PROP_SPLASH_SCREEN, idx)
        } else if (prop === 'course') {
            const id = DOWNLOADED_COURSE_ID[value]
            const code = COURSE.unmap(value)
            if (id !== undefined) this.writeProps(PROP_COURSE, COURSE_DOWNLOADED, PROP_DOWNLOADED_COURSE, id)
            else if (code !== undefined) this.writeProps(PROP_COURSE, code)
        }
    }

    processAABB(buf: Buffer) {
        if (buf.length < 2 || buf[0] !== CLASS_BYTE) return
        if (buf[1] === DRAWER_FRAME_TYPE) return this.processDrawer(buf)
        if (buf[1] === COMMAND_REPLY_TYPE) return this.processCommandReply(buf)
        if (buf[1] === WRITE_REPLY_TYPE) {
            if (buf.length < 7 || buf[2] !== 0 || buf[3] !== 2 || buf[4] !== 1 || ![0xff, 0x33].includes(buf[5])) return
            const count = buf[6]
            const recordOffset = 7 + 2 * count
            if (!count || buf.length !== recordOffset + RECORD_LEN || buf[recordOffset] !== 0) return
            const properties = Array.from({ length: count }, (_, i) => buf[7 + i * 2])
            if (new Set(properties).size !== count) return
            const results = properties.map((_, i) => buf[8 + i * 2])
            const write = this.writeAnswered(SET_PROPERTY[1], (write) => {
                const expected = propertyIds(write.inner)
                return (
                    expected !== undefined &&
                    expected.length === properties.length &&
                    expected.every((id) => properties.includes(id))
                )
            })
            if (!write) return
            const generation = this.writeGeneration(write)
            const failed = results.find((result) => !WRITE_OK.has(result))
            if (write.own) this.setProblem(failed === undefined ? undefined : `Command refused (0x${hex2(failed)})`)
            if (generation !== this.generation) return
            const record = buf.subarray(recordOffset)
            const accepted = (id: number) => {
                const index = properties.indexOf(id)
                return index >= 0 && WRITE_OK.has(results[index])
            }
            if (accepted(PROP_COURSE) || accepted(PROP_POWER)) {
                this.generation++
                this.acceptedPower = undefined
                this.acceptedRemoteMaintain = undefined
                this.confirmed.clear()
                this.bundle.clear()
                // Accepted course defaults are private command context, never a state echo.
                if (accepted(PROP_COURSE)) {
                    const requestedCourse = write.inner[8]
                    const requestedDownloaded = write.inner[9] === PROP_DOWNLOADED_COURSE ? write.inner[10] : undefined
                    const expectedLoaded =
                        requestedCourse === COURSE_DOWNLOADED
                            ? COURSE.unmap(
                                  Object.entries(DOWNLOADED_COURSE_ID).find(
                                      ([, id]) => id === requestedDownloaded,
                                  )?.[0] ?? '',
                              )
                            : requestedCourse
                    if (record[5] !== requestedCourse || record[20] !== expectedLoaded) {
                        this.lastRecord = undefined
                        this.confirmedCourse = undefined
                        this.setProblem('Accepted course reply has stale course context; waiting for status')
                        return
                    }
                    this.confirmedCourse = {
                        code: record[5],
                        loaded: record[20],
                        previousCode: this.lastRecord?.[5],
                        previousLoaded: this.lastRecord?.[20],
                        until: Date.now() + CONFIRMED_STATE_MS,
                    }
                    if (!this.pending.has('course'))
                        this.publishProperty(
                            'course',
                            COURSE.map(record[5] === COURSE_DOWNLOADED ? record[20] : record[5]),
                        )
                    this.lastRecord = Buffer.from(record)
                    this.course = { code: record[5], loaded: record[20], on: record[21] !== 0 }
                    this.loadBundle(record)
                } else {
                    const requestedPower =
                        write.inner.length === 9 && write.inner[7] === PROP_POWER ? write.inner[8] : undefined
                    const observedPower = record[21] !== 0
                    if ((requestedPower === 0 || requestedPower === 1) && observedPower === (requestedPower === 1)) {
                        this.acceptedPower = { value: observedPower, until: Date.now() + CONFIRMED_STATE_MS }
                        if (!this.pending.has('power')) this.publishProperty('power', onOff(observedPower))
                    }
                    this.lastRecord = undefined
                    this.confirmedCourse = undefined
                }
                return
            }
            for (const field of RECORD_PROPERTIES) {
                if (!accepted(field.prop)) continue
                const value = recordValue(record, field)
                this.confirmed.set(field.prop, { value, until: Date.now() + CONFIRMED_STATE_MS })
                if (BUNDLE.some((entry) => entry.key === field.key)) this.bundle.set(field.key as BundleKey, value)
            }
            // Publish only matched accepted fields from this reply; all other values remain as observed.
            this.publishAccepted(record, properties.filter(accepted))
            return
        }
        if (buf.length < 13 || buf[1] !== ENVELOPE_TYPE) return

        const innerLen = buf.readUInt16BE(INNER_LEN_OFFSET)
        switch (buf[INNER_TYPE_OFFSET]) {
            case STATUS_FRAME_TYPE:
                if (innerLen !== STATUS_INNER_LEN) return
                return this.processStatus(buf, STATUS_RECORD_OFFSET, STATUS_BUF_LEN)
            case SINGLE_STATUS_FRAME_TYPE:
                if (innerLen !== SINGLE_INNER_LEN) return
                return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_BUF_LEN)
            case EVENT_FRAME_TYPE:
                if (
                    innerLen === COMPLETION_INNER_LEN &&
                    buf.length === 13 + COMPLETION_INNER_LEN + 1 &&
                    buf.subarray(13, 19).equals(COMPLETION_PREFIX)
                ) {
                    if (this.completionState === 'armed') {
                        this.completionState = 'completed'
                        this.HA.publishProperty(this.id, 'cycle_finished', JSON.stringify({ event_type: 'finished' }), {
                            retain: false,
                        })
                    }
                    return
                }
                if (innerLen !== DOOR_EVENT_INNER_LEN) return
                return this.processDoorEvent(buf)
        }
    }

    private publishAccepted(record: Buffer, ids: number[]) {
        for (const field of RECORD_PROPERTIES) {
            if (!ids.includes(field.prop) || this.pending.has(field.key)) continue
            const value = recordValue(record, field)
            const settings: Partial<Record<string, Enum<string>>> = {
                temp: TEMP,
                spin: SPIN,
                soil: SOIL,
                rinse: RINSE,
                buzzer: BUZZER,
                splash_screen: SPLASH_SCREEN,
            }
            const setting = settings[field.key]
            this.publishProperty(
                field.key,
                setting ? setting.map(value) : field.key === 'reserve_time' ? value : onOff(value !== 0),
            )
        }
    }

    private reconcileFeedback(key: 'acceptedPower' | 'acceptedRemoteMaintain', observed: boolean) {
        const accepted = this[key]
        if (!accepted) return observed
        if (observed === accepted.value || Date.now() >= accepted.until) {
            if (observed !== accepted.value)
                this.setProblem('Accepted feedback expired before a matching status report')
            this[key] = undefined
            return observed
        }
        return accepted.value
    }

    private loadBundle(rec: Buffer) {
        for (const field of RECORD_PROPERTIES)
            if (BUNDLE.some((entry) => entry.key === field.key))
                this.bundle.set(field.key as BundleKey, recordValue(rec, field))
    }

    // The panel menu event (id 0x11) has the same length.
    private processDoorEvent(buf: Buffer) {
        if (buf.length !== DOOR_EVENT_BUF_LEN) return
        if (!buf.subarray(13, 18).equals(DOOR_EVENT_PREFIX)) return
        const door = buf[DOOR_EVENT_VALUE_OFFSET]
        if (door !== DOOR_OPEN && door !== DOOR_SHUT) return
        this.publishProperty('door', door === DOOR_OPEN ? 'ON' : 'OFF')
    }

    private processDrawer(buf: Buffer) {
        if (buf.length !== DRAWER_BUF_LEN) return
        this.publishProperty('drawer', buf[2] === DRAWER_OPEN ? 'ON' : 'OFF')
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return
        const rec = Buffer.from(buf.subarray(recordOffset, recordOffset + RECORD_LEN))
        const previous = this.lastRecord
        const confirmedCourse = this.confirmedCourse
        if (confirmedCourse) {
            if (rec[21] === 0 || (rec[5] === confirmedCourse.code && rec[20] === confirmedCourse.loaded))
                this.confirmedCourse = undefined
            else if (
                rec[5] === confirmedCourse.previousCode &&
                rec[20] === confirmedCourse.previousLoaded &&
                Date.now() < confirmedCourse.until
            ) {
                // The rest of this old-course record is stale too; never pair the new course with its defaults.
                return
            } else {
                if (Date.now() >= confirmedCourse.until)
                    this.setProblem('Confirmed course expired before a matching status report')
                this.confirmedCourse = undefined
            }
        }
        if (previous && (previous[5] !== rec[5] || previous[20] !== rec[20] || (rec[21] === 0 && previous[21] !== 0))) {
            this.generation++
            if (previous[5] !== rec[5] || previous[20] !== rec[20]) this.acceptedPower = undefined
            this.acceptedRemoteMaintain = undefined
            this.confirmed.clear()
        }
        this.lastRecord = Buffer.from(rec)
        for (const field of RECORD_PROPERTIES) {
            const confirmed = this.confirmed.get(field.prop)
            if (!confirmed) continue
            if (Date.now() >= confirmed.until || recordValue(rec, field) === confirmed.value) {
                if (Date.now() >= confirmed.until && recordValue(rec, field) !== confirmed.value)
                    this.setProblem('Confirmed setting expired before a matching status report')
                this.confirmed.delete(field.prop)
            } else applyRecordValue(rec, field, confirmed.value)
        }

        const state = rec[STATE_OFFSET]
        if (state === 0 || state === 1) this.completionState = 'unarmed'
        else if (this.completionState === 'unarmed' && [11, 12, 14, 41].includes(state)) this.completionState = 'armed'
        const isOff = state === STATE_POWEROFF
        const course = rec[COURSE_OFFSET]

        this.course = { code: course, loaded: rec[LOADED_COURSE_OFFSET], on: !isOff }
        if (this.problem === NO_COURSE_REASON && course !== NO_COURSE) this.setProblem(undefined)
        this.bundle.set('temp', rec[TEMP_OFFSET])
        this.bundle.set('spin', rec[SPIN_OFFSET])
        this.bundle.set('soil', rec[SOIL_OFFSET])
        this.bundle.set('rinse', rec[RINSE_OFFSET])
        this.bundle.set('steam', bit(rec[OPT2_OFFSET], OPT2_STEAM))
        this.bundle.set('pre_wash', bit(rec[OPT1_OFFSET], OPT1_PRE_WASH))
        this.bundle.set('cold_wash', bit(rec[OPT1_OFFSET], OPT1_COLD_WASH))
        this.bundle.set('turbo_wash', bit(rec[OPT1_OFFSET], OPT1_TURBO_WASH))
        this.bundle.set('fresh_care', bit(rec[OPT3_OFFSET], OPT3_FRESH_CARE))
        this.bundle.set('reserve_time', rec.readUInt16BE(RESERVE_TIME_OFFSET))

        this.publishingRecord = true
        this.publishProperty('power', onOff(this.reconcileFeedback('acceptedPower', !isOff)))
        this.publishProperty('status', STATE.map(state))
        this.publishProperty('course', COURSE.map(course === COURSE_DOWNLOADED ? rec[LOADED_COURSE_OFFSET] : course))
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('rinse', RINSE.map(rec[RINSE_OFFSET]))
        this.publishProperty(
            'remaining_time',
            state === 0 || state === 1
                ? undefined
                : course === 85 && state === 16
                  ? 0
                  : rec.readUInt16LE(REMAIN_TIME_OFFSET),
        )
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_TIME_OFFSET])
        this.publishProperty('energy', rec.readUInt16BE(SPENT_POWER_OFFSET))
        this.publishProperty('reserve_time', rec.readUInt16BE(RESERVE_TIME_OFFSET))
        this.publishProperty('delay_start', (rec[OPT5_OFFSET] & OPT5_DELAY_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('tub_clean_count', rec[TUB_CLEAN_COUNT_OFFSET])
        this.publishProperty('buzzer', BUZZER.map(rec[BUZZER_OFFSET]))
        this.publishProperty('ez_dispense_detergent', DISPENSE_LEVEL.map(rec[DETERGENT_LEVEL_OFFSET]))
        this.publishProperty('ez_dispense_softener', DISPENSE_LEVEL.map(rec[SOFTENER_LEVEL_OFFSET]))
        this.publishProperty('detergent_amount', rec[DETERGENT_AMOUNT_OFFSET])
        this.publishProperty('softener_amount', rec[SOFTENER_AMOUNT_OFFSET])
        this.publishProperty('softener_tank_use', SOFTENER_TANK_USE.map(rec[SOFTENER_TANK_USE_OFFSET]))
        this.publishProperty('nozzle_clean_tank', NOZZLE_CLEAN.map(rec[NOZZLE_CLEAN_OFFSET] & NOZZLE_CLEAN_MASK))

        const opt1 = rec[OPT1_OFFSET]
        this.publishProperty('turbo_wash', (opt1 & OPT1_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('cold_wash', (opt1 & OPT1_COLD_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (opt1 & OPT1_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (rec[OPT2_OFFSET] & OPT2_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', (rec[OPT3_OFFSET] & OPT3_FRESH_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (rec[OPT4_OFFSET] & OPT4_CONTROL_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('cycle_optimization', (rec[OPT6_OFFSET] & OPT6_CYCLE_OPTIMIZATION) !== 0 ? 'ON' : 'OFF')
        this.publishProperty(
            'remote_maintain',
            onOff(this.reconcileFeedback('acceptedRemoteMaintain', (rec[OPT6_OFFSET] & OPT6_REMOTE_MAINTAIN) !== 0)),
        )
        this.publishProperty('door_lock', (rec[DOOR_LOCK_OFFSET] & DOOR_LOCK_MASK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', onOff((rec[OPT4_OFFSET] & OPT4_REMOTE_START) !== 0))
        this.publishProperty('drawer', (rec[OPT5_OFFSET] & OPT5_DRAWER_CLOSED) !== 0 ? 'OFF' : 'ON')
        this.publishProperty('quick_load_sense', onOff((rec[OPT7_OFFSET] & OPT7_QUICK_LOAD_SENSE) !== 0))
        this.publishProperty('splash_screen', SPLASH_SCREEN.map(rec[SPLASH_SCREEN_OFFSET]))
        this.publishingRecord = false
    }
}
