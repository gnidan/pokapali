import type { LoadTestEvent } from "./metrics.js";

export interface ChurnConfig {
  baselineWriters: number;
  baselineReaders: number;
  churnIntervalMs: number;
  churnSize: number;
  stabilizeMs: number;
}

export interface ChurnCallbacks {
  addWriter(): Promise<string>;
  removeWriter(id: string): Promise<void>;
  addReader(): Promise<string>;
  removeReader(id: string): Promise<void>;
  onEvent(event: LoadTestEvent): void;
}

export interface ChurnScheduler {
  readonly writers: ReadonlySet<string>;
  readonly readers: ReadonlySet<string>;
  readonly cycleCount: number;
  stop(): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export async function startChurnScheduler(
  config: ChurnConfig,
  callbacks: ChurnCallbacks,
): Promise<ChurnScheduler> {
  const writers = new Set<string>();
  const readers = new Set<string>();
  let cycleCount = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function emit(
    type: "node-joined" | "node-left" | "churn-cycle",
    detail?: string,
  ) {
    callbacks.onEvent({
      ts: Date.now(),
      type,
      docId: "",
      detail,
    });
  }

  // Spawn baseline nodes
  for (let i = 0; i < config.baselineWriters; i++) {
    const id = await callbacks.addWriter();
    writers.add(id);
    emit("node-joined", `writer:${id}`);
  }
  for (let i = 0; i < config.baselineReaders; i++) {
    const id = await callbacks.addReader();
    readers.add(id);
    emit("node-joined", `reader:${id}`);
  }

  async function runCycle() {
    if (stopped) return;

    const totalPool = writers.size + readers.size;
    if (totalPool === 0) return;

    const toRemove = Math.min(config.churnSize, totalPool);
    const removed: Array<{
      kind: "writer" | "reader";
      id: string;
    }> = [];

    for (let i = 0; i < toRemove; i++) {
      const writerCount = writers.size;
      const readerCount = readers.size;
      const total = writerCount + readerCount;
      if (total === 0) break;

      // Pick proportionally, but keep at least 1 writer
      const pickWriter =
        readerCount === 0
          ? true
          : writerCount <= 1
            ? false
            : Math.random() < writerCount / total;

      if (pickWriter) {
        const arr = [...writers];
        const id = pickRandom(arr);
        await callbacks.removeWriter(id);
        writers.delete(id);
        emit("node-left", `writer:${id}`);
        removed.push({ kind: "writer", id });
      } else {
        const arr = [...readers];
        const id = pickRandom(arr);
        await callbacks.removeReader(id);
        readers.delete(id);
        emit("node-left", `reader:${id}`);
        removed.push({ kind: "reader", id });
      }
    }

    if (stopped) return;

    // Wait for stabilization
    await delay(config.stabilizeMs);

    if (stopped) return;

    // Add replacements
    for (const { kind } of removed) {
      if (stopped) break;
      if (kind === "writer") {
        const id = await callbacks.addWriter();
        writers.add(id);
        emit("node-joined", `writer:${id}`);
      } else {
        const id = await callbacks.addReader();
        readers.add(id);
        emit("node-joined", `reader:${id}`);
      }
    }

    cycleCount++;
    emit("churn-cycle", `cycle:${cycleCount}`);

    if (!stopped) {
      scheduleNext();
    }
  }

  function scheduleNext() {
    timer = setTimeout(() => {
      runCycle();
    }, config.churnIntervalMs);
  }

  scheduleNext();

  return {
    get writers() {
      return writers as ReadonlySet<string>;
    },
    get readers() {
      return readers as ReadonlySet<string>;
    },
    get cycleCount() {
      return cycleCount;
    },
    stop() {
      stopped = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
