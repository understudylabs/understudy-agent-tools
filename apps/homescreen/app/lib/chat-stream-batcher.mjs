/**
 * Coalesces high-frequency model chunks into at most one React update per
 * animation frame. The runtime transcript remains lossless; only presentation
 * commits are paced so markdown and layout work cannot outrun the display.
 */
export class ChatStreamBatcher {
  #apply;
  #schedule;
  #cancel;
  #scheduled = null;
  #pending = null;

  constructor(apply, options = {}) {
    this.#apply = apply;
    this.#schedule = options.schedule ?? ((callback) => globalThis.requestAnimationFrame(callback));
    this.#cancel = options.cancel ?? ((handle) => globalThis.cancelAnimationFrame(handle));
  }

  appendContent(text) {
    if (!text) return;
    const pending = this.#ensurePending();
    pending.appendContent += text;
    this.#requestFlush();
  }

  replaceContent(text) {
    const pending = this.#ensurePending();
    pending.replaceContent = text;
    pending.appendContent = "";
    this.#requestFlush();
  }

  appendReasoning(text) {
    if (!text) return;
    const pending = this.#ensurePending();
    pending.appendReasoning += text;
    this.#requestFlush();
  }

  flush() {
    if (this.#scheduled !== null) {
      this.#cancel(this.#scheduled);
      this.#scheduled = null;
    }
    this.#drain();
  }

  reset() {
    if (this.#scheduled !== null) this.#cancel(this.#scheduled);
    this.#scheduled = null;
    this.#pending = null;
  }

  dispose() {
    this.reset();
  }

  #ensurePending() {
    this.#pending ??= {
      replaceContent: null,
      appendContent: "",
      appendReasoning: "",
    };
    return this.#pending;
  }

  #requestFlush() {
    if (this.#scheduled !== null) return;
    this.#scheduled = this.#schedule(() => {
      this.#scheduled = null;
      this.#drain();
    });
  }

  #drain() {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    this.#apply(pending);
  }
}
