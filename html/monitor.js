import { decodePacket } from './packet-decoder.js'

let ws
let reconnectTimer

get('device_id').innerText = new URLSearchParams(window.location.search).get('id')
get('device_status').innerText = 'Waiting for rethink connection...'

// The socket lives at /device, a sibling of this page. Appending to the page's own path instead
// asks for /monitordevice, which nothing serves.
function deviceSocketUrl() {
    const url = new URL('device', window.location.href)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = window.location.search
    return url
}

// As on the panel: first retry near-immediately, back off only if that fails too.
let retryDelay = 250

function connect() {
    clearTimeout(reconnectTimer)
    if (ws) {
        ws.onclose = ws.onopen = ws.onmessage = null
        try {
            ws.close()
        } catch {}
    }
    ws = new WebSocket(deviceSocketUrl())

    ws.onclose = () => {
        previousStatus = undefined
        reconnectTimer = setTimeout(connect, retryDelay)
        retryDelay = 5000
        get('device_status').innerText = 'Waiting for rethink connection...'
    }

    ws.onopen = () => {
        retryDelay = 250
        get('device_status').innerText = 'offline'
    }

    ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
            const json = JSON.parse(ev.data)
            if (json.rx) {
                pushMessage('rx', json.rx, json.injected, json.type)
            }

            if (json.tx) {
                pushMessage('tx', json.tx, json.injected, json.type)
            }

            if (json.status) {
                get('device_status').innerText = json.status
                if (json.status === 'online') {
                    get('btn_send1').disabled = false
                    get('btn_send1').onclick = () => {
                        let cmd = get('send1').value
                        if (cmd[0] === '{') cmd = JSON.parse(cmd)

                        ws.send(JSON.stringify({ sendToDevice: cmd }))
                    }

                    get('btn_send2').disabled = false
                    get('btn_send2').onclick = () => {
                        ws.send(JSON.stringify({ sendFromDevice: get('send2').value }))
                    }
                } else {
                    previousStatus = undefined
                    get('btn_send1').disabled = true
                    get('btn_send2').disabled = true
                }
            }

            if (json.meta) {
                deviceModel = json.meta.modelId
                previousStatus = undefined
                get('device_model').innerText = deviceModel
            }
        }
    }
}

// Same as the panel, and for the same reason its readyState check had to go: the restored socket can
// still read as OPEN here and only report its close afterwards.
window.addEventListener('pageshow', (ev) => {
    if (ev.persisted) connect()
})

const MAX_MESSAGES = 500
let deviceModel
let packetCount = 0
let previousStatus

function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
}

function details(label, open = false) {
    const node = element('details')
    node.open = open
    node.appendChild(element('summary', '', label))
    return node
}

function renderDecoded(decoded, direction, injected) {
    const body = element('div', 'packet-decoded')
    body.appendChild(element('div', 'packet-summary', decoded.summary))
    body.appendChild(element('div', decoded.valid ? 'packet-meta' : 'packet-warning',
        decoded.valid ? 'Length and checksum valid' : decoded.errors.join('; ')))
    // Invalid frames are never used as a status baseline.
    if (!decoded.valid) return body
    const segments = element('div', 'packet-segments')
    for (const segment of decoded.segments) {
        const node = element('div', 'packet-segment')
        node.appendChild(element('small', '', segment.label))
        node.appendChild(element('code', '', segment.hex))
        if (segment.kind !== 'status') {
            for (const field of segment.fields) {
                node.appendChild(element('small', '', field.label + ': ' + field.value))
            }
        }
        segments.appendChild(node)
    }
    const framing = details('Packet fields')
    framing.appendChild(segments)
    body.appendChild(framing)
    const status = decoded.status
    if (status) {
        const eligible = direction === 'rx' && !injected && status.source !== 'E6'
        const previous = direction === 'rx' && !injected ? previousStatus : undefined
        if (status.source === 'E6') body.appendChild(element('div', 'packet-meta',
            'Reply snapshot, not a confirmed whole-device state. Excluded from the ordinary-status comparison baseline.'))
        const changed = previous && previous.length === status.record.length
            ? status.record.flatMap((value, offset) => value !== previous[offset] ? [offset] : []) : []
        const notes = previous
            ? changed.length ? 'Changed record offsets: ' + changed.join(', ') : 'No record bytes changed.'
            : 'No preceding status baseline in this connection.'
        body.appendChild(element('div', 'packet-meta', notes))
        if (injected) body.appendChild(element('div', 'packet-warning', 'Injected report excluded from live status comparisons.'))
        const values = element('div', 'packet-summary')
        values.textContent = status.fields.filter((field) => field.confidence !== 'unknown').map((field) =>
            field.label + ': ' + field.value + (field.confidence === 'inferred' ? ' (inferred)' : '')).join(' · ')
        body.appendChild(values)
        const grid = element('div', 'status-bytes')
        for (const [offset, value] of status.record.entries()) {
            const fields = status.fields.filter((field) => offset >= field.offset && offset < field.offset + field.width)
            const field = fields[0]
            const node = element('div', 'status-byte' + (changed.includes(offset) ? ' changed' : '') +
                (!field || fields.every((entry) => entry.confidence === 'unknown') ? ' unknown' : ''))
            node.appendChild(element('small', '', 'Offset ' + offset))
            node.appendChild(element('code', '', value.toString(16).padStart(2, '0') + ' · ' + value))
            node.appendChild(element('small', '', field ? fields.map((entry) => entry.label +
                (entry.confidence === 'inferred' ? ' (inferred)' : '')).join(' / ') : 'Unknown'))
            if (changed.includes(offset)) node.title = 'Previous: ' + previous[offset].toString(16).padStart(2, '0') +
                '; XOR: ' + (previous[offset] ^ value).toString(16).padStart(2, '0')
            grid.appendChild(node)
        }
        const record = details('Status bytes · gold = changed; dashed = unknown')
        record.appendChild(grid)
        body.appendChild(record)
        if (eligible) previousStatus = [...status.record]
    }
    return body
}

function pushMessage(direction, payload, injected, type) {
    const messages = get('messages')
    const div = element('div', direction + ' message' + (injected ? ' injected' : ''))
    const header = element('div', 'packet-header')
    const label = direction === 'rx' ? 'Device → rethink' : 'Rethink → device'
    const decoded = decodePacket(payload, { model: deviceModel })
    if (decoded.type === 0xc3) div.classList.add('heartbeat')
    header.appendChild(element('span', 'packet-title', label + (injected ? ' · INJECTED' : '')))
    header.appendChild(element('span', 'packet-time', new Date().toLocaleTimeString() + ' · browser receipt'))
    if (type && type !== 'packet') header.appendChild(element('span', 'packet-meta', type))
    div.appendChild(header)
    div.appendChild(renderDecoded(decoded, direction, injected))
    const raw = details('Raw packet')
    raw.appendChild(element('pre', 'packet-raw', payload))
    div.appendChild(raw)
    messages.appendChild(div)
    while (messages.children.length > MAX_MESSAGES) messages.firstElementChild.remove()
    get('packet_count').textContent = ++packetCount + ' received · last ' + MAX_MESSAGES + ' retained'
    if (get('autoscroll').checked) messages.scrollTop = messages.scrollHeight
    return div
}

get('decode_packets').onchange = () => get('messages').classList.toggle('raw-only', !get('decode_packets').checked)
get('hide_heartbeats').onchange = () => get('messages').classList.toggle('hide-heartbeats', get('hide_heartbeats').checked)
get('clear_messages').onclick = () => {
    get('messages').replaceChildren()
    packetCount = 0
    previousStatus = undefined
    get('packet_count').textContent = '0 packets'
}

function get(id) {
    return document.getElementById(id)
}

connect()
