# copy-on-write-page-table
JavaScript 写时复制页表库，处理进程快照、共享页、脏页复制和回收

用纯 JavaScript 模拟操作系统的进程页表与写时复制（Copy-On-Write, COW）机制：
`fork` 只复制页表、不复制物理页；进程写共享页时才分配新物理帧并复制内容；
物理帧通过引用计数安全回收，任何快照仍在引用的帧都不会被误清除。

## 解决的问题

- 朴素 `fork` 在子进程只改一页时也全量复制父进程内存，代价高且浪费物理帧。
- 页表回收若只按单进程映射判断，会释放仍被另一个快照引用的物理页，造成悬空引用。
- 本库以“共享帧 + 引用计数 + 按需复制”同时解决这两个问题。

## 快照隔离保证

1. **fork 零复制**：`forkProcess` 仅复制虚拟页号到物理帧号的映射，并对每个共享帧
   执行 `refCount + 1`，不产生任何内容复制，`totalCopies` 保持不变。
2. **只读完全共享**：`read` 与 `lookup` 不改变映射；引用计数大于 1 的帧可被任意
   多个进程同时只读访问，所有进程读到同一份内容。
3. **写共享页才复制**：`write` 发现目标帧 `refCount > 1` 时，先分配新帧并复制页内容，
   再把当前进程的虚拟页改指到新帧，最后对旧帧减引用。其他进程的映射与内容完全不受影响。
4. **独占页就地写入**：帧 `refCount === 1` 时没有其他快照依赖，直接覆盖内容，
   不分配新帧、不增加复制次数。
5. **回收安全**：`unmap` / `destroyProcess` 只递减引用计数；计数归零才真正回收物理帧，
   仍被任何快照引用的帧保证存活，杜绝误清除。
6. **失败原子性**：物理内存耗尽时，COW 复制在修改映射之前抛出 `OutOfMemoryError`，
   原映射、引用计数和共享关系保持不变。
7. **连续写不重复复制**：同一页完成一次 COW 后变为独占帧，后续写入就地更新，
   每个虚拟页在每次变为共享状态后最多只复制一次。

## 快速开始

```js
import { MemoryManager } from "./src/page-table.js";

const mm = new MemoryManager({ capacity: 8, pageSize: 16 });
const parent = mm.createProcess();

mm.mapPage(parent, 0, Buffer.from("hello"));
const child = mm.forkProcess(parent);

mm.write(child, 0, Buffer.from("world"));

mm.read(parent, 0).toString(); // 'hello\0...' —— 父进程快照不变
mm.read(child, 0).toString();  // 'world\0...' —— 子进程拥有独立副本
mm.getCopyCount(child);        // 1
mm.stats();                    // 每帧引用数、每进程复制次数与映射状态
```

可直接运行端到端示例：

```bash
node examples/demo.js
```

## API

`new MemoryManager({ capacity = 64, pageSize = 16 })`

- `capacity`：物理帧总数（容量上限），`pageSize`：每页字节数。

进程与映射

- `createProcess()`：创建进程，返回 `pid`。
- `forkProcess(pid)`：创建快照子进程；复制全部映射并递增共享帧引用计数，返回子 `pid`。
- `mapPage(pid, vpn, content?)`：分配新物理帧并映射虚拟页，`content` 为 `Buffer`、
  字符串或省略（零页）；超长内容抛 `RangeError`，重复映射抛 `DuplicateMappingError`。
- `unmap(pid, vpn)`：取消一页映射并递减引用；返回 `{ frameId, refCount, reclaimed }`，
  `reclaimed` 为 `true` 表示该帧引用归零已被回收。
- `destroyProcess(pid)`：销毁进程并释放其全部映射，仅回收引用归零的帧。

读写

- `read(pid, vpn)`：返回页内容 `Buffer`（只读共享，不应外部修改）。
- `write(pid, vpn, content)`：写页；共享帧触发 COW 复制，独占帧就地更新。
  返回 `{ frameId, previousFrameId, copied, refCount }`，`copied` 标识是否发生复制。

观测

- `lookup(pid, vpn)`：返回 `{ mapped, frameId, refCount, shared }`，未映射时
  `mapped` 为 `false`。
- `listMappings(pid)`：按虚拟页号排序列出该进程全部映射。
- `getRefCount(frameId)`：查询物理帧引用数，已回收返回 `0`。
- `getCopyCount(pid, vpn?)`：查询某页或整个进程的累计 COW 复制次数。
- `stats()`：输出容量、已用/空闲帧、每帧引用数、每进程复制次数和完整映射状态。

错误类型（均继承 `MemoryError`）

- `ProcessNotFoundError`：进程不存在。
- `DuplicateMappingError`：虚拟页已映射。
- `PageFaultError`：访问未映射的虚拟页。
- `OutOfMemoryError`：物理帧容量不足，初始分配与 COW 分配都会抛出。

## 测试

```bash
node --test
```

覆盖场景：多进程 fork 与 fork 链、连续写时复制、只读共享、页回收与取消映射、
进程销毁、容量不足与 COW 失败原子性、重复映射/缺页等错误路径，以及 `stats` 输出。

## 目录结构

```
src/page-table.js        # 物理帧、物理内存、进程页表与 COW 管理器
test/page-table.test.js  # node:test 测试（16 个用例）
examples/demo.js         # 端到端演示脚本
```
