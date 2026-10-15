# 模型、输入与适用范围

三个实验使用确定性的纯计算函数。相同输入产生相同结果，调用不会修改输入；不合法的参数会抛出带字段信息的异常。结果用于理解模型内的机制，不能直接用于预测某台硬件或真实网络的性能。

<a id="cache"></a>

## Cache：映射、替换与 3C 缺失

`simulateCache({ cacheSize, blockSize, ways, policy, addresses })`

- 容量和块大小以字节计，地址为字节地址；缓存初始为空。
- `cacheSize`、`blockSize`、`ways` 都必须为安全整数范围内的正 2 次幂。块大小不超过容量，路数不超过总块数。
- 总块数 `blockCount = cacheSize / blockSize`，组数 `setCount = blockCount / ways`。
- `policy` 只能为 `LRU` 或 `FIFO`；地址是非负安全整数数组，长度为 1—256。`MAX_ACCESSES = 256` 限定逐步展示规模。
- 为使每一步的完整分组快照可控，`MAX_SET_COUNT = 4096` 限制组数。超限会显式报错，不截断输入。

地址先除以块大小得到块号；组号为块号对组数取余；标记为块号除以组数向下取整。计算使用普通整数算术，不使用会截断到 32 位的 JavaScript 位运算。

每个 `steps` 项对应一次访问，`step` 从 1 开始，包含 `address`、`block`、`set`、`tag`、`hit`、`evictedBlock` 和访问完成后的 `sets` 快照。没有淘汰时，`evictedBlock` 为 `null`。`sets[组号]` 存放块号，左侧总是下一待淘汰块：

| 策略 | 从左到右的顺序 | 命中时 |
| --- | --- | --- |
| LRU | 最久未使用 → 最近使用 | 将命中块移到右侧 |
| FIFO | 最早装入 → 最新装入 | 保持原顺序 |

`stats` 包含访问数、命中数、缺失数及 `hitRate`；命中率取值为 0—1。每个历史快照拥有独立数组，后续访问不会改变之前的状态。

### 3C 分类口径

仅对 LRU 返回 `classification = { compulsory, capacity, conflict }`。另维护一个**同块大小、同总容量、全相联的 LRU 影子 Cache**，它接收完整访问序列，包括实际 Cache 命中的访问。每次实际缺失按下列顺序归类：

1. 此前从未访问过该块：强制缺失 `compulsory`。
2. 不是首次访问，影子 Cache 也缺失：容量缺失 `capacity`。
3. 不是首次访问，影子 Cache 命中：冲突缺失 `conflict`。

三类之和等于实际 LRU 缺失总数。这里的分类依赖明确的 LRU 参照模型。

FIFO 返回 `classification: null`。FIFO 与全相联 LRU 的差异可能来自替换策略，即使 FIFO 本身已经全相联，也可能比 LRU 多一次缺失，因此不能把这种差异直接命名为“冲突缺失”。

每步保留以下字段，供轨迹、回放和策略对照核对同一份判定：

| 字段 | 含义 |
| --- | --- |
| `firstAccess` | 此前是否从未访问过该**块**，LRU/FIFO 均为布尔值；同块内不同字节不算首次访问 |
| `shadowHit` | 本次访问在同容量全相联 LRU 影子中的命中结果，LRU 为布尔值；FIFO 不运行此参照模型，返回 `null` |
| `missType` | LRU 实际缺失的 `compulsory`、`capacity` 或 `conflict`；实际命中及所有 FIFO 访问均为 `null` |

`shadowHit` 表示影子处理本次访问时是否已经持有该块，`sets` 则是实际 Cache 完成本次访问后的快照。实际命中也可能对应影子缺失：2 块直接映射访问 `0,1,3,0`，最后的块 0 仍在实际 Cache 的组 0 中，但已被全相联 LRU 影子淘汰。此时 `hit: true`、`shadowHit: false`、`missType: null`，不增加任何 3C 计数。所有非空 `missType` 按类型计数，恰好等于汇总 `classification`。

可复核的小例子：

| 配置与块序列 | 结果 |
| --- | --- |
| 4 块、直接映射、LRU；`0,4,0,4` | 强制 2，冲突 2，容量 0 |
| 2 块、全相联、LRU；`0,1,2,0` | 强制 3，容量 1，冲突 0 |
| 4 块、全相联；`0,1,2,3,0,4,0` | FIFO 缺失 6 次；LRU 缺失 5 次 |

这些序列中的数字是块号；以字节地址调用时需乘以块大小。模型不包含读写差异、脏位、写回或写直达、多级 Cache、一致性协议、预取及访问延迟。

<a id="paging"></a>

## x86-64 分页：页表路径与内存占用

`analyzePaging({ virtualBits, pageSize, addresses })`

- `virtualBits` 为 48 或 57；假定对应的 4 级或 5 级分页模式可用并已启用。
- 数据页大小 `pageSize` 为 4 KiB、2 MiB 或 1 GiB，同一次调用使用统一页大小。
- **页表页固定为 4 KiB，页表项固定为 8 字节，每张页表 512 项，每级索引 9 位。** 数据大页不会放大页表页。
- 地址必须是无符号 64 位地址的字符串表示：十进制，或带 `0x` 前缀的十六进制。不接受 `number`、负号、空白、科学计数法或无前缀十六进制。
- `MAX_ADDRESSES = 64`，每次输入 1—64 个地址；超过限制会报错。

### 规范地址与大页终止层

48 位模式要求第 63—48 位等于第 47 位；57 位模式要求第 63—57 位等于第 56 位。函数校验完整的 64 位表示，不会把未符号扩展的地址静默补成规范地址。例如 `0xffff800000000000` 在 48 位模式合法，`0x0000800000000000` 不合法。

| 有效位数 | 页大小 | 页表层级 `levels` | 位划分 | TLB 未命中的总访存次数 |
| --- | --- | --- | --- | --- |
| 48 | 4 KiB | PML4 → PDPT → PD → PT | 9+9+9+9+12 | 5 |
| 48 | 2 MiB | PML4 → PDPT → PD | 9+9+9+21 | 4 |
| 48 | 1 GiB | PML4 → PDPT | 9+9+30 | 3 |
| 57 | 4 KiB | PML5 → PML4 → PDPT → PD → PT | 9+9+9+9+9+12 | 6 |
| 57 | 2 MiB | PML5 → PML4 → PDPT → PD | 9+9+9+9+21 | 5 |
| 57 | 1 GiB | PML5 → PML4 → PDPT | 9+9+9+30 | 4 |

总访存次数假设 TLB 未命中、各级页表及目标页均驻留内存、不考虑页表遍历缓存及数据缓存：**每级读取一个页表项，再访问一次目标数据**。`tableAccesses` 只数页表读取，`totalMemoryAccesses` 包含最后的数据访问；不表示实测 DRAM 请求数量或耗时。

### 页表数量来自具体地址布局

在一个地址空间中，根页表只有一张。下一层的每张页表由上层索引前缀唯一确定；函数逐层去重这些前缀。因此，两个地址即使映射的页数相同，也可能需要不同数量的页表。

48 位、4 KiB 页的例子：

| 输入地址 | PML4 / PDPT / PD / PT 页数 | 合计 |
| --- | --- | --- |
| `0`、`4096` | 1 / 1 / 1 / 1 | 4 张、16384 字节 |
| `0`、`2097152`（2²¹） | 1 / 1 / 1 / 2 | 5 张、20480 字节 |
| `0`、`549755813888`（2³⁹） | 1 / 2 / 2 / 2 | 7 张、28672 字节 |

`tables` 按访问顺序列出每级的 `level`、`pages`、`bytes`；`totalTablePages` 和 `totalTableBytes` 为其合计。`mappedPages` 是输入地址覆盖的不同数据页数，同页重复访问不重复计数。`walks` 保留每个输入地址的路径，`address` 和 `offset` 输出规范化的小写十六进制字符串，索引是 0—511 的整数。

这些数字是**模型中仅映射输入地址所在页面所需的页表数量**，不是某个真实进程的页表测量值，也不是仅根据“总页数”推算的紧凑排列下界。模型不含操作系统额外映射、混合页大小、共享页表、页表回收、物理地址分配、访问权限、缺页处理或嵌套分页。

<a id="reno"></a>

## Reno：按 RTT 汇总的教学模型

`simulateReno({ initialWindow, initialThreshold, roundCount, events })`

- 窗口 `cwnd` 和慢开始阈值 `ssthresh` 以 MSS 为单位，使用正的安全整数；初始阈值至少为 `MIN_THRESHOLD = 2`。
- `roundCount` 为 1—1000；`MAX_ROUNDS = 1000` 限定图表规模。计算中若窗口超出安全整数范围，会在对应轮次报错。
- `events` 默认为空数组。每项为 `{ round, type }`，轮次从 1 开始且不得重复；类型只能是 `timeout` 或 `triple-dup-ack`。事件可无序输入，但必须落在仿真范围内。
- 假设发送端每轮满窗发送，接收方窗口不构成限制；以当轮开始的窗口近似在途数据量。不建模逐包发送、ACK 到达和计时器。

### 一轮如何更新

| 当轮情况 | 新窗口 | 新阈值 |
| --- | --- | --- |
| 无事件，`cwnd < ssthresh` | `min(2 × cwnd, ssthresh)` | 保持不变 |
| 无事件，`cwnd >= ssthresh` | `cwnd + 1` | 保持不变 |
| 超时 | `1` | `max(floor(cwnd / 2), 2)` |
| 三次重复 ACK | 新阈值 | `max(floor(cwnd / 2), 2)` |

事件使用**当轮开始**的窗口计算，发生事件的轮次不再叠加正常增长。慢开始到阈值即停止翻倍；该轮不再细分剩余 ACK 带来的增长。窗口等于阈值时，阶段记为 `congestion-avoidance`，小于阈值时记为 `slow-start`。

三次重复 ACK 的结果展示**快速恢复完成后**的窗口，不展示快速恢复进入时临时增加的 `3 MSS`。例如窗口和阈值均为 16：三次重复 ACK 后两者均为 8；超时后阈值为 8、窗口为 1。不能把这两个结果画成同一个丢包响应。

每个 `steps` 项包含 `round`、`cwndBefore`、`cwndAfter`、`ssthreshBefore`、`ssthreshAfter`、`event`、`phaseBefore` 和 `phaseAfter`。无事件时 `event` 为 `null`。输入事件是外部教学条件，模型不验证某个窗口和包序列是否足以产生三次重复 ACK。

这不是完整的 TCP 实现：不包含瞬态快速恢复、逐 ACK 增长、延迟 ACK、RTO 估计、接收窗口、重传队列、超时退避、ECN、SACK、NewReno、CUBIC 或 BBR。它不能用来比较这些算法的吞吐量、时延或公平性。协议细节可对照 [RFC 5681](https://www.rfc-editor.org/rfc/rfc5681)；硬件分页细节可对照 [Intel 架构手册](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)。

## 验证

在项目目录运行 `node --test test/models.test.js`。测试采用手工可推导的访问序列、页表分支和拥塞窗口变化，覆盖正常结果、已知反例、输入边界及输入不变性。
