export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this._handlers.get(event)?.delete(fn);
  }

  once(event, fn) {
    const off = this.on(event, (d) => {
      off();
      fn(d);
    });
    return off;
  }

  emit(event, data) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[zk-chat] handler for "${event}" failed`, err);
      }
    }
  }
}
