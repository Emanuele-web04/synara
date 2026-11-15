// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket and fetch.
// No dependencies, so the harness measures any checkout without installing into it.

export async function fetchJson(url, timeoutMs = 1_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

export class CdpSession {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  static async connect(webSocketUrl) {
    const session = new CdpSession();
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl);
      session.#socket = socket;
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`CDP connect failed: ${webSocketUrl}`)),
        {
          once: true,
        },
      );
      socket.addEventListener("message", (event) => session.#onMessage(event.data));
      socket.addEventListener("close", () => {
        for (const { reject: rejectPending } of session.#pending.values()) {
          rejectPending(new Error("CDP socket closed"));
        }
        session.#pending.clear();
      });
    });
    return session;
  }

  #onMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  /** Evaluates an expression (awaiting promises) and returns its JSON value. */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(
        `evaluate failed: ${detail.exception?.description ?? detail.text}\n${expression.slice(0, 200)}`,
      );
    }
    return result.result.value;
  }

  /** Calls a function source with JSON arguments inside the page. */
  call(fn, ...args) {
    return this.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  }

  close() {
    try {
      this.#socket.close();
    } catch {}
  }
}

/** Lists page targets of a running Chromium/Electron debugging endpoint. */
export async function listTargets(port) {
  return fetchJson(`http://127.0.0.1:${port}/json/list`);
}

export async function waitFor(
  check,
  { timeoutMs = 30_000, intervalMs = 25, label = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
