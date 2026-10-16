// Typed client event bus: server GameEvents (from snapshots) and locally predicted events.
// Events are queued as they are produced and flushed in production order once per frame, so every
// event is delivered exactly once and listeners observe the frame state they belong to.

import type { ClientEvent, ClientEventBus, ClientEventOf, ClientEventType } from './types';

type AnyCb = (ev: ClientEvent) => void;

export class EventBus implements ClientEventBus {
  private readonly typed = new Map<ClientEventType, Set<AnyCb>>();
  private readonly any = new Set<AnyCb>();
  private queue: ClientEvent[] = [];
  private spare: ClientEvent[] = [];

  on<T extends ClientEventType>(type: T, cb: (ev: ClientEventOf<T>) => void): () => void {
    let set = this.typed.get(type);
    if (!set) {
      set = new Set();
      this.typed.set(type, set);
    }
    const fn = cb as AnyCb;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  onAny(cb: AnyCb): () => void {
    this.any.add(cb);
    return () => {
      this.any.delete(cb);
    };
  }

  /** Queue an event for the next flush. */
  push(ev: ClientEvent): void {
    this.queue.push(ev);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Deliver all queued events in order (events queued by listeners during the flush included). */
  flush(): void {
    // Double buffering keeps the flush allocation free.
    while (this.queue.length > 0) {
      const batch = this.queue;
      this.queue = this.spare;
      for (let i = 0; i < batch.length; i++) this.dispatch(batch[i]);
      batch.length = 0;
      this.spare = batch;
    }
  }

  /** Dispatch immediately (bypassing the queue). */
  dispatch(ev: ClientEvent): void {
    const set = this.typed.get(ev.type);
    if (set) {
      for (const cb of set) {
        try {
          cb(ev);
        } catch (err) {
          console.error(`[game] '${ev.type}' listener failed`, err);
        }
      }
    }
    for (const cb of this.any) {
      try {
        cb(ev);
      } catch (err) {
        console.error('[game] event listener failed', err);
      }
    }
  }

  clear(): void {
    this.queue.length = 0;
    this.typed.clear();
    this.any.clear();
  }
}
