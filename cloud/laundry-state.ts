import {
    closeSync,
    existsSync,
    fsyncSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export interface LaundryMetadata {
    finished_ts?: string
    finished_at?: string
    cycle_minutes?: number
    outcome?: string
    fault?: string
}

export interface LaundryState extends LaundryMetadata {
    waiting: boolean | null
    armed: boolean
    completed: boolean
    completionReceivedAt?: number
    changedAt?: number
    reason?: string
}

interface StateFile {
    version: 1
    devices: Record<string, LaundryState>
}

const unknownState = (): LaundryState => ({ waiting: null, armed: false, completed: false })

function validState(value: unknown): value is LaundryState {
    if (!value || typeof value !== 'object') return false
    const s = value as Record<string, unknown>
    if (s.waiting !== null && typeof s.waiting !== 'boolean') return false
    if (typeof s.armed !== 'boolean' || typeof s.completed !== 'boolean') return false
    for (const key of ['completionReceivedAt', 'changedAt', 'cycle_minutes']) {
        if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]))) return false
    }
    for (const key of ['finished_ts', 'finished_at', 'outcome', 'fault', 'reason']) {
        if (s[key] !== undefined && typeof s[key] !== 'string') return false
    }
    return true
}

// This file records our accepted lifecycle, not an appliance's retained MQTT value.
// No file means unknown. A malformed file must stop startup rather than publish false-empty.
export class LaundryStateStore {
    private devices: Record<string, LaundryState> = Object.create(null)

    constructor(readonly path?: string) {
        if (!path || !existsSync(path)) return
        const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (!data || typeof data !== 'object') throw new Error('Invalid laundry state file')
        const state = data as StateFile
        if (
            state.version !== 1 ||
            !state.devices ||
            typeof state.devices !== 'object' ||
            Array.isArray(state.devices)
        ) {
            throw new Error('Invalid laundry state file')
        }
        for (const [id, entry] of Object.entries(state.devices)) {
            if (!validState(entry)) throw new Error(`Invalid laundry state for ${id}`)
            this.devices[id] = { ...entry }
        }
    }

    get(id: string): LaundryState {
        return { ...(this.devices[id] ?? unknownState()) }
    }

    idle(id: string, at = Date.now()): LaundryState {
        const state = this.get(id)
        if (!state.armed) return state
        return this.save(id, { ...state, armed: false, changedAt: at })
    }

    active(id: string, at = Date.now()): LaundryState {
        const state = this.get(id)
        if (state.armed && state.waiting === false) return state
        return this.save(id, {
            waiting: false,
            armed: true,
            completed: false,
            changedAt: at,
            reason: 'active',
        })
    }

    complete(id: string, metadata: Partial<LaundryMetadata> = {}, at = Date.now()): LaundryState {
        const state = this.get(id)
        // An acknowledged completion stays consumed across reconnects and process restarts.
        if (!state.armed) return state
        return this.save(id, {
            ...metadata,
            waiting: true,
            armed: false,
            completed: true,
            completionReceivedAt: at,
            changedAt: at,
            reason: 'completion',
            finished_ts: metadata.finished_ts ?? new Date(at).toISOString(),
        })
    }

    clear(id: string, reason: 'door' | 'manual', at = Date.now()): LaundryState {
        const state = this.get(id)
        // Receipt ordering is only a local fence. A delayed old door notification with
        // no wire identity cannot be distinguished from a fresh access notification.
        if (reason === 'door' && (state.waiting !== true || at <= (state.completionReceivedAt ?? -Infinity))) {
            return state
        }
        if (state.waiting === false) return state
        return this.save(id, { ...state, waiting: false, changedAt: at, reason })
    }

    private save(id: string, state: LaundryState): LaundryState {
        const devices = { ...this.devices, [id]: state }
        if (this.path) {
            const temporary = `${this.path}.${process.pid}.tmp`
            let fd: number | undefined
            try {
                fd = openSync(temporary, 'wx', 0o600)
                writeFileSync(fd, JSON.stringify({ version: 1, devices }, null, 2) + '\n')
                fsyncSync(fd)
                closeSync(fd)
                fd = undefined
                renameSync(temporary, this.path)
                const directory = openSync(dirname(this.path), 'r')
                try {
                    fsyncSync(directory)
                } finally {
                    closeSync(directory)
                }
            } finally {
                if (fd !== undefined) closeSync(fd)
                if (existsSync(temporary)) unlinkSync(temporary)
            }
        }
        this.devices = devices
        return { ...state }
    }
}
