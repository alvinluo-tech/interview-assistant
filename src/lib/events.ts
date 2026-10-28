/*
 * 极简事件总线（对应原版的全局 mitt，承载 interviewer:utterance、
 * toast、overlay 内部通信等）。
 */
type Handler<T = unknown> = (payload: T) => void;

class Bus {
  private map = new Map<string, Set<Handler>>();

  on<T>(event: string, handler: Handler<T>): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  emit<T>(event: string, payload: T) {
    this.map.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (e) {
        console.error(`[bus] handler for ${event} failed`, e);
      }
    });
  }
}

export const bus = new Bus();
