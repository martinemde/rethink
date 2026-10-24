import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice, { type AwaitedWrite } from './aabb_device'
import { Enum } from '@/util/enum'
import crc16 from '@/util/crc16'

// LG DLEX6700B electric dryer. BDH_D30007_US's framing and 42-byte record, but with a temperature
// setting and different option bits.
//
//     aa ff 30 0a 00 66 00 06 9c 00 01 00 ec 00 54 <payload> <chk16> bb
//           │  │  └─┬─┘    └─┬─┘       │  │  └─┬─┘
//           │  │    │        │         │  │    └ buf[11:13] payload length
//           │  │    │        │         │  └ buf[10] inner type
//           │  │    │        │         └ buf[9] delivery class: 0 sent once, else repeated until acked
//           │  │    │        └ buf[5:7] sequence
//           │  │    └ buf[2:4] frame length
//           │  └ buf[1] 0a envelope
//           └ buf[0] class, 0x30
//
// Inner types: 0xEC previous + current record; 0xEB current record (status query reply); 0x03 event:
//
//     0b 0a 02 04 0b 00 d6 00 12 01 1b 00 00 00 00 29 00 02
//     │                          │  │              │  │
//     │                          │  │              │  └ door (id 0a): 1 open
//     │                          │  │              └ the course's default minutes
//     │                          │  └ course, in the rec[20] numbering
//     │                          └ power: 0 off
//     └ id: 08 power-off, 0a door, 0b other

const CLASS_BYTE = 0x30
const ENVELOPE_TYPE = 0x0a
const INNER_TYPE_OFFSET = 10
const INNER_LEN_OFFSET = 11

const RECORD_LEN = 42

const STATUS_FRAME_TYPE = 0xec
const STATUS_INNER_LEN = 2 * RECORD_LEN
const STATUS_RECORD_OFFSET = 13 + RECORD_LEN // skip the "previous state" record
const STATUS_BUF_LEN = 13 + STATUS_INNER_LEN + 1

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_INNER_LEN = RECORD_LEN
const SINGLE_RECORD_OFFSET = 13
const SINGLE_BUF_LEN = 13 + SINGLE_INNER_LEN + 1

// Set property:
//
//     aa 0d f0 e5 00 02 01 ff 01 13 00 f7 bb
//                             │  └─┬─┘
//                             │    └ (prop, value) × count; the minute props (0x70) take 2 bytes, big-endian
//                             └ count
const SET_PROPERTY = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff]
const PROP_POWER = 0x02
const PROP_CYCLE = 0x03
const PROP_COURSE = 0x0a // 0xff, then PROP_DOWNLOADED_COURSE, for a downloaded course
const PROP_DOWNLOADED_COURSE = 0x0b
const PROP_BUZZER = 0x13
const PROP_CYCLE_OPTIMIZATION = 0x4c // switching it on moves the course to AI Dry
const PROP_SPLASH_SCREEN = 0x51
const PROP_KEEP_FRESH = 0x57

const COURSE_DOWNLOADED = 0xff
const CYCLE = Enum.of({ start: 1, pause: 2, resume: 3 })

// The app always writes these together, in this order.
const BUNDLE = [
    { prop: 0x20, key: 'temp', width: 1 },
    { prop: 0x1e, key: 'dry_level', width: 1 },
    { prop: 0x3f, key: 'steam', width: 1 },
    { prop: 0x34, key: 'damp_dry_signal', width: 1 },
    { prop: 0x38, key: 'energy_saver', width: 1 },
    { prop: 0x36, key: 'low_static', width: 1 },
    { prop: 0x0f, key: 'wrinkle_care', width: 1 },
    { prop: 0x70, key: 'dry_time', width: 2 },
] as const
type BundleKey = (typeof BUNDLE)[number]['key']
const BUNDLE_SWITCHES: BundleKey[] = ['steam', 'damp_dry_signal', 'energy_saver', 'low_static', 'wrinkle_care']

// Write reply. Results: 0x00/0x10 accepted, 0x11 unchanged, 0x03 refused (e.g. chime while off), 0x13 busy,
// 0x17 refused (every property of a bundle sent while the dryer had no course).
//
//     aa 37 30 e6 00 02 01 ff 01 0a 00 <record> <chk> bb
//                             │  └─┬─┘ │
//                             │    │   └ after the write: on a course write, the new course and its
//                             │    │     defaults. A chime or Cycle Optimization write's own field still
//                             │    │     shows the old value.
//                             │    └ (prop, result) × count
//                             └ buf[6] count
const WRITE_REPLY_TYPE = 0xe6
const WRITE_REPLY_PROP_OFFSET = 7
const WRITE_REPLY_RESULT_OFFSET = 8
const WRITE_REFUSED = 0x03
const WRITE_OK = new Set([0x00, 0x10, 0x11])

// The LG cloud's commands (f0 24 <command> 01 <value>, as in FAFXU22007), and the dryer's reply to one:
// 30 00 24 <result>. Only the cloud sends them, but a write from HA waits for their reply too.
const COMMAND_TYPE = 0x24
const COMMAND_REPLY_TYPE = 0x00

const EVENT_FRAME_TYPE = 0x03
const EVENT_INNER_LEN = 18
const EVENT_PAYLOAD_OFFSET = 13

const EVENT_POWER_OFFSET = 9
const EVENT_DOOR_OFFSET = 16

const DOOR_OPEN = 1
const EVENT_ID_DOOR = 0x0a

const DRY_LEVEL_OFFSET = 1
const TEMP_OFFSET = 3
const COURSE_OFFSET = 5
const REMAIN_TIME_OFFSET = 9 // minutes, big-endian
const INITIAL_TIME_OFFSET = 11 // minutes, big-endian
const STATE_OFFSET = 13
// Bound accepted baselines and confirmed report protection; never publish requested values alone.
const CONFIRMATION_WINDOW_MS = 30_000
const SPENT_POWER_OFFSET = 17 // Wh, big-endian
const BUZZER_OFFSET = 19
const DOWNLOADED_COURSE_OFFSET = 23 // while rec[5] is 0xff
const SPLASH_SCREEN_OFFSET = 33

const OPT1_OFFSET = 24
const OPT1_LOW_STATIC = 0x02
const OPT1_WRINKLE_CARE = 0x08
const OPT1_DRUM_LIGHT = 0x20 // also lit briefly by panel activity or the door
const OPT1_DAMP_DRY_SIGNAL = 0x40

const OPT2_OFFSET = 25
const OPT2_STEAM = 0x04
const OPT2_ENERGY_SAVER = 0x80 // app only

const OPT3_OFFSET = 26
const OPT3_CONTROL_LOCK = 0x10
const OPT3_REMOTE_START = 0x40

const OPT4_OFFSET = 27
const OPT4_CYCLE_OPTIMIZATION = 0x01
// The dryer sits in End remote maintain on. The cloud's f0 24 10 01 01 (sent on every reconnect and at each
// cycle start) is acknowledged in any state, but the cycle only ends this way when Remote Start was armed at
// the panel when it began; the bit shows the state, never the setting, so it is a sensor.
const OPT4_REMOTE_MAINTAIN = 0x02

const OPT5_OFFSET = 28
const OPT5_KEEP_FRESH = 0x10

const STATE_POWEROFF = 0

// modelJSON state indices
const STATE = Enum.of({
    Off: 0,
    Standby: 1,
    Running: 2,
    Pause: 3,
    End: 4,
    Error: 5,
    'Audible diagnosis': 6,
    Drying: 7,
    Cooling: 8,
    'Wrinkle care': 9,
    Reserved: 10,
    'Delay load': 11,
    'Spin reserve': 12,
    'Auto test': 13,
    Detecting: 14,
    Steam: 15,
    'Clothing recognition': 16,
    'Condenser clean': 17,
    'Bedding brushing': 18,
    'Dry refreshing': 19,
    'Allergy care': 20,
    'Condenser care': 21,
    'End remote maintain on': 22,
    'Dry ready': 23,
    'Laundry care': 24,
})

// Dial order, then the app-only courses.
const COURSE = new Enum<string>([
    ['AI Dry', 44],
    ['Timed Dry', 21],
    ['Bedding', 4],
    ['Steam Sanitary', 38],
    ['Towels', 2],
    ['Delicates', 10],
    ['Normal', 7],
    ['Quick Dry', 9],
    ['Power Dry', 16], // app: "Power Dry/Antibacterial"
    ['Steam Fresh', 37],
    ['Air Dry', 35],
    ['Jeans', 3],
    ['Blanket Refresh', 53],
    ['Perm. Press', 26],
    ['Heavy Duty', 29],
    ['Super Dry', 42],
    ['Active Wear', 8],
    ['Low Temp Dry', 32],
    ['Overnight Dry', 54],
    ['Easy Ironing', 51],
    ['Small Load', 24],
    ['Large Load Dry', 55],
    ['X Large Load Dry', 56],
])

const DOWNLOADED_COURSE = Enum.of({
    'Wrinkle Prevention': 114,
    'Rack Dry': 140,
})

// App labels. 0 on courses without a dry level.
const DRY_LEVEL = Enum.of({
    Off: 0,
    Damp: 1,
    Less: 2,
    Normal: 3,
    More: 4,
    Very: 5,
})

// 0 on Air Dry and Rack Dry
const TEMP = Enum.of({
    Low: 1,
    'Med. Low': 2,
    Medium: 3,
    'Med. High': 4,
    High: 5,
})

// "Signal" on the panel
const BUZZER = Enum.of({
    Off: 0,
    Low: 1,
    Medium: 2,
    High: 3,
    'Very High': 4,
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

const COURSE_TIMED_DRY = 21
// After a remote power-on the dryer can come up with no course, dry level or temperature, and ignore the
// dial until it is power-cycled at the panel. Seen once, after it asked on the panel to organize the cycle
// list. A bundle built from that record (temperature 0) was refused with 0x17; power off was accepted.
const NO_COURSE = 0
const NO_COURSE_REASON = 'No course selected: choose a course first'
const OFF_REASON = 'The dryer is off'
const NO_STATUS_REASON = 'No status from the dryer: try again'
const DRY_TIME_REASON = 'Dry Time is for Timed Dry only'
const TIMED_DRY_LEVEL_REASON = 'Timed Dry has no dry level'
const DRY_TIME_MIN = 10
const DRY_TIME_MAX = 100
const DRY_TIME_STEP = 10

const onOff = (v: boolean) => (v ? 'ON' : 'OFF')
const hex2 = (v: number) => v.toString(16).padStart(2, '0')
const bit = (byte: number, mask: number) => ((byte & mask) !== 0 ? 1 : 0)

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        retain: false,
                        optimistic: false,
                        name: 'Power',
                        icon: 'mdi:power',
                    },
                    cycle_finished: {
                        platform: 'event',
                        unique_id: '$deviceid-cycle_finished',
                        state_topic: '$this/cycle_finished',
                        name: 'Cycle finished',
                        event_types: ['finished'],
                        enabled_by_default: true,
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
                        retain: false,
                        optimistic: false,
                        options: [...COURSE.options, ...DOWNLOADED_COURSE.options],
                        name: 'Course',
                        icon: 'mdi:tumble-dryer',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        retain: false,
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        retain: false,
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        retain: false,
                        payload_press: '',
                        name: 'Resume',
                        icon: 'mdi:play-pause',
                    },
                    dry_level: {
                        platform: 'select',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        command_topic: '$this/dry_level/set',
                        retain: false,
                        optimistic: false,
                        options: DRY_LEVEL.options,
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                    },
                    temp: {
                        platform: 'select',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        command_topic: '$this/temp/set',
                        retain: false,
                        optimistic: false,
                        options: TEMP.options,
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    dry_time: {
                        platform: 'number',
                        unique_id: '$deviceid-dry_time',
                        state_topic: '$this/dry_time',
                        command_topic: '$this/dry_time/set',
                        retain: false,
                        optimistic: false,
                        min: DRY_TIME_MIN,
                        max: DRY_TIME_MAX,
                        step: DRY_TIME_STEP,
                        mode: 'box',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Dry time',
                        icon: 'mdi:timer-outline',
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
                    // refused while off
                    buzzer: {
                        platform: 'select',
                        unique_id: '$deviceid-buzzer',
                        state_topic: '$this/buzzer',
                        command_topic: '$this/buzzer/set',
                        retain: false,
                        optimistic: false,
                        options: BUZZER.options,
                        name: 'Buzzer',
                        icon: 'mdi:volume-high',
                        entity_category: 'config',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    drum_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_light',
                        state_topic: '$this/drum_light',
                        name: 'Drum light',
                        icon: 'mdi:lightbulb',
                    },
                    steam: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        command_topic: '$this/steam/set',
                        retain: false,
                        optimistic: false,
                        name: 'Steam',
                        icon: 'mdi:weather-windy',
                    },
                    wrinkle_care: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        command_topic: '$this/wrinkle_care/set',
                        retain: false,
                        optimistic: false,
                        name: 'Wrinkle care',
                        icon: 'mdi:iron',
                    },
                    low_static: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-low_static',
                        state_topic: '$this/low_static',
                        command_topic: '$this/low_static/set',
                        retain: false,
                        optimistic: false,
                        name: 'Low static',
                        icon: 'mdi:lightning-bolt-outline',
                    },
                    damp_dry_signal: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-damp_dry_signal',
                        state_topic: '$this/damp_dry_signal',
                        command_topic: '$this/damp_dry_signal/set',
                        retain: false,
                        optimistic: false,
                        name: 'Damp dry signal',
                        icon: 'mdi:water-percent',
                    },
                    energy_saver: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        command_topic: '$this/energy_saver/set',
                        retain: false,
                        optimistic: false,
                        name: 'Energy saver',
                        icon: 'mdi:leaf',
                    },
                    keep_fresh: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-keep_fresh',
                        state_topic: '$this/keep_fresh',
                        command_topic: '$this/keep_fresh/set',
                        retain: false,
                        optimistic: false,
                        name: 'KeepFresh',
                        icon: 'mdi:weather-windy',
                    },
                    cycle_optimization: {
                        platform: 'switch',
                        device_class: 'switch',
                        unique_id: '$deviceid-cycle_optimization',
                        state_topic: '$this/cycle_optimization',
                        command_topic: '$this/cycle_optimization/set',
                        retain: false,
                        optimistic: false,
                        name: 'Cycle optimization',
                        icon: 'mdi:auto-fix',
                    },
                    splash_screen: {
                        platform: 'select',
                        unique_id: '$deviceid-splash_screen',
                        state_topic: '$this/splash_screen',
                        command_topic: '$this/splash_screen/set',
                        retain: false,
                        optimistic: false,
                        options: SPLASH_SCREEN.options,
                        name: 'Splash screen',
                        icon: 'mdi:monitor',
                        entity_category: 'config',
                    },
                    control_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-control_lock',
                        state_topic: '$this/control_lock',
                        name: 'Control lock',
                        icon: 'mdi:lock-outline',
                        entity_category: 'diagnostic',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    remote_maintain: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_maintain',
                        state_topic: '$this/remote_maintain',
                        name: 'Remote maintain standby',
                        icon: 'mdi:remote',
                        entity_category: 'diagnostic',
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

    private completionState: 'unarmed' | 'armed' | 'completed' = 'unarmed'

    // Why the last command from HA failed; cleared by the next one that goes through, or, for NO_COURSE_REASON,
    // by a record with a course.
    private problem?: string
    private course?: { code: number; downloaded: number; on: boolean }

    private setProblem(reason: string | undefined) {
        if (reason === this.problem) return
        this.problem = reason
        this.publishProblem()
    }

    private publishProblem() {
        this.publishProperty('problem', onOff(this.problem !== undefined))
        this.publishProperty('problem_reason', this.problem ?? 'OK')
    }

    // BUNDLE values from the last record, plus writes not yet reflected in one
    private readonly bundle = new Map<BundleKey, number>()
    protected readonly strictWriteTracking = true
    private generation = 0
    private previousCourse?: { identity: string; current: string; expires: number }
    private readonly sentContext: { generation: number; reported: Map<number, number> }[] = []
    private readonly reported = new Map<number, number>()
    private readonly accepted = new Map<number, { value: number; expires: number; confirmed: boolean }>()
    private pendingBundle?: Map<BundleKey, number>
    private group = 0
    private readonly pending = new Map<number, { value: number; owner: object }>()

    protected writeTimedOut(_writes: readonly AwaitedWrite[]) {
        this.acceptedPower = undefined
        this.accepted.clear()
        this.pending.clear()
        this.pendingBundle = undefined
        this.bundle.clear()
        this.sentContext.length = 0
        this.setProblem('Command timed out: reconnect required')
    }

    private acceptedPower?: { value: boolean; expires: number }

    private boundary() {
        this.acceptedPower = undefined
        this.generation++
        this.previousCourse = undefined
        this.accepted.clear()
        this.bundle.clear()
    }

    drop() {
        this.acceptedPower = undefined
        this.accepted.clear()
        this.pending.clear()
        this.pendingBundle = undefined
        this.sentContext.length = 0
        super.drop()
    }

    private writable(power = false) {
        if (this.writesBlocked) return false
        const reason = power ? undefined : !this.course ? NO_STATUS_REASON : !this.course.on ? OFF_REASON : undefined
        if (reason) this.setProblem(reason)
        return reason === undefined
    }

    private propertyValues(inner: Buffer) {
        const values = new Map<number, number>()
        if (inner.length < 7) return undefined
        let at = 7
        for (let i = 0; i < inner[6]; i++) {
            const prop = inner[at++]
            const width = prop === 0x70 ? 2 : 1
            if (values.has(prop) || at + width > inner.length) return undefined
            values.set(prop, width === 2 ? inner.readUInt16BE(at) : inner[at])
            at += width
        }
        return at === inner.length ? values : undefined
    }

    private recordValues(rec: Buffer) {
        return new Map<number, number>([
            [PROP_POWER, rec[STATE_OFFSET] === 0 ? 0 : 1],
            [PROP_COURSE, rec[COURSE_OFFSET]],
            [PROP_DOWNLOADED_COURSE, rec[DOWNLOADED_COURSE_OFFSET]],
            [PROP_BUZZER, rec[BUZZER_OFFSET]],
            [PROP_SPLASH_SCREEN, rec[SPLASH_SCREEN_OFFSET]],
            [PROP_KEEP_FRESH, bit(rec[OPT5_OFFSET], OPT5_KEEP_FRESH)],
            [PROP_CYCLE_OPTIMIZATION, bit(rec[OPT4_OFFSET], OPT4_CYCLE_OPTIMIZATION)],
            ...BUNDLE.map(
                ({ prop, key }) =>
                    [
                        prop,
                        key === 'temp'
                            ? rec[TEMP_OFFSET]
                            : key === 'dry_level'
                              ? rec[DRY_LEVEL_OFFSET]
                              : key === 'dry_time'
                                ? rec[COURSE_OFFSET] === COURSE_TIMED_DRY
                                    ? rec.readUInt16BE(INITIAL_TIME_OFFSET)
                                    : 0
                                : key === 'steam'
                                  ? bit(rec[OPT2_OFFSET], OPT2_STEAM)
                                  : key === 'energy_saver'
                                    ? bit(rec[OPT2_OFFSET], OPT2_ENERGY_SAVER)
                                    : bit(
                                          rec[OPT1_OFFSET],
                                          key === 'low_static'
                                              ? OPT1_LOW_STATIC
                                              : key === 'wrinkle_care'
                                                ? OPT1_WRINKLE_CARE
                                                : OPT1_DAMP_DRY_SIGNAL,
                                      ),
                    ] as [number, number],
            ),
        ])
    }

    private baseline(prop: number, raw: number) {
        const accepted = this.accepted.get(prop)
        if (!accepted) return raw
        if (Date.now() >= accepted.expires) {
            this.accepted.delete(prop)
            if (raw !== accepted.value) this.setProblem('Accepted setting not reflected before confirmation expired')
            return raw
        }
        return accepted.value
    }

    private publishSetting(prop: number, key: string, raw: number, value: string | number | undefined) {
        if (this.pending.has(prop) && this.pending.get(prop)?.value !== raw) return
        const accepted = this.accepted.get(prop)
        if (accepted && raw === accepted.value && !this.pending.has(prop)) accepted.confirmed = true
        if (accepted && Date.now() < accepted.expires && accepted.confirmed && raw !== accepted.value) return
        this.publishProperty(key, value)
    }

    private writeProps(...pairs: number[]) {
        if (!this.writable(pairs[0] === PROP_POWER)) return
        if (this.pendingBundle) this.group++
        this.pendingBundle = undefined
        const prop = pairs[0]
        const owner = {}
        this.pending.set(prop, { value: pairs[1], owner })
        const header = [...SET_PROPERTY]
        if (prop === PROP_BUZZER) header[5] = 0x34
        const inner = Buffer.from([...header, pairs.length / 2, ...pairs])
        const barrier = [PROP_POWER, PROP_COURSE, PROP_CYCLE, PROP_CYCLE_OPTIMIZATION].includes(prop)
        if (barrier) this.group++
        const group = this.group
        this.queueWrite(
            () => {
                if (this.pending.get(prop)?.owner === owner) this.pending.delete(prop)
                if (!this.writable(prop === PROP_POWER)) return
                if (prop === PROP_CYCLE && (!this.course?.code || this.course.code === COURSE_DOWNLOADED)) {
                    this.setProblem(NO_COURSE_REASON)
                    return
                }
                return inner
            },
            barrier ? undefined : `singleton:${group}:${prop}`,
        )
    }

    protected writeType(inner: Buffer) {
        if (inner[0] !== SET_PROPERTY[0]) return undefined
        const type = inner[1]
        if (type === SET_PROPERTY[1])
            this.sentContext.push({ generation: this.generation, reported: new Map(this.reported) })
        return type === SET_PROPERTY[1] || type === COMMAND_TYPE ? type : undefined
    }

    // Build only from passively received settings; missing context never triggers a query.
    private writeBundle(key: BundleKey, value: number) {
        if (!this.writable()) return
        if (this.course?.code === NO_COURSE) return this.setProblem(NO_COURSE_REASON)
        if (!this.pendingBundle) this.group++
        const edits = (this.pendingBundle ??= new Map<BundleKey, number>())
        if (key === 'dry_level' && (edits.get(key) ?? this.bundle.get(key)) !== value) edits.set('energy_saver', 0)
        edits.set(key, value)
        for (const [k, val] of edits)
            this.pending.set(BUNDLE.find((entry) => entry.key === k)!.prop, { value: val, owner: edits })
        const group = this.group
        this.queueWrite(() => {
            if (this.pendingBundle === edits) this.pendingBundle = undefined
            for (const k of edits.keys()) {
                const prop = BUNDLE.find((entry) => entry.key === k)!.prop
                if (this.pending.get(prop)?.owner === edits) this.pending.delete(prop)
            }
            if (!this.writable()) return
            if (this.course?.code === NO_COURSE || this.bundle.size !== BUNDLE.length) {
                this.setProblem(this.course?.code === NO_COURSE ? NO_COURSE_REASON : NO_STATUS_REASON)
                return
            }
            if (edits.has('dry_time') && this.course?.code !== COURSE_TIMED_DRY) {
                this.setProblem(DRY_TIME_REASON)
                return
            }
            if (edits.has('dry_level') && this.course?.code === COURSE_TIMED_DRY) {
                this.setProblem(TIMED_DRY_LEVEL_REASON)
                return
            }
            const values = new Map(BUNDLE.map(({ prop, key }) => [key, this.baseline(prop, this.bundle.get(key)!)]))
            for (const [k, val] of edits) values.set(k, val)
            values.set(this.course?.code === COURSE_TIMED_DRY ? 'dry_level' : 'dry_time', 0)
            const body = BUNDLE.flatMap(({ prop, key, width }) => {
                const val = values.get(key)!
                return width === 2 ? [prop, val >> 8, val & 0xff] : [prop, val]
            })
            return Buffer.from([...SET_PROPERTY, BUNDLE.length, ...body])
        }, `bundle:${group}`)
    }

    setProperty(prop: string, value: string) {
        const cycle = CYCLE.unmap(prop)
        if (cycle !== undefined) return this.writeProps(PROP_CYCLE, cycle)
        if (BUNDLE_SWITCHES.includes(prop as BundleKey)) {
            if (value === 'ON' || value === 'OFF') this.writeBundle(prop as BundleKey, value === 'ON' ? 1 : 0)
            return
        }

        if (prop === 'power') {
            if (value !== 'ON' && value !== 'OFF') return
            this.writeProps(PROP_POWER, value === 'ON' ? 1 : 0)
        } else if (prop === 'buzzer') {
            const idx = BUZZER.unmap(value)
            if (idx !== undefined) this.writeProps(PROP_BUZZER, idx)
        } else if (prop === 'dry_level') {
            const idx = DRY_LEVEL.unmap(value)
            if (idx === undefined) return
            if (this.course?.on && this.course.code === COURSE_TIMED_DRY) return this.setProblem(TIMED_DRY_LEVEL_REASON)
            this.writeBundle('dry_level', idx)
        } else if (prop === 'temp') {
            const idx = TEMP.unmap(value)
            if (idx !== undefined) this.writeBundle('temp', idx)
        } else if (prop === 'dry_time') {
            const minutes = Number(value)
            if (
                !Number.isInteger(minutes) ||
                minutes < DRY_TIME_MIN ||
                minutes > DRY_TIME_MAX ||
                minutes % DRY_TIME_STEP !== 0
            )
                return
            if (this.course?.on && this.course.code !== COURSE_TIMED_DRY) return this.setProblem(DRY_TIME_REASON)
            this.writeBundle('dry_time', minutes)
        } else if (prop === 'cycle_optimization' || prop === 'keep_fresh') {
            if (value !== 'ON' && value !== 'OFF') return
            this.writeProps(prop === 'keep_fresh' ? PROP_KEEP_FRESH : PROP_CYCLE_OPTIMIZATION, value === 'ON' ? 1 : 0)
        } else if (prop === 'splash_screen') {
            const idx = SPLASH_SCREEN.unmap(value)
            if (idx !== undefined) this.writeProps(PROP_SPLASH_SCREEN, idx)
        } else if (prop === 'course') {
            const code = COURSE.unmap(value)
            const downloaded = DOWNLOADED_COURSE.unmap(value)
            if (code !== undefined) this.writeProps(PROP_COURSE, code)
            else if (downloaded !== undefined)
                this.writeProps(PROP_COURSE, COURSE_DOWNLOADED, PROP_DOWNLOADED_COURSE, downloaded)
        }
    }

    // Validate complete wire frames before the base strips checksum bytes. Keep its queue owner.
    processData(frame: Buffer) {
        if (frame.length < 4 || frame[0] !== 0xaa || frame[frame.length - 1] !== 0xbb) return
        if (frame[1] === 0xff) {
            if (
                frame.length < 18 ||
                frame[2] !== CLASS_BYTE ||
                frame[3] !== ENVELOPE_TYPE ||
                frame.readUInt16BE(4) !== frame.length ||
                frame.readUInt16BE(13) + 18 !== frame.length ||
                crc16(frame.subarray(0, -3)) !== frame.readUInt16BE(frame.length - 3)
            )
                return
        } else {
            if (frame[1] !== frame.length) return
            const sum = frame.subarray(0, -2).reduce((a, b) => a + b, 0)
            if (((sum & 0xff) ^ 0x55) !== frame[frame.length - 2]) return
        }
        super.processData(frame)
    }

    processAABB(buf: Buffer) {
        if (buf.length < 2 || buf[0] !== CLASS_BYTE) return
        if (buf[1] === WRITE_REPLY_TYPE) return this.processWriteReply(buf)
        if (buf.length === 4 && buf[1] === COMMAND_REPLY_TYPE && buf[2] === COMMAND_TYPE) {
            this.writeAnswered(COMMAND_TYPE)
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
                    innerLen === 28 &&
                    buf
                        .subarray(EVENT_PAYLOAD_OFFSET, EVENT_PAYLOAD_OFFSET + 6)
                        .equals(Buffer.from([0x03, 0x0a, 0x02, 0x04, 0x03, 0x03]))
                ) {
                    if (this.completionState === 'armed') {
                        this.completionState = 'completed'
                        this.HA.publishProperty(this.id, 'cycle_finished', JSON.stringify({ event_type: 'finished' }), {
                            retain: false,
                        })
                    }
                    return
                }
                if (innerLen !== EVENT_INNER_LEN || buf.length < EVENT_PAYLOAD_OFFSET + EVENT_INNER_LEN) return
                return this.processEvent(buf.subarray(EVENT_PAYLOAD_OFFSET, EVENT_PAYLOAD_OFFSET + EVENT_INNER_LEN))
        }
    }

    // Only a reply to a write from HA counts toward the problem sensor: one to the cloud's says nothing
    // about ours.
    private processWriteReply(buf: Buffer) {
        if (buf.length < 7 || !buf.subarray(0, 6).equals(Buffer.from([0x30, 0xe6, 0, 2, 1, 0xff]))) return
        const count = buf[6]
        if (count === undefined) return
        const end = 7 + count * 2
        if (buf.length !== end && buf.length !== end + RECORD_LEN) return
        const props = new Set<number>()
        for (let i = 0; i < count; i++) props.add(buf[7 + i * 2])
        if (props.size !== count) return
        const write = this.writeAnswered(SET_PROPERTY[1], (candidate) => {
            const values = this.propertyValues(candidate.inner)
            return !!values && values.size === props.size && [...values.keys()].every((prop) => props.has(prop))
        })
        if (!write) return
        const context = this.sentContext.shift()
        if (context?.generation === this.generation) this.takeInWrite(write.inner, buf, context.reported)
        if (!write.own) return
        const failed = [...Array(count).keys()]
            .map((i) => buf[WRITE_REPLY_RESULT_OFFSET + 2 * i])
            .find((result) => result !== undefined && !WRITE_OK.has(result))
        this.setProblem(failed === undefined ? undefined : `Command refused (0x${hex2(failed)})`)
    }

    // What a write changed, the app's or ours, is taken in from its reply: the next record can be seconds
    // away, or never come, and a bundle from HA built without it would undo the change. A course change
    // comes from the reply's record, with the course's defaults; bundle settings from the write itself,
    // where the dryer accepted them.
    private courseIdentity(code: number, downloaded: number) {
        return `${code}:${code === COURSE_DOWNLOADED ? downloaded : 0}`
    }

    private takeInWrite(inner: Buffer, reply: Buffer, before: Map<number, number>) {
        const values = this.propertyValues(inner)!
        const results = new Map<number, number>()
        for (let i = 0; i < reply[6]; i++) results.set(reply[7 + i * 2], reply[8 + i * 2])
        const at = 7 + reply[6] * 2
        const rec = reply.length === at + RECORD_LEN ? reply.subarray(at) : undefined
        const actual = rec ? this.recordValues(rec) : undefined
        const accepted = (prop: number) => WRITE_OK.has(results.get(prop) ?? WRITE_REFUSED)
        if (accepted(PROP_POWER)) {
            this.boundary()
            this.course = undefined
            // Power replies can carry a stale record. Only publish when record and exact request agree.
            const value = values.get(PROP_POWER)
            if (value !== undefined && [0, 1].includes(value) && actual?.get(PROP_POWER) === value) {
                this.acceptedPower = { value: value === 1, expires: Date.now() + CONFIRMATION_WINDOW_MS }
                if (!this.pending.has(PROP_POWER)) this.publishProperty('power', onOff(value === 1))
            }
            return
        }
        if (accepted(PROP_COURSE) || accepted(PROP_CYCLE_OPTIMIZATION)) {
            const previous = this.course ? this.courseIdentity(this.course.code, this.course.downloaded) : undefined
            this.boundary()
            if (
                rec &&
                (!accepted(PROP_COURSE) ||
                    (actual?.get(PROP_COURSE) === values.get(PROP_COURSE) &&
                        (values.get(PROP_COURSE) !== COURSE_DOWNLOADED ||
                            actual?.get(PROP_DOWNLOADED_COURSE) === values.get(PROP_DOWNLOADED_COURSE))))
            ) {
                this.takeInCourse(rec, false)
                if (
                    previous !== undefined &&
                    previous !== this.courseIdentity(rec[COURSE_OFFSET], rec[DOWNLOADED_COURSE_OFFSET])
                )
                    this.previousCourse = {
                        identity: previous,
                        current: this.courseIdentity(rec[COURSE_OFFSET], rec[DOWNLOADED_COURSE_OFFSET]),
                        expires: Date.now() + CONFIRMATION_WINDOW_MS,
                    }
                const defaults = this.recordValues(rec)
                for (const { prop, key } of BUNDLE) this.bundle.set(key, defaults.get(prop)!)
                if (!this.pending.has(PROP_COURSE))
                    this.publishProperty(
                        'course',
                        rec[COURSE_OFFSET] === COURSE_DOWNLOADED
                            ? DOWNLOADED_COURSE.map(rec[DOWNLOADED_COURSE_OFFSET])
                            : COURSE.map(rec[COURSE_OFFSET]),
                    )
            } else this.course = undefined
        }
        for (const [prop, value] of values) {
            if (!accepted(prop)) continue
            const confirmed = actual?.get(prop) === value && before.get(prop) !== value
            this.accepted.set(prop, { value, expires: Date.now() + CONFIRMATION_WINDOW_MS, confirmed })
            if (confirmed && !this.pending.has(prop) && rec) this.publishConfirmed(prop, rec)
        }
    }

    private publishConfirmed(prop: number, rec: Buffer) {
        const raw = this.recordValues(rec).get(prop)!
        const entry = BUNDLE.find((entry) => entry.prop === prop)
        if (entry) {
            this.publishProperty(
                entry.key,
                entry.key === 'temp'
                    ? TEMP.map(raw)
                    : entry.key === 'dry_level'
                      ? DRY_LEVEL.map(raw)
                      : entry.key === 'dry_time'
                        ? raw
                        : onOff(raw !== 0),
            )
        } else if (prop === PROP_BUZZER) this.publishProperty('buzzer', BUZZER.map(raw))
        else if (prop === PROP_SPLASH_SCREEN) this.publishProperty('splash_screen', SPLASH_SCREEN.map(raw))
        else if (prop === PROP_KEEP_FRESH) this.publishProperty('keep_fresh', onOff(raw !== 0))
        else if (prop === PROP_CYCLE_OPTIMIZATION) this.publishProperty('cycle_optimization', onOff(raw !== 0))
    }

    private publishPower(observed: boolean) {
        const accepted = this.acceptedPower
        if (accepted) {
            if (observed === accepted.value || Date.now() >= accepted.expires) {
                if (observed !== accepted.value)
                    this.setProblem('Accepted power not reflected before confirmation expired')
                this.acceptedPower = undefined
            } else {
                if (!this.pending.has(PROP_POWER)) this.publishProperty('power', onOff(accepted.value))
                return
            }
        }
        if (!this.pending.has(PROP_POWER)) this.publishProperty('power', onOff(observed))
    }

    // After a remote power change the dryer may send no record, only these events.
    private processEvent(payload: Buffer) {
        const on = payload[EVENT_POWER_OFFSET] !== 0
        if (!on) this.completionState = 'unarmed'
        if (!on && this.course?.on) {
            this.boundary()
            this.course = { ...this.course, on: false }
        }
        this.publishPower(on)
        if (
            payload.subarray(0, 5).equals(Buffer.from([EVENT_ID_DOOR, 0x0a, 0x02, 0x04, EVENT_ID_DOOR])) &&
            [0, DOOR_OPEN].includes(payload[EVENT_DOOR_OFFSET])
        )
            this.publishProperty('door', onOff(payload[EVENT_DOOR_OFFSET] === DOOR_OPEN))
    }

    // The course, and the settings that come with it
    private takeInCourse(rec: Buffer, publish = true) {
        const code = rec[COURSE_OFFSET]
        const isOff = rec[STATE_OFFSET] === STATE_POWEROFF
        const timedDry = code === COURSE_TIMED_DRY
        if (
            this.course &&
            (this.courseIdentity(this.course.code, this.course.downloaded) !==
                this.courseIdentity(code, rec[DOWNLOADED_COURSE_OFFSET]) ||
                (this.course.on && isOff))
        )
            this.boundary()
        this.course = { code, downloaded: rec[DOWNLOADED_COURSE_OFFSET], on: !isOff }
        if (this.problem === NO_COURSE_REASON && code !== NO_COURSE) this.setProblem(undefined)
        this.bundle.set('temp', rec[TEMP_OFFSET])
        this.bundle.set('dry_level', rec[DRY_LEVEL_OFFSET])
        this.bundle.set('dry_time', timedDry ? rec.readUInt16BE(INITIAL_TIME_OFFSET) : 0)
        if (!publish) return
        this.publishProperty(
            'course',
            code === COURSE_DOWNLOADED ? DOWNLOADED_COURSE.map(rec[DOWNLOADED_COURSE_OFFSET]) : COURSE.map(code),
        )
        this.publishSetting(0x1e, 'dry_level', rec[DRY_LEVEL_OFFSET], DRY_LEVEL.map(rec[DRY_LEVEL_OFFSET]))
        this.publishSetting(0x20, 'temp', rec[TEMP_OFFSET], TEMP.map(rec[TEMP_OFFSET]))
        this.publishSetting(
            0x70,
            'dry_time',
            timedDry ? rec.readUInt16BE(INITIAL_TIME_OFFSET) : 0,
            timedDry && !isOff ? rec.readUInt16BE(INITIAL_TIME_OFFSET) : undefined,
        )
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)
        if (
            this.previousCourse &&
            rec[STATE_OFFSET] !== STATE_POWEROFF &&
            this.courseIdentity(rec[COURSE_OFFSET], rec[DOWNLOADED_COURSE_OFFSET]) === this.previousCourse.identity &&
            Date.now() < this.previousCourse.expires
        )
            return
        if (this.previousCourse && Date.now() >= this.previousCourse.expires) {
            if (this.courseIdentity(rec[COURSE_OFFSET], rec[DOWNLOADED_COURSE_OFFSET]) !== this.previousCourse.current)
                this.setProblem('Accepted course not reflected before confirmation expired')
            this.previousCourse = undefined
        }
        for (const [prop, raw] of this.recordValues(rec)) this.baseline(prop, raw)

        for (const [prop, raw] of this.recordValues(rec)) this.reported.set(prop, raw)
        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_POWEROFF
        if ([0, 1].includes(state)) this.completionState = 'unarmed'
        else if (this.completionState === 'unarmed' && [7, 8].includes(state)) this.completionState = 'armed'
        this.takeInCourse(rec)
        this.bundle.set('steam', bit(rec[OPT2_OFFSET], OPT2_STEAM))
        this.bundle.set('damp_dry_signal', bit(rec[OPT1_OFFSET], OPT1_DAMP_DRY_SIGNAL))
        this.bundle.set('energy_saver', bit(rec[OPT2_OFFSET], OPT2_ENERGY_SAVER))
        this.bundle.set('low_static', bit(rec[OPT1_OFFSET], OPT1_LOW_STATIC))
        this.bundle.set('wrinkle_care', bit(rec[OPT1_OFFSET], OPT1_WRINKLE_CARE))

        this.publishPower(!isOff)
        this.publishProperty('status', STATE.map(state))
        this.publishSetting(PROP_BUZZER, 'buzzer', rec[BUZZER_OFFSET], BUZZER.map(rec[BUZZER_OFFSET]))
        this.publishProperty(
            'remaining_time',
            [0, 1].includes(state) ? undefined : rec.readUInt16BE(REMAIN_TIME_OFFSET),
        )
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16BE(INITIAL_TIME_OFFSET))
        this.publishProperty('energy', rec.readUInt16BE(SPENT_POWER_OFFSET))
        this.publishProperty('drum_light', onOff((rec[OPT1_OFFSET] & OPT1_DRUM_LIGHT) !== 0))
        this.publishSetting(
            54,
            'low_static',
            bit(rec[OPT1_OFFSET], OPT1_LOW_STATIC),
            onOff((rec[OPT1_OFFSET] & OPT1_LOW_STATIC) !== 0),
        )
        this.publishSetting(
            15,
            'wrinkle_care',
            bit(rec[OPT1_OFFSET], OPT1_WRINKLE_CARE),
            onOff((rec[OPT1_OFFSET] & OPT1_WRINKLE_CARE) !== 0),
        )
        this.publishSetting(
            52,
            'damp_dry_signal',
            bit(rec[OPT1_OFFSET], OPT1_DAMP_DRY_SIGNAL),
            onOff((rec[OPT1_OFFSET] & OPT1_DAMP_DRY_SIGNAL) !== 0),
        )
        this.publishSetting(
            63,
            'steam',
            bit(rec[OPT2_OFFSET], OPT2_STEAM),
            onOff((rec[OPT2_OFFSET] & OPT2_STEAM) !== 0),
        )
        this.publishSetting(
            56,
            'energy_saver',
            bit(rec[OPT2_OFFSET], OPT2_ENERGY_SAVER),
            onOff((rec[OPT2_OFFSET] & OPT2_ENERGY_SAVER) !== 0),
        )
        this.publishProperty('control_lock', onOff((rec[OPT3_OFFSET] & OPT3_CONTROL_LOCK) !== 0))
        this.publishProperty('remote_start', onOff((rec[OPT3_OFFSET] & OPT3_REMOTE_START) !== 0))
        this.publishSetting(
            76,
            'cycle_optimization',
            bit(rec[OPT4_OFFSET], OPT4_CYCLE_OPTIMIZATION),
            onOff((rec[OPT4_OFFSET] & OPT4_CYCLE_OPTIMIZATION) !== 0),
        )
        this.publishProperty('remote_maintain', onOff((rec[OPT4_OFFSET] & OPT4_REMOTE_MAINTAIN) !== 0))
        this.publishSetting(
            87,
            'keep_fresh',
            bit(rec[OPT5_OFFSET], OPT5_KEEP_FRESH),
            onOff((rec[OPT5_OFFSET] & OPT5_KEEP_FRESH) !== 0),
        )
        this.publishSetting(
            PROP_SPLASH_SCREEN,
            'splash_screen',
            rec[SPLASH_SCREEN_OFFSET],
            SPLASH_SCREEN.map(rec[SPLASH_SCREEN_OFFSET]),
        )
    }
}
