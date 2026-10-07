function aborted() {
  return new DOMException("Cutout processing was cancelled.", "AbortError");
}

// Keep the verified local model briefly between photos, then release its memory.
export function createCutoutEngine({ idleMs = 45000, WorkerClass } = {}) {
  const documentRef = globalThis.document;
  const navigatorRef = globalThis.navigator;
  const idleDelay = navigatorRef?.deviceMemory <= 2 ? Math.min(idleMs, 15000) : idleMs;
  let worker = null, nextId = 0, activeId = null, warmupId = null, idleTimer = null, disposed = false;
  const pending = new Map();

  function release(error = aborted()) {
    clearTimeout(idleTimer); idleTimer = null;
    worker?.terminate(); worker = null;
    activeId = warmupId = null;
    const requests = [...pending.values()]; pending.clear();
    for (const request of requests) { clearTimeout(request.timer); request.reject(error); }
  }
  function idle() {
    clearTimeout(idleTimer);
    if (!activeId && worker) idleTimer = setTimeout(() => release(), idleDelay);
  }
  function ensureWorker() {
    if (disposed) throw new Error("The cutout tool has been closed.");
    if (worker) return worker;
    if (!WorkerClass && !globalThis.Worker) throw new Error("Automatic cutout is unavailable on this browser.");
    // Vite must see a literal Worker constructor to bundle the model runtime.
    const current = WorkerClass
      ? new WorkerClass(new URL("./cutout.worker.js", import.meta.url), { type: "module" })
      : new Worker(new URL("./cutout.worker.js", import.meta.url), { type: "module" });
    worker = current;
    current.onerror = () => {
      if (worker === current) release(new Error("The cutout tool couldn’t start. You can still trace your object."));
    };
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      const request = pending.get(data.id);
      if (!request) return;
      if (data.type === "status") {
        request.onStatus?.(data.message);
        if (data.id === warmupId) pending.get(activeId)?.onStatus?.(data.message);
        return;
      }
      if (data.type === "error") { release(new Error(data.message || "Automatic cutout could not finish.")); return; }
      const ready = request.type === "warmup" && data.type === "ready";
      const result = request.type === "run" && data.type === "result";
      if (!ready && !result) return;
      if (result && (!(data.mask instanceof Uint8ClampedArray || data.mask instanceof Uint8Array) || data.mask.length !== 320 * 320)) {
        release(new Error("The cutout tool returned an incomplete mask. Please try again.")); return;
      }
      pending.delete(data.id); clearTimeout(request.timer);
      if (data.id === activeId) activeId = null;
      if (data.id === warmupId) warmupId = null;
      request.resolve(result ? data.mask : undefined);
      idle();
    };
    return current;
  }
  function request(type, pixels, onStatus) {
    const current = ensureWorker(), id = ++nextId;
    clearTimeout(idleTimer); idleTimer = null;
    if (type === "run") activeId = id; else warmupId = id;
    return new Promise((resolve, reject) => {
      const timer = type === "run" ? setTimeout(() => {
        if (pending.has(id)) release(new Error("That took too long on this device. Try again, or trace the outline yourself."));
      }, 90000) : null;
      pending.set(id, { type, resolve, reject, onStatus, timer });
      try { current.postMessage({ type, id, ...(pixels ? { pixels } : {}) }, pixels ? [pixels.buffer] : []); }
      catch (error) { release(error); }
      // Warmup is bounded even when a download stalls; active processing has its own timeout.
      if (type === "warmup") idle();
    });
  }
  function visibilityChanged() { if (documentRef?.hidden) release(); }
  documentRef?.addEventListener("visibilitychange", visibilityChanged);

  return {
    warmup() {
      if (disposed || documentRef?.hidden || navigatorRef?.connection?.saveData || worker || warmupId) return;
      try { request("warmup").catch(() => {}); } catch { /* A background warmup must never interrupt the file chooser. */ }
    },
    run(pixels, { onStatus } = {}) {
      if (activeId) return Promise.reject(new Error("A photo is already being processed."));
      if (!pixels || pixels.length !== 320 * 320 * 4 || !(pixels instanceof Uint8ClampedArray || pixels instanceof Uint8Array)) {
        return Promise.reject(new Error("The cutout tool needs a 320-pixel photo preview."));
      }
      try { return request("run", pixels, onStatus); } catch (error) { return Promise.reject(error); }
    },
    cancel() { release(); },
    dispose() {
      disposed = true; release();
      documentRef?.removeEventListener("visibilitychange", visibilityChanged);
    },
  };
}
