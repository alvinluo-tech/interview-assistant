export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class DesktopCdp {
  constructor(port, label = 'main') { this.port = port; this.label = label; this.sequence = 0; this.pending = new Map(); }
  async connect() {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = pages.find(p => p.type === 'page' && (this.label === 'overlay' ? p.url.includes('#overlay') : this.label === 'mock' ? p.url.includes('#mock') : !p.url.includes('#overlay') && !p.url.includes('#mock')));
        if (page?.webSocketDebuggerUrl) {
          const socket = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
          this.socket = socket;
          socket.onmessage = e => {
            const message = JSON.parse(e.data);
            const task = this.pending.get(message.id);
            if (!task) return;
            clearTimeout(task.timer); this.pending.delete(message.id);
            message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
          };
          if (await this.evaluate("window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label") === this.label) return;
          socket.close();
        }
      } catch { /* Wait for WebView2 initialization. */ }
      await delay(200);
    }
    throw new Error('Desktop debugging connection timed out');
  }
  command(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  }
  invoke(name, args = {}) { return this.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)})`); }
  async waitFor(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(`Wait timed out: ${expression}`);
  }
  async click(text) {
    const query = `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`;
    await this.waitFor(`!!(${query})`);
    await this.evaluate(`${query}.click()`);
    await delay(100);
  }
  async input(selector, value) {
    await this.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await delay(50);
  }
  async select(selector, value) {
    await this.evaluate(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await delay(50);
  }
  close() { this.socket?.close(); }
}
