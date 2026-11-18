import { MemoryManager } from "../src/page-table.js";

const mm = new MemoryManager({ capacity: 8, pageSize: 8 });

const parent = mm.createProcess();
mm.mapPage(parent, 0, Buffer.from("page-0"));
mm.mapPage(parent, 1, Buffer.from("page-1"));

const child = mm.forkProcess(parent);
console.log("fork 后（两页共享，零复制）:");
console.dir(mm.stats(), { depth: null });

mm.write(child, 0, Buffer.from("child-0"));
console.log("\n子进程写第 0 页（触发 COW）:");
console.log("parent page0 =", mm.read(parent, 0).toString().trimEnd());
console.log("child  page0 =", mm.read(child, 0).toString().trimEnd());
console.log("child 复制次数 =", mm.getCopyCount(child));

mm.write(child, 0, Buffer.from("child-x"));
console.log("\n再次写同一页（独占帧，就地更新，不再复制）:");
console.log("child 复制次数 =", mm.getCopyCount(child), " 已用帧 =", mm.stats().framesUsed);

const unmapResult = mm.unmap(parent, 1);
console.log("\n父进程取消映射第 1 页（子进程仍引用，不回收）:", unmapResult);

const destroyResult = mm.destroyProcess(parent);
console.log("销毁父进程（只回收无引用帧）:", destroyResult);

console.log("\n最终状态:");
console.dir(mm.stats(), { depth: null });
