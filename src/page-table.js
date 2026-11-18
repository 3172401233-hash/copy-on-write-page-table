export class MemoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "MemoryError";
  }
}

export class ProcessNotFoundError extends MemoryError {
  constructor(pid) {
    super(`process ${pid} does not exist`);
    this.name = "ProcessNotFoundError";
  }
}

export class DuplicateMappingError extends MemoryError {
  constructor(pid, vpn) {
    super(`virtual page ${vpn} of process ${pid} is already mapped`);
    this.name = "DuplicateMappingError";
  }
}

export class PageFaultError extends MemoryError {
  constructor(pid, vpn) {
    super(`virtual page ${vpn} of process ${pid} is not mapped`);
    this.name = "PageFaultError";
  }
}

export class OutOfMemoryError extends MemoryError {
  constructor(capacity) {
    super(`physical memory exhausted: capacity is ${capacity} frame(s)`);
    this.name = "OutOfMemoryError";
  }
}

export class PhysicalFrame {
  constructor(frameId, content) {
    this.frameId = frameId;
    this.content = content;
    this.refCount = 0;
  }
}

export class PhysicalMemory {
  constructor(capacity, pageSize) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("capacity must be a positive integer");
    }
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new RangeError("pageSize must be a positive integer");
    }
    this.capacity = capacity;
    this.pageSize = pageSize;
    this.frames = new Map();
    this.nextFrameId = 0;
  }

  get framesUsed() {
    return this.frames.size;
  }

  get freeFrames() {
    return this.capacity - this.frames.size;
  }

  allocate(content) {
    if (this.frames.size >= this.capacity) {
      throw new OutOfMemoryError(this.capacity);
    }
    const frame = new PhysicalFrame(this.nextFrameId++, content);
    frame.refCount = 1;
    this.frames.set(frame.frameId, frame);
    return frame;
  }

  retain(frameId) {
    const frame = this.#requireFrame(frameId);
    frame.refCount += 1;
    return frame.refCount;
  }

  release(frameId) {
    const frame = this.#requireFrame(frameId);
    if (frame.refCount <= 0) {
      throw new MemoryError(`frame ${frameId} has no references to release`);
    }
    frame.refCount -= 1;
    if (frame.refCount === 0) {
      this.frames.delete(frameId);
      return 0;
    }
    return frame.refCount;
  }

  get(frameId) {
    return this.frames.get(frameId) ?? null;
  }

  has(frameId) {
    return this.frames.has(frameId);
  }

  #requireFrame(frameId) {
    const frame = this.frames.get(frameId);
    if (!frame) {
      throw new MemoryError(`frame ${frameId} has already been reclaimed`);
    }
    return frame;
  }
}

class ProcessPageTable {
  constructor(pid) {
    this.pid = pid;
    this.mappings = new Map();
    this.pageCopyCounts = new Map();
    this.totalCopies = 0;
  }

  recordCopy(vpn) {
    this.totalCopies += 1;
    this.pageCopyCounts.set(vpn, (this.pageCopyCounts.get(vpn) ?? 0) + 1);
  }
}

export class MemoryManager {
  constructor({ capacity = 64, pageSize = 16 } = {}) {
    this.memory = new PhysicalMemory(capacity, pageSize);
    this.processes = new Map();
    this.nextPid = 1;
  }

  get capacity() {
    return this.memory.capacity;
  }

  get pageSize() {
    return this.memory.pageSize;
  }

  createProcess() {
    const pid = this.nextPid++;
    this.processes.set(pid, new ProcessPageTable(pid));
    return pid;
  }

  forkProcess(pid) {
    const parent = this.#requireProcess(pid);
    const childPid = this.nextPid++;
    const child = new ProcessPageTable(childPid);
    for (const [vpn, frameId] of parent.mappings) {
      child.mappings.set(vpn, frameId);
      this.memory.retain(frameId);
    }
    this.processes.set(childPid, child);
    return childPid;
  }

  mapPage(pid, vpn, content) {
    const process = this.#requireProcess(pid);
    if (process.mappings.has(vpn)) {
      throw new DuplicateMappingError(pid, vpn);
    }
    const frame = this.memory.allocate(this.#normalizeContent(content));
    process.mappings.set(vpn, frame.frameId);
    return this.#mappingView(process, vpn);
  }

  unmap(pid, vpn) {
    const process = this.#requireProcess(pid);
    const frameId = process.mappings.get(vpn);
    if (frameId === undefined) {
      throw new PageFaultError(pid, vpn);
    }
    process.mappings.delete(vpn);
    const refCount = this.memory.release(frameId);
    return {
      pid,
      vpn,
      frameId,
      refCount,
      reclaimed: refCount === 0
    };
  }

  destroyProcess(pid) {
    const process = this.#requireProcess(pid);
    const frameIds = [...process.mappings.values()];
    const reclaimed = [];
    for (const frameId of frameIds) {
      const refCount = this.memory.release(frameId);
      if (refCount === 0) {
        reclaimed.push(frameId);
      }
    }
    process.mappings.clear();
    this.processes.delete(pid);
    return { pid, releasedFrames: frameIds, reclaimedFrames: reclaimed };
  }

  read(pid, vpn) {
    const frame = this.#resolveFrame(pid, vpn);
    return frame.content;
  }

  write(pid, vpn, content) {
    const process = this.#requireProcess(pid);
    const frameId = process.mappings.get(vpn);
    if (frameId === undefined) {
      throw new PageFaultError(pid, vpn);
    }
    const frame = this.memory.get(frameId);
    if (!frame) {
      throw new MemoryError(`frame ${frameId} backing page ${vpn} was reclaimed`);
    }
    const nextContent = this.#normalizeContent(content);
    if (frame.refCount === 1) {
      frame.content.set(nextContent);
      return {
        pid,
        vpn,
        frameId,
        previousFrameId: frameId,
        copied: false,
        refCount: 1
      };
    }
    const replacement = this.memory.allocate(nextContent);
    process.mappings.set(vpn, replacement.frameId);
    this.memory.release(frameId);
    process.recordCopy(vpn);
    return {
      pid,
      vpn,
      frameId: replacement.frameId,
      previousFrameId: frameId,
      copied: true,
      refCount: 1
    };
  }

  lookup(pid, vpn) {
    const process = this.#requireProcess(pid);
    if (!process.mappings.has(vpn)) {
      return { pid, vpn, mapped: false };
    }
    return this.#mappingView(process, vpn);
  }

  listMappings(pid) {
    const process = this.#requireProcess(pid);
    return [...process.mappings.keys()]
      .sort((a, b) => a - b)
      .map((vpn) => this.#mappingView(process, vpn));
  }

  getRefCount(frameId) {
    return this.memory.get(frameId)?.refCount ?? 0;
  }

  getCopyCount(pid, vpn) {
    const process = this.#requireProcess(pid);
    if (vpn === undefined) {
      return process.totalCopies;
    }
    return process.pageCopyCounts.get(vpn) ?? 0;
  }

  stats() {
    const frames = [...this.memory.frames.values()]
      .sort((a, b) => a.frameId - b.frameId)
      .map((frame) => ({
        frameId: frame.frameId,
        refCount: frame.refCount
      }));
    const processes = [...this.processes.values()]
      .sort((a, b) => a.pid - b.pid)
      .map((process) => ({
        pid: process.pid,
        copyCount: process.totalCopies,
        mappings: [...process.mappings.keys()]
          .sort((a, b) => a - b)
          .map((vpn) => this.#mappingView(process, vpn))
      }));
    return {
      capacity: this.memory.capacity,
      pageSize: this.memory.pageSize,
      framesUsed: this.memory.framesUsed,
      freeFrames: this.memory.freeFrames,
      totalCopies: processes.reduce((sum, process) => sum + process.copyCount, 0),
      frames,
      processes
    };
  }

  #resolveFrame(pid, vpn) {
    const process = this.#requireProcess(pid);
    const frameId = process.mappings.get(vpn);
    if (frameId === undefined) {
      throw new PageFaultError(pid, vpn);
    }
    const frame = this.memory.get(frameId);
    if (!frame) {
      throw new MemoryError(`frame ${frameId} backing page ${vpn} was reclaimed`);
    }
    return frame;
  }

  #mappingView(process, vpn) {
    const frameId = process.mappings.get(vpn);
    const frame = this.memory.get(frameId);
    return {
      pid: process.pid,
      vpn,
      mapped: true,
      frameId,
      refCount: frame ? frame.refCount : 0,
      shared: frame ? frame.refCount > 1 : false
    };
  }

  #normalizeContent(content) {
    const buffer = Buffer.alloc(this.memory.pageSize);
    if (content === undefined || content === null) {
      return buffer;
    }
    const source = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content);
    if (source.length > this.memory.pageSize) {
      throw new RangeError(
        `content length ${source.length} exceeds page size ${this.memory.pageSize}`
      );
    }
    source.copy(buffer);
    return buffer;
  }

  #requireProcess(pid) {
    const process = this.processes.get(pid);
    if (!process) {
      throw new ProcessNotFoundError(pid);
    }
    return process;
  }
}
