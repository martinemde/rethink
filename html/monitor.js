import { decodePacket } from './packet-decoder.js'
import {
    annotatedText,
    chunkTitle,
    directionLabel,
    directionTag,
    frameChunks,
    pressFrame,
    selectionBounds,
    transcriptLine,
} from './packet-view.js'

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

// Every frame gets a number when it arrives. Numbers keep counting across Clear and across the 500-frame
// cap, so "frames #1038–#1040" stays unambiguous in an issue or a chat.
let nextNumber = 1
const frames = new Map()
let selection = null
let focusedNumber = null
let heldNewFrames = 0

function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
}

function button(className, text, onClick) {
    const node = element('button', 'plain-button ' + className, text)
    node.type = 'button'
    if (onClick) node.onclick = onClick
    return node
}

// navigator.clipboard only exists in secure contexts, and rethink is usually opened over plain http on the
// LAN, so fall back to the selection-based copy there.
async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {}
    const area = element('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
        ok = document.execCommand('copy')
    } catch {}
    area.remove()
    return ok
}

function copyButton(className, label, text) {
    const node = button(className, label)
    node.onclick = async () => {
        node.textContent = (await copyText(typeof text === 'function' ? text() : text)) ? 'Copied' : 'Copy failed'
        setTimeout(() => (node.textContent = label), 1500)
    }
    return node
}

const bytesOf = (frame) => frame.rawHex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []

// Status comparison, as before: only live (not injected) device reports, never E6 snapshots, move the baseline.
function compareStatus(decoded, direction, injected) {
    const status = decoded.valid ? decoded.status : null
    if (!status) return { changedRecord: [], notes: [] }
    const live = direction === 'rx' && !injected
    const previous = live ? previousStatus : undefined
    const notes = []
    if (status.source === 'E6')
        notes.push(
            'Reply snapshot, not a confirmed whole-device state. Excluded from the ordinary-status comparison baseline.',
        )
    const changedRecord =
        previous && previous.length === status.record.length
            ? status.record.flatMap((value, offset) => (value !== previous[offset] ? [offset] : []))
            : []
    notes.push(
        previous
            ? changedRecord.length
                ? 'Changed record offsets: ' + changedRecord.join(', ')
                : 'No record bytes changed.'
            : 'No preceding status baseline in this connection.',
    )
    if (injected) notes.push('Injected report excluded from live status comparisons.')
    if (live && status.source !== 'E6') previousStatus = [...status.record]
    return { changedRecord, previous, notes }
}

function shortNote(frame) {
    const { decoded, chunks } = frame
    if (!decoded.valid) return decoded.errors.join('; ')
    const properties = decoded.segments
        .filter((s) => s.kind === 'property')
        .map((s) => s.fields.map((f) => f.label + ' ' + f.value).join(', '))
    if (properties.length) return properties.slice(0, 3).join(' · ') + (properties.length > 3 ? ' …' : '')
    if (frame.changedRecord.length) {
        const labels = chunks
            .filter((c) => c.recordOffset !== undefined && c.changed && c.kind !== 'unknown')
            .map((c) => c.label)
        const unknown = chunks.filter((c) => c.changed && c.kind === 'unknown').length
        return (
            'changed: ' +
            [...labels, ...(unknown ? [unknown + ' unmapped'] : [])].slice(0, 4).join(', ') +
            (labels.length > 4 ? ' …' : '')
        )
    }
    return ''
}

function renderChunks(frame) {
    const bytes = bytesOf(frame)
    const hex = element('div', 'frame-hex')
    hex.appendChild(element('span', 'frame-dir', directionTag(frame.direction) + ' '))
    for (const chunk of frame.chunks) {
        const node = element('span', 'chunk k-' + chunk.kind)
        node.title = chunkTitle(chunk)
        const raw = bytes.slice(chunk.start, chunk.end)
        if (chunk.kind === 'unknown') {
            for (const b of raw) node.appendChild(element('span', b ? 'nz' : '', b.toString(16).padStart(2, '0')))
        } else node.textContent = raw.map((b) => b.toString(16).padStart(2, '0')).join('')
        hex.appendChild(node)
    }
    return hex
}

function renderFrame(frame) {
    const row = element('div', 'frame ' + frame.direction + (frame.injected ? ' injected' : ''))
    row.dataset.number = frame.number
    if (frame.decoded.type === 0xc3) row.classList.add('heartbeat')

    const gutter = element('label', 'frame-num')
    const checkbox = element('input')
    checkbox.type = 'checkbox'
    checkbox.setAttribute('aria-label', 'Select frame ' + frame.number)
    gutter.append(checkbox, element('span', '', '#' + frame.number))
    row.appendChild(gutter)

    const lane = element('div', 'frame-lane')
    const bubble = element('div', 'bubble')
    const meta = element('div', 'frame-meta')
    const arrow = frame.direction === 'rx' ? '← ' : '→ '
    const label = button('frame-label', arrow + (frame.decoded.valid ? frame.decoded.summary : 'Invalid frame'))
    label.dataset.inspect = frame.number
    meta.appendChild(label)
    if (frame.injected) meta.appendChild(element('span', 'frame-warning', 'INJECTED'))
    if (frame.type && frame.type !== 'packet') meta.appendChild(element('span', '', frame.type))
    const note = shortNote(frame)
    if (note) meta.appendChild(element('span', frame.decoded.valid ? '' : 'frame-warning', note))
    meta.appendChild(element('span', 'frame-time', frame.time))
    bubble.appendChild(meta)
    bubble.appendChild(renderChunks(frame))
    lane.appendChild(bubble)
    row.appendChild(lane)
    return row
}

function pushMessage(direction, payload, injected, type) {
    const messages = get('messages')
    const decoded = decodePacket(payload, { model: deviceModel })
    const { changedRecord, previous, notes } = compareStatus(decoded, direction, injected)
    const chunks = frameChunks(decoded)
    for (const chunk of chunks)
        chunk.changed =
            chunk.recordOffset !== undefined &&
            changedRecord.some((o) => o >= chunk.recordOffset && o < chunk.recordOffset + (chunk.end - chunk.start))
    const frame = {
        number: nextNumber++,
        direction,
        injected: !!injected,
        type,
        decoded,
        chunks,
        changedRecord,
        previous,
        notes,
        // decodePacket normalises the payload; fall back to the payload itself if it was not even hex.
        rawHex: decoded.rawHex || String(payload).replace(/\s/g, ''),
        model: deviceModel,
        time: new Date().toLocaleTimeString(),
    }
    frame.row = renderFrame(frame)
    frames.set(frame.number, frame)

    messages.appendChild(frame.row)
    while (messages.children.length > MAX_MESSAGES) {
        const first = messages.firstElementChild
        const number = Number(first.dataset.number)
        frames.delete(number)
        selection?.selected.delete(number)
        first.remove()
    }
    get('packet_count').textContent = ++packetCount + ' received · last ' + MAX_MESSAGES + ' retained'

    if (selectionBounds(selection)) {
        // A selection holds the reader's place; count what arrives instead of scrolling away from it.
        heldNewFrames++
    } else {
        heldNewFrames = 0
        if (get('autoscroll').checked) messages.scrollTop = messages.scrollHeight
    }
    if (selection) {
        updateHoldPill()
        updateSelection()
    }
    return frame.row
}

// ---- selection ---------------------------------------------------------------------------------------

function visibleFrames(low, high) {
    const hideHeartbeats = get('hide_heartbeats').checked
    return [...frames.values()].filter(
        (f) => f.number >= low && f.number <= high && !(hideHeartbeats && f.decoded.type === 0xc3),
    )
}

function selectedFrames() {
    return visibleFrames(-Infinity, Infinity).filter((frame) => selection?.selected.has(frame.number))
}

function updateSelection() {
    const bounds = selectionBounds(selection)
    for (const frame of frames.values()) {
        const selected = selection?.selected.has(frame.number) ?? false
        frame.row.classList.toggle('in-range', selected)
        frame.row.querySelector('input[type="checkbox"]').checked = selected
    }
    renderSelectionBar(bounds)
}

function renderSelectionBar(bounds) {
    const bar = get('selection_bar')
    bar.replaceChildren()
    bar.classList.toggle('active', !!bounds)
    if (!bounds) {
        bar.appendChild(element('span', '', 'Select frames with the checkboxes. Shift-click to select a range.'))
        return
    }
    const count = selectedFrames().length
    bar.appendChild(element('span', 'range', 'Selected'))
    bar.appendChild(element('span', '', count === 1 ? '1 frame' : count + ' frames'))
    bar.appendChild(element('span', 'spacer'))
    bar.appendChild(
        copyButton('small-button', 'Copy D→R / R→D', () =>
            selectedFrames()
                .map((f) => transcriptLine(f.direction, f.rawHex))
                .join('\n'),
        ),
    )
    bar.appendChild(
        copyButton('small-button secondary', 'Copy hex', () =>
            selectedFrames()
                .map((f) => f.rawHex)
                .join('\n'),
        ),
    )
    bar.appendChild(button('link-button', 'Clear', () => setSelection(null)))
}

function updateHoldPill() {
    const pill = get('hold_pill')
    const bounds = selectionBounds(selection)
    pill.hidden = !bounds
    if (!bounds) return
    pill.textContent =
        'Holding at #' +
        bounds.high +
        (heldNewFrames ? ' · ' + heldNewFrames + ' new frame' + (heldNewFrames === 1 ? '' : 's') + ' ↓' : '') +
        ' · Jump to latest'
}

function setSelection(next) {
    selection = next
    if (!selectionBounds(selection)) heldNewFrames = 0
    updateSelection()
    updateHoldPill()
}

const messagesEl = get('messages')

messagesEl.addEventListener('click', (ev) => {
    const checkbox = ev.target.closest('input[type="checkbox"]')
    if (checkbox) {
        const number = Number(checkbox.closest('.frame').dataset.number)
        setSelection(
            pressFrame(
                selection,
                number,
                ev.shiftKey,
                visibleFrames(-Infinity, Infinity).map((f) => f.number),
            ),
        )
        focusFrame(number)
        return
    }
    const label = ev.target.closest('.frame-label')
    if (label) focusFrame(Number(label.dataset.inspect))
})

document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && selection && !ev.target.closest('input, textarea')) setSelection(null)
})

get('hold_pill').onclick = () => {
    setSelection(null)
    messagesEl.scrollTop = messagesEl.scrollHeight
}

// ---- inspector ---------------------------------------------------------------------------------------

function focusFrame(number) {
    const frame = frames.get(number)
    if (!frame) return
    frames.get(focusedNumber)?.row.classList.remove('focused')
    focusedNumber = number
    frame.row.classList.add('focused')
    renderInspector(frame)
}

function renderByteMap(frame) {
    const bytes = bytesOf(frame)
    const chunkAt = []
    for (const chunk of frame.chunks) for (let i = chunk.start; i < chunk.end; i++) chunkAt[i] = chunk
    const statusSegment = frame.decoded.segments.find((s) => s.kind === 'status')
    const changed = new Set(frame.changedRecord.map((o) => o + (statusSegment ? statusSegment.start : 0)))

    const table = element('table')
    const head = element('tr')
    head.appendChild(element('th'))
    for (let c = 0; c < 16; c++) head.appendChild(element('th', '', c.toString(16)))
    const thead = element('thead')
    thead.appendChild(head)
    table.appendChild(thead)
    const body = element('tbody')
    for (let r = 0; r < bytes.length; r += 16) {
        const tr = element('tr')
        tr.appendChild(element('th', '', '0x' + r.toString(16).padStart(2, '0')))
        for (let i = r; i < Math.min(r + 16, bytes.length); i++) {
            const chunk = chunkAt[i]
            const multi = chunk.end - chunk.start > 1 && chunk.kind !== 'unknown' && chunk.kind !== 'previous'
            const td = element('td', 'k-' + chunk.kind, bytes[i].toString(16).padStart(2, '0'))
            if (chunk.kind === 'unknown' && bytes[i]) td.classList.add('nz')
            if (multi) {
                td.classList.add('multi')
                if (i > chunk.start && i % 16 !== 0) td.classList.add('join-left')
                if (i < chunk.end - 1 && i % 16 !== 15) td.classList.add('join-right')
            }
            if (changed.has(i)) {
                td.classList.add('changed')
                const previous = frame.previous?.[i - statusSegment.start]
                if (previous !== undefined) td.dataset.previous = previous.toString(16).padStart(2, '0')
            }
            td.title =
                'byte ' +
                i +
                ' (0x' +
                i.toString(16).padStart(2, '0') +
                ')\n' +
                chunkTitle(chunk) +
                (td.dataset.previous ? '\nprevious: ' + td.dataset.previous : '')
            tr.appendChild(td)
        }
        // Pad the last row so the column headers keep their width on short frames.
        for (let i = bytes.length; i < r + 16; i++) tr.appendChild(element('td', 'pad'))
        body.appendChild(tr)
    }
    table.appendChild(body)
    const wrap = element('div', 'byte-map')
    wrap.appendChild(table)
    return wrap
}

function renderFieldTable(frame) {
    const bytes = bytesOf(frame)
    const table = element('table', 'field-table')
    const head = element('tr')
    for (const label of ['Offset', 'Bytes', 'Type', 'Field', 'Value']) head.appendChild(element('th', '', label))
    const thead = element('thead')
    thead.appendChild(head)
    table.appendChild(thead)
    const body = element('tbody')
    for (const chunk of frame.chunks) {
        const tr = element('tr', chunk.kind === 'unknown' ? 'unknown' : '')
        if (chunk.changed) tr.classList.add('changed')
        const raw = bytes
            .slice(chunk.start, chunk.end)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ')
        tr.appendChild(
            element('td', 'mono off', chunk.end - chunk.start > 1 ? chunk.start + '–' + (chunk.end - 1) : chunk.start),
        )
        const bytesCell = element('td', 'mono')
        bytesCell.appendChild(element('span', 'chunk k-' + chunk.kind, raw.length > 35 ? raw.slice(0, 32) + '…' : raw))
        bytesCell.firstChild.title = raw
        tr.appendChild(bytesCell)
        tr.appendChild(element('td', 'mono', chunk.type))
        tr.appendChild(element('td', 'name', chunk.label))
        tr.appendChild(element('td', '', chunk.kind === 'flags' || chunk.kind === 'flags-unknown' ? '' : chunk.value))
        body.appendChild(tr)
        if (chunk.bits) {
            const byte = bytes[chunk.start]
            for (const bit of chunk.bits) {
                const row = element('tr', 'bit')
                row.appendChild(element('td'))
                row.appendChild(element('td', 'mono', 'bit ' + Math.log2(bit.mask)))
                row.appendChild(element('td', 'mono', '0x' + bit.mask.toString(16).padStart(2, '0')))
                row.appendChild(element('td', '', bit.label))
                row.appendChild(element('td', '', bit.value ? 'on' : 'off'))
                body.appendChild(row)
            }
            const stray = byte & chunk.unmappedMask
            const row = element('tr', 'bit' + (stray ? ' unknown' : ''))
            row.appendChild(element('td'))
            row.appendChild(element('td', 'mono', 'other'))
            row.appendChild(element('td', 'mono', '0x' + chunk.unmappedMask.toString(16).padStart(2, '0')))
            row.appendChild(element('td', 'name', 'Unmapped bits'))
            row.appendChild(element('td', '', stray ? 'set: 0x' + stray.toString(16).padStart(2, '0') : 'all clear'))
            body.appendChild(row)
        }
    }
    table.appendChild(body)
    const wrap = element('div', 'field-table-wrap')
    wrap.appendChild(table)
    return wrap
}

function renderInspector(frame) {
    const panel = get('inspector')
    panel.className = 'inspector ' + frame.direction
    panel.replaceChildren()
    const { decoded } = frame
    const length = frame.rawHex.length / 2
    const unmapped = frame.chunks.filter((c) => c.kind === 'unknown').reduce((n, c) => n + c.end - c.start, 0)

    panel.appendChild(element('div', 'dir', directionLabel(frame.direction) + ' · #' + frame.number))
    panel.appendChild(element('h5', '', decoded.valid ? decoded.summary : 'Invalid frame'))
    panel.appendChild(
        element(
            'div',
            'meta',
            frame.time + ' · ' + length + ' bytes · ' + (length - unmapped) + ' mapped, ' + unmapped + ' unmapped',
        ),
    )
    panel.appendChild(
        element(
            'div',
            decoded.valid ? 'note' : 'note warning',
            decoded.valid ? 'Length and checksum valid' : decoded.errors.join('; '),
        ),
    )
    if (frame.injected) panel.appendChild(element('div', 'note warning', 'Injected by the monitor, not real traffic'))
    for (const note of frame.notes) panel.appendChild(element('div', 'note', note))

    const actions = element('div', 'actions')
    actions.appendChild(copyButton('small-button', 'Copy hex', frame.rawHex))
    actions.appendChild(
        button(
            'link-button',
            frame.direction === 'tx' ? 'Put in “Send to device”' : 'Put in “Inject as device”',
            () => {
                const input = get(frame.direction === 'tx' ? 'send1' : 'send2')
                input.value = frame.rawHex
                input.closest('details').open = true
                if (window.M) M.updateTextFields()
                input.focus()
            },
        ),
    )
    panel.appendChild(actions)

    panel.appendChild(renderByteMap(frame))
    panel.appendChild(renderFieldTable(frame))

    const annotated = annotatedText({
        number: frame.number,
        model: frame.model,
        time: frame.time,
        direction: frame.direction,
        summary: decoded.valid ? decoded.summary : 'invalid frame',
        rawHex: frame.rawHex,
        chunks: frame.chunks,
    })
    const more = element('details')
    more.appendChild(element('summary', '', 'Annotated text for issues'))
    more.appendChild(element('pre', '', annotated))
    more.appendChild(copyButton('link-button', 'Copy annotated text', annotated))
    panel.appendChild(more)
}

// ---- controls ----------------------------------------------------------------------------------------

get('decode_packets').onchange = () => get('messages').classList.toggle('raw-only', !get('decode_packets').checked)
get('hide_heartbeats').onchange = () => {
    get('messages').classList.toggle('hide-heartbeats', get('hide_heartbeats').checked)
    updateSelection()
}
get('clear_messages').onclick = () => {
    get('messages').replaceChildren()
    frames.clear()
    packetCount = 0
    previousStatus = undefined
    focusedNumber = null
    setSelection(null)
    get('inspector').className = 'inspector'
    get('inspector').replaceChildren(element('p', 'inspector-empty', "Click a frame's label to see its bytes here."))
    get('packet_count').textContent = '0 packets'
}

function get(id) {
    return document.getElementById(id)
}

renderSelectionBar(null)
connect()
