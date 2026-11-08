// Pure, read-only AABB inspection for the two locally verified laundry models.
// Offsets in segments are packet-relative; status field offsets are record-relative.
const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
const word = (bytes, offset) => bytes[offset] * 256 + bytes[offset + 1]
const number = (bytes) => bytes.reduce((value, b) => value * 256 + b, 0)
function crc16(bytes) {
    let crc = 0
    for (const byte of bytes) {
        crc ^= byte << 8
        for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff
    }
    return crc
}
const COMMON_PROPS = {
    2: 'Power',
    3: 'Cycle action',
    10: 'Course',
    11: 'Downloaded course',
    19: 'Chime',
    76: 'Cycle optimization',
    81: 'Splash screen',
    88: 'Clock display',
}
const MODELS = {
    FAFXU22007: {
        classByte: 0x20,
        length: 51,
        props: {
            31: 'Temperature',
            33: 'Spin',
            30: 'Soil',
            32: 'Rinse',
            62: 'Steam',
            52: 'Pre-wash',
            56: 'Cold wash',
            53: 'Turbo wash',
            68: 'Fresh care',
            127: 'Delay Start minutes',
            86: 'Quick load sense',
        },
        widths: { 127: 2 },
        fields: [
            [1, 'Soil'],
            [2, 'Temperature'],
            [3, 'Rinse'],
            [4, 'Spin'],
            [5, 'Course'],
            [11, 'Delay Start minutes', 2],
            [13, 'Remaining minutes', 2, 'inferred'],
            [15, 'Total minutes', 2, 'inferred'],
            [17, 'Energy Wh', 2, 'inferred'],
            [20, 'Loaded course'],
            [21, 'State'],
            [28, 'Tub clean count'],
            [29, 'Chime'],
            [30, 'Detergent level'],
            [31, 'Softener level'],
            [32, 'Detergent mL'],
            [33, 'Softener mL'],
            [46, 'Splash screen'],
            [48, 'Softener tank use'],
        ],
        bits: [
            [34, 4, 'Cold wash'],
            [34, 32, 'Turbo wash'],
            [34, 64, 'Pre-wash'],
            [35, 16, 'Steam'],
            [36, 64, 'Fresh care'],
            [37, 32, 'Control lock'],
            [37, 16, 'Remote start'],
            [38, 1, 'Door lock'],
            [39, 128, 'Delay Start'],
            [39, 4, 'Drawer closed'],
            [40, 4, 'Remote maintain'],
            [40, 8, 'Cycle optimization'],
            [50, 4, 'Quick load sense'],
            [47, 128, 'Clock display'],
        ],
    },
    BDVG_FX0003_US: {
        classByte: 0x30,
        length: 42,
        props: {
            32: 'Temperature',
            30: 'Dry level',
            63: 'Steam',
            52: 'Damp dry signal',
            56: 'Energy saver',
            54: 'Low static',
            15: 'Wrinkle care',
            112: 'Dry time minutes',
            87: 'Keep fresh',
        },
        widths: { 112: 2 },
        fields: [
            [1, 'Dry level'],
            [3, 'Temperature'],
            [5, 'Course'],
            [9, 'Remaining minutes', 2],
            [11, 'Initial minutes', 2],
            [13, 'State'],
            [17, 'Energy Wh', 2, 'inferred'],
            [19, 'Chime'],
            [23, 'Downloaded course'],
            [33, 'Splash screen'],
        ],
        bits: [
            [24, 2, 'Low static'],
            [24, 8, 'Wrinkle care'],
            [24, 32, 'Drum light'],
            [24, 64, 'Damp dry signal'],
            [25, 4, 'Steam'],
            [25, 128, 'Energy saver'],
            [26, 16, 'Control lock'],
            [26, 64, 'Remote start'],
            [27, 1, 'Cycle optimization'],
            [27, 2, 'Remote maintain'],
            [28, 16, 'Keep fresh'],
            [28, 32, 'Clock display'],
        ],
    },
}
const RESULTS = { 0: 'accepted', 16: 'accepted', 17: 'unchanged', 3: 'refused', 19: 'busy', 23: 'refused' }

/** No I/O, state updates, command dispatch or cross-packet interpretation. */
export function decodePacket(input, { model } = {}) {
    const out = {
        valid: false,
        errors: [],
        rawHex: '',
        format: null,
        type: null,
        typeHex: null,
        payload: [],
        segments: [],
        fields: [],
        summary: '',
        unknowns: [],
        status: null,
    }
    let bytes = []
    if (typeof input === 'string') {
        const text = input.replace(/\s/g, '')
        if (!/^(?:[0-9a-fA-F]{2})+$/.test(text)) out.errors.push('Expected complete hexadecimal bytes')
        else bytes = text.match(/../g).map((b) => parseInt(b, 16))
    } else if (Array.isArray(input) || input instanceof Uint8Array) {
        bytes = Array.from(input)
        if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
            out.errors.push('Invalid byte value')
            bytes = []
        }
    } else out.errors.push('Expected hex text or bytes')
    out.rawHex = hex(bytes)
    const field = (key, label, raw, confidence = 'known', value = number(raw)) => ({
        key,
        label,
        raw,
        value,
        confidence,
    })
    const segment = (kind, label, start, end, fields = []) => {
        const raw = bytes.slice(start, end)
        const s = { kind, label, start, end, bytes: raw, hex: hex(raw), fields }
        out.segments.push(s)
        out.fields.push(...fields)
        if (kind === 'unknown') out.unknowns.push({ label, bytes: raw, hex: s.hex })
        return s
    }
    const finish = () => {
        out.segments.sort((a, b) => a.start - b.start)
        out.valid = out.errors.length === 0
        if (!out.valid) {
            out.status = null
            out.summary = 'Invalid packet: ' + out.errors.join('; ')
        }
        return out
    }
    if (bytes.length < 6 || bytes[0] !== 0xaa || bytes.at(-1) !== 0xbb) {
        out.errors.push('Expected AA … BB frame (at least 6 bytes)')
        segment('unknown', 'Unrecognized frame', 0, bytes.length)
        return finish()
    }
    const long = bytes[1] === 0xff
    out.format = long ? 'long' : 'short'
    const end = bytes.length - (long ? 3 : 2)
    if (long && bytes.length < 9) out.errors.push('Truncated long frame')
    const length = long ? word(bytes, 4) : bytes[1]
    if (length !== bytes.length) out.errors.push('Frame length mismatch')
    const expected = long ? crc16(bytes.slice(0, end)) : (bytes.slice(0, end).reduce((a, b) => a + b, 0) & 255) ^ 0x55
    const actual = long ? word(bytes, end) : bytes[end]
    if (actual !== expected) out.errors.push('Checksum mismatch')
    segment('framing', 'Frame header', 0, 2, [field('length', 'Frame length', long ? bytes.slice(4, 6) : [bytes[1]])])
    segment('checksum', long ? 'CRC16' : 'Checksum', end, bytes.length - 1, [
        field('checksum', 'Checksum valid', bytes.slice(end, -1), 'known', actual === expected),
    ])
    segment('framing', 'Terminator', bytes.length - 1, bytes.length)
    if (out.errors.length) {
        segment('unknown', 'Unvalidated body', 2, end)
        return finish()
    }
    const type = bytes[3]
    out.type = type
    out.typeHex = hex([type])
    out.payload = bytes.slice(4, end)
    const profile = MODELS[model] || (!model && Object.values(MODELS).find((m) => m.classByte === bytes[2]))
    if (profile && bytes[2] !== 0xf0 && profile.classByte !== bytes[2]) {
        out.errors.push('Model class mismatch')
        return finish()
    }
    const property = (id) => COMMON_PROPS[id] || profile?.props[id]
    function status(start, stop, source, sequence) {
        if (!profile) {
            segment('unknown', 'Status (model required)', start, stop)
            return
        }
        if (stop - start !== profile.length || (profile.classByte === 0x20 && bytes[start] !== 0)) {
            out.errors.push('Invalid status record length or marker')
            segment('unknown', 'Invalid status record', start, stop)
            return
        }
        const record = bytes.slice(start, stop)
        const fields = profile.fields.map(([offset, label, width = 1, confidence = 'known']) => ({
            ...field(label, label, record.slice(offset, offset + width), confidence),
            offset,
            width,
        }))
        fields.push(
            ...profile.bits.map(([offset, mask, label]) => ({
                ...field(label, label, [record[offset]], 'known', Boolean(record[offset] & mask)),
                offset,
                width: 1,
                mask,
            })),
        )
        const covered = new Set([0])
        for (const f of fields) for (let i = 0; i < f.width; i++) covered.add(f.offset + i)
        // Keep each unexplained byte visible. Bitfields also retain the full raw byte.
        for (let offset = 0; offset < record.length; offset++)
            if (!covered.has(offset))
                fields.push({
                    ...field('unknown_' + offset, 'Unknown byte ' + offset, [record[offset]], 'unknown'),
                    offset,
                    width: 1,
                })
        const s = segment('status', 'Current status (' + source + ')', start, stop, fields)
        out.status = { record, fields, source, ...(sequence === undefined ? {} : { sequence }) }
        for (const f of fields.filter((f) => f.confidence === 'unknown'))
            out.unknowns.push({ label: f.label, bytes: f.raw, hex: hex(f.raw) })
    }
    segment('header', 'Class and type', 2, 4, [field('class', 'Class', [bytes[2]]), field('type', 'Type', [type])])
    if (bytes[2] === 0xf0 && type === 0) {
        if (![6, 8].includes(end)) out.errors.push('Invalid delivery ACK length')
        segment('ack', 'Delivery ACK', 4, end, [
            field('ackType', 'Acknowledged type', [bytes[4]]),
            field('ackStatus', 'Delivery status', [bytes[5]]),
            ...(end === 8 ? [field('sequence', 'Sequence', bytes.slice(6, 8))] : []),
        ])
        out.summary = 'Delivery ACK'
    } else if (type === 0) {
        const sequenced = bytes[4] === 0x0b && end === 8
        if (end !== 6 && !sequenced) out.errors.push('Invalid receipt ACK length')
        segment('ack', 'Receipt ACK', 4, end, [
            field('ackType', 'Acknowledged type', [bytes[4]]),
            field('result', 'Result', [bytes[5]]),
            ...(sequenced ? [field('sequence', 'Sequence', bytes.slice(6, 8))] : []),
        ])
        out.summary = 'Receipt ACK'
    } else if (type === 0xe5 || type === 0xe6) {
        const reply = type === 0xe6
        out.summary = reply ? 'Property reply (E6)' : 'Property write (E5)'
        if (
            end < 9 ||
            bytes[4] !== 0 ||
            bytes[5] !== 2 ||
            bytes[6] !== 1 ||
            ![0xff, 0x33, 0x34].includes(bytes[7]) ||
            !bytes[8]
        ) {
            out.errors.push('Invalid property header')
            segment('unknown', 'Property body', 4, end)
            return finish()
        }
        segment('properties', 'Property header', 4, 9, [field('count', 'Property count', [bytes[8]])])
        let pos = 9
        const ids = new Set()
        for (let i = 0; i < bytes[8]; i++) {
            const id = bytes[pos],
                label = property(id)
            if (ids.has(id)) {
                out.errors.push('Duplicate property')
                break
            }
            ids.add(id)
            if (!reply && !label) {
                segment('unknown', 'Unknown property width; remaining bytes', pos, end)
                return finish()
            }
            const width = reply ? 1 : profile?.widths[id] || 1
            if (pos + 1 + width > end) {
                out.errors.push('Truncated property')
                break
            }
            const raw = bytes.slice(pos + 1, pos + 1 + width),
                value = number(raw)
            segment('property', (label || 'Property 0x' + hex([id])) + (reply ? ' result' : ''), pos, pos + 1 + width, [
                field(
                    'property_' + id,
                    label || 'Unknown property',
                    raw,
                    label ? 'known' : 'unknown',
                    reply ? (RESULTS[value] || 'unknown') + ' (0x' + hex(raw) + ')' : value,
                ),
            ])
            pos += 1 + width
        }
        if (reply) status(pos, end, 'E6')
        else if (pos !== end) {
            out.errors.push('Property count/length mismatch')
            segment('unknown', 'Trailing property bytes', pos, end)
        }
    } else if (type === 0x0a) {
        out.summary = 'Envelope'
        if (end < 15 || word(bytes, 13) !== end - 15) {
            out.errors.push('Envelope payload length mismatch')
            segment('unknown', 'Envelope body', 4, end)
            return finish()
        }
        const inner = bytes[12],
            sequence = word(bytes, 7)
        segment('envelope', 'Envelope metadata', 4, 15, [
            field('sequence', 'Sequence', bytes.slice(7, 9)),
            field('delivery', 'Delivery class', [bytes[11]]),
            field('innerType', 'Inner type', [inner]),
            field('innerLength', 'Inner length', bytes.slice(13, 15)),
        ])
        decodeStatus(inner, 15, end, sequence)
    } else if (type === 0xeb || type === 0xec) decodeStatus(type, 4, end)
    else {
        out.summary = type === 0xc3 ? 'C3 heartbeat (payload unknown)' : 'Unknown type 0x' + hex([type])
        segment('unknown', 'Unknown payload', 4, end)
    }
    function decodeStatus(inner, start, stop, sequence) {
        if ((inner !== 0xeb && inner !== 0xec) || !profile) {
            segment('unknown', 'Unknown envelope/status payload', start, stop)
            return
        }
        out.summary = inner === 0xeb ? 'Current status (EB)' : 'Previous + current status (EC)'
        if (inner === 0xec) {
            if (stop - start !== 2 * profile.length || (profile.classByte === 0x20 && bytes[start] !== 0)) {
                out.errors.push('EC requires two complete records')
                segment('unknown', 'Invalid EC records', start, stop)
                return
            }
            segment('previous', 'Previous status (not current)', start, start + profile.length)
            start += profile.length
        }
        status(start, stop, inner === 0xeb ? 'EB' : 'EC', sequence)
    }
    return finish()
}
