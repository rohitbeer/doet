import { EventEmitter } from 'node:events';
import type { AgentId, DoetEvent } from './types.js';

/**
 * One typed channel for everything that happens in a session. Adapters publish,
 * the conductor and the UI subscribe. Keeping this single-channel means the
 * transcript writer gets the same stream the UI renders, so what you saw is
 * exactly what gets saved.
 */
export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Two agents streaming tokens plus a UI and a transcript listener adds up.
    this.emitter.setMaxListeners(50);
  }

  emit(event: DoetEvent): void {
    this.emitter.emit('event', event);
  }

  on(listener: (event: DoetEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  log(
    source: AgentId | 'doet',
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
  ): void {
    this.emit({ kind: 'log', source, message, level });
  }
}
