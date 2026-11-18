import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryManager,
  MemoryError,
  OutOfMemoryError,
  PageFaultError,
  DuplicateMappingError,
  ProcessNotFoundError
} from "../src/page-table.js";

test("mapPage 分配独占物理页并支持只读共享查询", () => {
  const mm = new MemoryManager({ capacity: 4, pageSize: 8 });
  const pid = mm.createProcess();

  const view = mm.mapPage(pid, 0, Buffer.from("AAAA"));
  assert.equal(view.mapped, true);
  assert.equal(view.refCount, 1);
  assert.equal(view.shared, false);
  assert.equal(mm.read(pid, 0).toString(), "AAAA\0\0\0\0");
  assert.equal(mm.getRefCount(view.frameId), 1);
});

test("重复映射同一虚拟页抛出 DuplicateMappingError", () => {
  const mm = new MemoryManager();
  const pid = mm.createProcess();
  mm.mapPage(pid, 3);
  assert.throws(() => mm.mapPage(pid, 3), DuplicateMappingError);
});

test("fork 后父子进程共享全部物理页且无复制发生", () => {
  const mm = new MemoryManager({ capacity: 8, pageSize: 8 });
  const parent = mm.createProcess();
  mm.mapPage(parent, 0, Buffer.from("page0"));
  mm.mapPage(parent, 1, Buffer.from("page1"));

  const child = mm.forkProcess(parent);

  for (const vpn of [0, 1]) {
    const parentView = mm.lookup(parent, vpn);
    const childView = mm.lookup(child, vpn);
    assert.equal(parentView.frameId, childView.frameId);
    assert.equal(parentView.refCount, 2);
    assert.equal(childView.shared, true);
  }
  assert.equal(mm.stats().framesUsed, 2);
  assert.equal(mm.getCopyCount(parent), 0);
  assert.equal(mm.getCopyCount(child), 0);
  assert.equal(mm.read(parent, 0), mm.read(child, 0));
});

test("写共享页触发 COW：新帧复制内容，原帧引用数下降，兄弟快照保持旧内容", () => {
  const mm = new MemoryManager({ capacity: 8, pageSize: 8 });
  const parent = mm.createProcess();
  mm.mapPage(parent, 0, Buffer.from("original"));
  const child = mm.forkProcess(parent);
  const sharedFrameId = mm.lookup(parent, 0).frameId;

  const result = mm.write(child, 0, Buffer.from("child!!"));

  assert.equal(result.copied, true);
  assert.notEqual(result.frameId, sharedFrameId);
  assert.equal(result.previousFrameId, sharedFrameId);
  assert.equal(mm.read(child, 0).toString(), "child!!\0");
  assert.equal(mm.read(parent, 0).toString(), "original");
  assert.equal(mm.getRefCount(sharedFrameId), 1);
  assert.equal(mm.getRefCount(result.frameId), 1);
  assert.equal(mm.getCopyCount(child, 0), 1);
  assert.equal(mm.getCopyCount(parent, 0), 0);
  assert.equal(mm.stats().framesUsed, 2);
});

test("连续写时复制：每次写共享帧都独立分配，旧帧按引用计数安全回收", () => {
  const mm = new MemoryManager({ capacity: 16, pageSize: 8 });
  const p1 = mm.createProcess();
  mm.mapPage(p1, 0, Buffer.from("v0"));
  const p2 = mm.forkProcess(p1);
  const p3 = mm.forkProcess(p1);
  const originalFrame = mm.lookup(p1, 0).frameId;
  assert.equal(mm.getRefCount(originalFrame), 3);

  const first = mm.write(p2, 0, Buffer.from("v1"));
  const second = mm.write(p2, 0, Buffer.from("v2"));

  assert.equal(first.copied, true);
  assert.equal(second.copied, false);
  assert.equal(second.frameId, first.frameId);
  assert.equal(mm.read(p2, 0).toString(), "v2\0\0\0\0\0\0");
  assert.equal(mm.read(p1, 0).toString(), "v0\0\0\0\0\0\0");
  assert.equal(mm.read(p3, 0).toString(), "v0\0\0\0\0\0\0");
  assert.equal(mm.getRefCount(originalFrame), 2);
  assert.equal(mm.getRefCount(first.frameId), 1);
  assert.equal(mm.getCopyCount(p2, 0), 1);
  assert.equal(mm.stats().framesUsed, 2);
});

test("多进程 fork 链：任一进程写共享页不影响其他快照", () => {
  const mm = new MemoryManager({ capacity: 16, pageSize: 8 });
  const root = mm.createProcess();
  mm.mapPage(root, 0, Buffer.from("root"));
  const a = mm.forkProcess(root);
  const b = mm.forkProcess(a);
  const c = mm.forkProcess(b);

  const frameBefore = mm.lookup(root, 0).frameId;
  assert.equal(mm.getRefCount(frameBefore), 4);

  mm.write(b, 0, Buffer.from("B-data"));

  assert.equal(mm.read(root, 0).toString(), "root\0\0\0\0");
  assert.equal(mm.read(a, 0).toString(), "root\0\0\0\0");
  assert.equal(mm.read(c, 0).toString(), "root\0\0\0\0");
  assert.equal(mm.read(b, 0).toString(), "B-data\0\0");
  assert.equal(mm.getRefCount(frameBefore), 3);
  assert.equal(mm.getCopyCount(b, 0), 1);

  mm.write(c, 0, Buffer.from("C-data"));
  assert.equal(mm.read(b, 0).toString(), "B-data\0\0");
  assert.equal(mm.read(c, 0).toString(), "C-data\0\0");
  assert.equal(mm.getCopyCount(c, 0), 1);
});

test("unmap 仅在最后一个引用释放时回收物理页，其他快照仍可正常访问", () => {
  const mm = new MemoryManager({ capacity: 8, pageSize: 8 });
  const p1 = mm.createProcess();
  mm.mapPage(p1, 0, Buffer.from("keep"));
  const p2 = mm.forkProcess(p1);
  const frameId = mm.lookup(p1, 0).frameId;

  const released = mm.unmap(p1, 0);
  assert.equal(released.refCount, 1);
  assert.equal(released.reclaimed, false);
  assert.equal(mm.memory.has(frameId), true);
  assert.equal(mm.read(p2, 0).toString(), "keep\0\0\0\0");
  assert.throws(() => mm.read(p1, 0), PageFaultError);
  assert.equal(mm.lookup(p1, 0).mapped, false);

  const last = mm.unmap(p2, 0);
  assert.equal(last.refCount, 0);
  assert.equal(last.reclaimed, true);
  assert.equal(mm.memory.has(frameId), false);
  assert.equal(mm.getRefCount(frameId), 0);
  assert.equal(mm.stats().framesUsed, 0);
});

test("对未映射页 unmap/read/write 抛出 PageFaultError", () => {
  const mm = new MemoryManager();
  const pid = mm.createProcess();
  assert.throws(() => mm.unmap(pid, 9), PageFaultError);
  assert.throws(() => mm.read(pid, 9), PageFaultError);
  assert.throws(() => mm.write(pid, 9, Buffer.from("x")), PageFaultError);
});

test("destroyProcess 只回收无其他引用的帧，共享帧保留", () => {
  const mm = new MemoryManager({ capacity: 8, pageSize: 8 });
  const p1 = mm.createProcess();
  mm.mapPage(p1, 0, Buffer.from("shared"));
  mm.mapPage(p1, 1, Buffer.from("private"));
  const p2 = mm.forkProcess(p1);
  mm.write(p1, 1, Buffer.from("p1-only"));
  const sharedFrame = mm.lookup(p1, 0).frameId;
  const privateFrame = mm.lookup(p1, 1).frameId;

  const result = mm.destroyProcess(p1);

  assert.deepEqual(result.releasedFrames.sort(), [sharedFrame, privateFrame].sort());
  assert.deepEqual(result.reclaimedFrames, [privateFrame]);
  assert.equal(mm.memory.has(sharedFrame), true);
  assert.equal(mm.memory.has(privateFrame), false);
  assert.equal(mm.read(p2, 0).toString(), "shared\0\0");
  assert.equal(mm.read(p2, 1).toString(), "private\0");
  assert.throws(() => mm.forkProcess(p1), ProcessNotFoundError);
});

test("容量不足：初始分配与 COW 分配耗尽物理内存时抛出 OutOfMemoryError", () => {
  const mm = new MemoryManager({ capacity: 2, pageSize: 4 });
  const pid = mm.createProcess();
  mm.mapPage(pid, 0, Buffer.from("a"));
  mm.mapPage(pid, 1, Buffer.from("b"));

  assert.throws(() => mm.mapPage(pid, 2), OutOfMemoryError);
  assert.equal(mm.stats().framesUsed, 2);

  const child = mm.forkProcess(pid);
  assert.throws(() => mm.write(child, 0, Buffer.from("z")), OutOfMemoryError);
  assert.equal(mm.read(child, 0).toString(), "a\0\0\0");
  assert.equal(mm.read(pid, 0).toString(), "a\0\0\0");
  assert.equal(mm.lookup(child, 0).frameId, mm.lookup(pid, 0).frameId);
  assert.equal(mm.getCopyCount(child, 0), 0);
});

test("COW 分配失败保持原子性：原映射与引用计数不被破坏", () => {
  const mm = new MemoryManager({ capacity: 1, pageSize: 4 });
  const p1 = mm.createProcess();
  mm.mapPage(p1, 0, Buffer.from("x"));
  const p2 = mm.forkProcess(p1);
  const frameId = mm.lookup(p1, 0).frameId;

  assert.throws(() => mm.write(p2, 0, Buffer.from("y")), OutOfMemoryError);

  assert.equal(mm.lookup(p1, 0).frameId, frameId);
  assert.equal(mm.lookup(p2, 0).frameId, frameId);
  assert.equal(mm.getRefCount(frameId), 2);
  assert.equal(mm.stats().framesUsed, 1);
});

test("独占页写入就地更新，不产生复制也不消耗新帧", () => {
  const mm = new MemoryManager({ capacity: 2, pageSize: 4 });
  const pid = mm.createProcess();
  mm.mapPage(pid, 0, Buffer.from("old"));
  const frameId = mm.lookup(pid, 0).frameId;

  const result = mm.write(pid, 0, Buffer.from("new"));

  assert.equal(result.copied, false);
  assert.equal(result.frameId, frameId);
  assert.equal(mm.read(pid, 0).toString(), "new\0");
  assert.equal(mm.getCopyCount(pid), 0);
  assert.equal(mm.stats().framesUsed, 1);
});

test("超长内容抛出 RangeError，未映射进程抛出 ProcessNotFoundError", () => {
  const mm = new MemoryManager({ pageSize: 4 });
  const pid = mm.createProcess();
  mm.mapPage(pid, 0);
  assert.throws(() => mm.write(pid, 0, Buffer.from("12345")), RangeError);
  assert.throws(() => mm.mapPage(999, 0), ProcessNotFoundError);
  assert.throws(() => mm.read(999, 0), ProcessNotFoundError);
  assert.throws(() => mm.lookup(999, 0), ProcessNotFoundError);
});

test("stats 输出每帧引用数、复制次数与映射状态快照", () => {
  const mm = new MemoryManager({ capacity: 8, pageSize: 4 });
  const p1 = mm.createProcess();
  mm.mapPage(p1, 0, Buffer.from("a"));
  mm.mapPage(p1, 1, Buffer.from("b"));
  const p2 = mm.forkProcess(p1);
  mm.write(p2, 1, Buffer.from("B"));

  const stats = mm.stats();
  assert.equal(stats.capacity, 8);
  assert.equal(stats.pageSize, 4);
  assert.equal(stats.framesUsed, 3);
  assert.equal(stats.freeFrames, 5);
  assert.equal(stats.totalCopies, 1);
  assert.deepEqual(
    stats.frames.map((frame) => frame.refCount),
    [2, 1, 1]
  );

  const p2Stats = stats.processes.find((entry) => entry.pid === p2);
  assert.equal(p2Stats.copyCount, 1);
  assert.deepEqual(
    p2Stats.mappings.map((mapping) => ({
      vpn: mapping.vpn,
      shared: mapping.shared,
      refCount: mapping.refCount
    })),
    [
      { vpn: 0, shared: true, refCount: 2 },
      { vpn: 1, shared: false, refCount: 1 }
    ]
  );

  assert.ok(stats.frames.every((frame) => frame.refCount >= 1));
});

test("回收后的帧可被新映射复用容量，且不影响现存引用", () => {
  const mm = new MemoryManager({ capacity: 2, pageSize: 4 });
  const p1 = mm.createProcess();
  mm.mapPage(p1, 0, Buffer.from("a"));
  mm.mapPage(p1, 1, Buffer.from("b"));
  mm.unmap(p1, 1);

  const p2 = mm.createProcess();
  const view = mm.mapPage(p2, 0, Buffer.from("c"));
  assert.equal(mm.stats().framesUsed, 2);
  assert.equal(mm.read(p1, 0).toString(), "a\0\0\0");
  assert.equal(mm.read(p2, 0).toString(), "c\0\0\0");
  assert.equal(view.refCount, 1);
});

test("MemoryError 是全部内存错误的基类", () => {
  const mm = new MemoryManager();
  assert.throws(
    () => mm.read(42, 0),
    (error) => error instanceof MemoryError && error instanceof ProcessNotFoundError
  );
});
