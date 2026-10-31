import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LaundryStateStore } from '../../cloud/laundry-state'

function fixture(t: { after: (fn: () => void) => void }) {
    const directory = mkdtempSync(join(tmpdir(), 'rethink-laundry-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    return join(directory, 'laundry-state.json')
}

test('unseeded device remains unknown until explicit lifecycle evidence', (t) => {
    const store = new LaundryStateStore(fixture(t))
    assert.equal(store.get('washer').waiting, null)
    assert.equal(store.clear('washer', 'door', 1).waiting, null)
    assert.equal(store.complete('washer', {}, 2).waiting, null)
    store.active('washer', 3)
    assert.equal(store.complete('washer', {}, 4).waiting, true)
    assert.equal(store.get('dryer').waiting, null)
})

test('completion metadata and consumption survive process and model recreation', (t) => {
    const path = fixture(t)
    let store = new LaundryStateStore(path)
    store.active('washer', 100)
    store = new LaundryStateStore(path)
    assert.equal(store.get('washer').armed, true)
    const done = store.complete('washer', { cycle_minutes: 47, outcome: 'finished', fault: 'none' }, 200)
    store = new LaundryStateStore(path)
    assert.deepEqual(store.complete('washer', { cycle_minutes: 1 }, 300), done)
    store.clear('washer', 'door', 400)
    store = new LaundryStateStore(path)
    assert.equal(store.complete('washer', {}, 500).waiting, false)
    assert.equal(store.get('washer').cycle_minutes, 47)
    store.active('washer', 600)
    assert.equal(store.get('washer').cycle_minutes, undefined)
    assert.equal(store.complete('washer', {}, 700).waiting, true)
    assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('door must be received after completion; manual clear is explicit', () => {
    const store = new LaundryStateStore()
    store.active('dryer', 100)
    store.complete('dryer', {}, 200)
    assert.equal(store.clear('dryer', 'door', 100).waiting, true)
    assert.equal(store.clear('dryer', 'door', 200).waiting, true)
    assert.equal(store.clear('dryer', 'door', 201).waiting, false)
    assert.equal(store.clear('sidekick', 'manual', 300).waiting, false)
    assert.equal(store.complete('sidekick', {}, 400).waiting, false)
})

test('seeded off does not accept old completion and seeded on retains metadata', (t) => {
    const path = fixture(t)
    writeFileSync(
        path,
        JSON.stringify({
            version: 1,
            devices: {
                washer: { waiting: false, armed: false, completed: true },
                dryer: {
                    waiting: true,
                    armed: false,
                    completed: true,
                    finished_ts: '2026-10-31T12:00:00Z',
                    cycle_minutes: 42,
                },
            },
        }),
    )
    const store = new LaundryStateStore(path)
    assert.equal(store.complete('washer', {}, 100).waiting, false)
    assert.equal(store.complete('dryer', {}, 100).cycle_minutes, 42)
    assert.equal(store.get('sidekick').waiting, null)
})

test('malformed persistent state fails startup and failed writes do not change memory', (t) => {
    const path = fixture(t)
    writeFileSync(path, '{')
    assert.throws(() => new LaundryStateStore(path))
    writeFileSync(path, JSON.stringify({ version: 1, devices: { washer: { waiting: false } } }))
    assert.throws(() => new LaundryStateStore(path), /Invalid laundry/)
    const store = new LaundryStateStore(join(path, 'missing-directory.json'))
    assert.throws(() => store.active('washer'))
    assert.equal(store.get('washer').waiting, null)
    assert.match(readFileSync(path, 'utf8'), /version/)
})

test('idle preserves waiting and new active clears it even when idle report was missed', (t) => {
    const path = fixture(t)
    let store = new LaundryStateStore(path)
    store.active('washer', 100)
    store.complete('washer', {}, 200)
    assert.equal(store.idle('washer', 250).waiting, true)
    store = new LaundryStateStore(path)
    assert.equal(store.active('washer', 300).waiting, false)
    assert.equal(store.complete('washer', {}, 400).completionReceivedAt, 400)
    store = new LaundryStateStore(path)
    assert.equal(store.active('washer', 600).waiting, false)
    assert.equal(store.complete('washer', {}, 700).completionReceivedAt, 700)
})

test('manual acknowledgment does not disarm an active cycle', () => {
    const store = new LaundryStateStore()
    store.active('washer', 100)
    assert.equal(store.clear('washer', 'manual', 200).armed, true)
    assert.equal(store.complete('washer', {}, 300).waiting, true)
})
