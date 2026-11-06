import { TypedEmitter } from 'tiny-typed-emitter'
import type { Device } from './device'

type StreamEvents = {
    data: (packet: Buffer) => void
}

export interface Stream extends TypedEmitter<StreamEvents> {
    // the callback will be called when a protocol-specific response is received (or timed out)
    send(body: object, callback?: (response?: Buffer) => void): void
    destroy(): void
}

// Both a default implementation and a base for custom implementations.
// The default implementation performs no processing, it forwards data
// between the device and all streams simultaneously.
export class StreamImpl extends TypedEmitter<StreamEvents> implements Stream {
    readonly onDataBound: (packet: Buffer) => void
    readonly onCloseBound = () => this.destroy()
    private closed = false

    constructor(readonly mux: Multiplexer) {
        super()
        this.onDataBound = this.onData.bind(this)
        mux.dev.on('rawData', this.onDataBound)
        mux.dev.once('close', this.onCloseBound)
    }

    onData(buf: Buffer) {
        this.emit('data', buf)
    }

    send(body: object, callback?: () => void) {
        if (this.closed) return callback?.()
        this.mux.dev.sendRaw(body)
        if (callback) callback()
    }

    destroy() {
        this.closed = true
        this.mux.dev.removeListener('rawData', this.onDataBound)
        this.mux.dev.removeListener('close', this.onCloseBound)
        this.removeAllListeners()
    }
}

// No destroy(), the Connection is not supposed to outlive the mux
export class Multiplexer {
    constructor(readonly dev: Device) {}

    openStream() {
        return new StreamImpl(this)
    }
}
