import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateCache } from '../src/models/cache.js';
import { analyzePaging } from '../src/models/paging.js';
import { simulateReno } from '../src/models/reno.js';

const cacheInput = (overrides = {}) => ({
  cacheSize: 64, blockSize: 16, ways: 1, policy: 'LRU', addresses: [0], ...overrides,
});
const pagingInput = (overrides = {}) => ({
  virtualBits: 48, pageSize: 4096, addresses: ['0'], ...overrides,
});
const renoInput = (overrides = {}) => ({
  initialWindow: 1, initialThreshold: 8, roundCount: 4, events: [], ...overrides,
});

test('Cache：同一块的不同字节共享一次装入', () => {
  const result = simulateCache(cacheInput({ addresses: [0, 15, 16, 63, 0] }));
  assert.deepEqual(result.steps.map(({ block, hit }) => [block, hit]), [
    [0, false], [0, true], [1, false], [3, false], [0, true],
  ]);
  assert.deepEqual(result.stats, { accesses: 5, hits: 2, misses: 3, hitRate: 0.4 });
  assert.deepEqual(result.classification, { compulsory: 3, capacity: 0, conflict: 0 });
});

test('Cache：4 块全相联 FIFO 的策略缺失不被标为冲突缺失', () => {
  const addresses = [0, 16, 32, 48, 0, 64, 0];
  const fifo = simulateCache(cacheInput({ ways: 4, policy: 'FIFO', addresses }));
  const lru = simulateCache(cacheInput({ ways: 4, policy: 'LRU', addresses }));
  assert.equal(fifo.classification, null);
  assert.deepEqual(fifo.stats, { accesses: 7, hits: 1, misses: 6, hitRate: 1 / 7 });
  assert.equal(fifo.steps[5].evictedBlock, 0);
  assert.equal(lru.steps[5].evictedBlock, 1);
  assert.equal(lru.stats.hits, 2);
  assert.deepEqual(lru.classification, { compulsory: 5, capacity: 0, conflict: 0 });
  assert.deepEqual(fifo.steps[4].sets, [[0, 1, 2, 3]]);
  assert.deepEqual(lru.steps[4].sets, [[1, 2, 3, 0]]);
});

test('Cache：直接映射的同组地址循环产生冲突缺失', () => {
  const result = simulateCache(cacheInput({ cacheSize: 4, blockSize: 1, addresses: [0, 4, 0, 4] }));
  assert.deepEqual(result.classification, { compulsory: 2, capacity: 0, conflict: 2 });
  assert.equal(result.stats.misses, 4);
  assert.deepEqual(result.steps.map(({ set, tag }) => [set, tag]), [[0, 0], [0, 1], [0, 0], [0, 1]]);
});

test('Cache：工作集超出总容量时产生容量缺失', () => {
  const result = simulateCache(cacheInput({
    cacheSize: 2, blockSize: 1, ways: 2, addresses: [0, 1, 2, 0],
  }));
  assert.deepEqual(result.classification, { compulsory: 3, capacity: 1, conflict: 0 });
  assert.equal(result.stats.misses, 4);
});

test('Cache：实际命中也必须更新全相联 LRU 影子', () => {
  const result = simulateCache(cacheInput({
    cacheSize: 2, blockSize: 1, addresses: [0, 1, 0, 2, 0],
  }));
  assert.equal(result.stats.hits, 1);
  assert.deepEqual(result.classification, { compulsory: 3, capacity: 0, conflict: 1 });
});

test('Cache：地址计算不截断到 32 位', () => {
  const address = 2 ** 40;
  const result = simulateCache(cacheInput({ addresses: [address, address + 15, address + 64] }));
  assert.equal(result.steps[0].block, 2 ** 36);
  assert.equal(result.steps[0].tag, 2 ** 34);
  assert.equal(result.steps[1].hit, true);
  assert.equal(result.steps[2].tag, 2 ** 34 + 1);
  assert.equal(result.steps[2].evictedBlock, 2 ** 36);
});

test('Cache：输入不变，历史快照互不共享数组', () => {
  const input = Object.freeze(cacheInput({ addresses: Object.freeze([0, 64, 0]) }));
  const result = simulateCache(input);
  assert.deepEqual(result.steps[0].sets, [[0], [], [], []]);
  assert.deepEqual(result.steps[1].sets, [[4], [], [], []]);
  result.steps[2].sets[0].push(99);
  assert.deepEqual(result.steps[0].sets, [[0], [], [], []]);
  assert.deepEqual(input.addresses, [0, 64, 0]);
});

for (const [label, overrides, error] of [
  ['非 2 次幂容量', { cacheSize: 96 }, /2 的整数次幂/],
  ['浮点对数可能误判的大整数', { cacheSize: 2 ** 52 - 1 }, /2 的整数次幂/],
  ['块大于容量', { blockSize: 128 }, /块大小/],
  ['路数超过块数', { ways: 8 }, /路数/],
  ['零路数', { ways: 0 }, /正的安全整数/],
  ['超出快照组数上限', { cacheSize: 8192, blockSize: 1 }, /4096 组/],
  ['未知策略', { policy: 'random' }, /LRU 或 FIFO/],
  ['空地址序列', { addresses: [] }, /1 至 256/],
  ['过长地址序列', { addresses: Array(257).fill(0) }, /1 至 256/],
  ['稀疏地址数组', { addresses: Array(1) }, /非负安全整数/],
  ['负地址', { addresses: [-1] }, /非负安全整数/],
  ['小数地址', { addresses: [0.5] }, /非负安全整数/],
  ['超出安全整数的地址', { addresses: [2 ** 53] }, /非负安全整数/],
]) {
  test(`Cache 拒绝${label}`, () => assert.throws(() => simulateCache(cacheInput(overrides)), error));
}

test('分页：48 位 2 MiB 页使用 9+9+9+21 位，到 PD 层终止', () => {
  const result = analyzePaging(pagingInput({ pageSize: 2097152, addresses: ['0x201234'] }));
  assert.deepEqual(result.levels, ['PML4', 'PDPT', 'PD']);
  assert.equal(result.offsetBits, 21);
  assert.deepEqual(result.walks[0], {
    address: '0x201234',
    indices: [{ level: 'PML4', value: 0 }, { level: 'PDPT', value: 0 }, { level: 'PD', value: 1 }],
    offset: '0x1234', tableAccesses: 3, totalMemoryAccesses: 4,
  });
  assert.equal(result.totalTablePages, 3);
  assert.equal(result.totalTableBytes, 12288);
  assert.equal(result.mappedPages, 1);
});

test('分页：48 位 4 KiB 的地址 0 和 2^39 共需 7 张页表', () => {
  const result = analyzePaging(pagingInput({ addresses: ['0', '549755813888'] }));
  assert.deepEqual(result.tables, [
    { level: 'PML4', pages: 1, bytes: 4096 },
    { level: 'PDPT', pages: 2, bytes: 8192 },
    { level: 'PD', pages: 2, bytes: 8192 },
    { level: 'PT', pages: 2, bytes: 8192 },
  ]);
  assert.equal(result.totalTablePages, 7);
  assert.equal(result.totalTableBytes, 28672);
  assert.equal(result.mappedPages, 2);
  assert.deepEqual(result.walks[1].indices.map(({ value }) => value), [1, 0, 0, 0]);
  assert.equal(result.walks[0].tableAccesses, 4);
  assert.equal(result.walks[0].totalMemoryAccesses, 5);
});

test('分页：同页及相邻 PTE 共享页表，跨 PD 前缀则新建 PT', () => {
  const shared = analyzePaging(pagingInput({ addresses: ['0', '4095', '4096', '0x1000'] }));
  assert.equal(shared.mappedPages, 2);
  assert.equal(shared.totalTablePages, 4);
  assert.equal(shared.walks[1].offset, '0xfff');
  const separate = analyzePaging(pagingInput({ addresses: ['0', '2097152'] }));
  assert.deepEqual(separate.tables.map(({ pages }) => pages), [1, 1, 1, 2]);
  assert.equal(separate.totalTablePages, 5);
});

test('分页：1 GiB 大页在 PDPT 终止，每张页表仍为 4 KiB', () => {
  const result = analyzePaging(pagingInput({ pageSize: 1073741824, addresses: ['3221225479'] }));
  assert.deepEqual(result.levels, ['PML4', 'PDPT']);
  assert.equal(result.offsetBits, 30);
  assert.deepEqual(result.walks[0].indices.map(({ value }) => value), [0, 3]);
  assert.equal(result.walks[0].offset, '0x7');
  assert.equal(result.totalTableBytes, 8192);
  assert.equal(result.walks[0].totalMemoryAccesses, 3);
});

test('分页：57 位规范地址保留高位，进行 5 级转换', () => {
  const result = analyzePaging(pagingInput({
    virtualBits: 57,
    addresses: ['0xff00000000000000', '18446744073709551615', '0x00ffffffffffffff'],
  }));
  assert.deepEqual(result.levels, ['PML5', 'PML4', 'PDPT', 'PD', 'PT']);
  assert.deepEqual(result.walks.map(({ indices }) => indices.map(({ value }) => value)), [
    [256, 0, 0, 0, 0], [511, 511, 511, 511, 511], [255, 511, 511, 511, 511],
  ]);
  assert.equal(result.walks[1].address, '0xffffffffffffffff');
  assert.equal(result.walks[1].offset, '0xfff');
  assert.equal(result.walks[0].totalMemoryAccesses, 6);
  assert.equal(result.totalTablePages, 13);
});

test('分页：48 位正负规范区间边界均可映射', () => {
  const result = analyzePaging(pagingInput({ addresses: ['0x7fffffffffff', '0xffff800000000000'] }));
  assert.deepEqual(result.walks.map(({ indices }) => indices[0].value), [255, 256]);
  assert.equal(result.mappedPages, 2);
  assert.equal(result.totalTablePages, 7);
});

test('分页：57 位 1 GiB 大页为 3 级', () => {
  const result = analyzePaging(pagingInput({ virtualBits: 57, pageSize: 1073741824 }));
  assert.deepEqual(result.levels, ['PML5', 'PML4', 'PDPT']);
  assert.equal(result.totalTablePages, 3);
  assert.equal(result.walks[0].totalMemoryAccesses, 4);
});

for (const [label, overrides, error] of [
  ['不支持的虚拟地址位数', { virtualBits: 52 }, /48 或 57/],
  ['不支持的页大小', { pageSize: 8192 }, /pageSize/],
  ['未符号扩展的 48 位地址', { addresses: ['0x0000800000000000'] }, /规范地址/],
  ['错误符号扩展的 48 位地址', { addresses: ['0xffff7fffffffffff'] }, /规范地址/],
  ['未符号扩展的 57 位地址', { virtualBits: 57, addresses: ['0x0100000000000000'] }, /规范地址/],
  ['超出 64 位的地址', { addresses: ['0x10000000000000000'] }, /64 位地址范围/],
  ['number 类型地址', { addresses: [42] }, /字符串/],
  ['带负号的地址', { addresses: ['-1'] }, /字符串/],
  ['科学计数法地址', { addresses: ['1e3'] }, /字符串/],
  ['空地址数组', { addresses: [] }, /1 至 64/],
  ['过长地址数组', { addresses: Array(65).fill('0') }, /1 至 64/],
  ['稀疏地址数组', { addresses: Array(1) }, /字符串/],
]) {
  test(`分页拒绝${label}`, () => assert.throws(() => analyzePaging(pagingInput(overrides)), error));
}

test('Reno：慢开始到阈值后每轮只增加 1 MSS', () => {
  const result = simulateReno(renoInput({ roundCount: 6 }));
  assert.deepEqual(result.steps.map(({ cwndAfter }) => cwndAfter), [2, 4, 8, 9, 10, 11]);
  assert.equal(result.steps[2].phaseBefore, 'slow-start');
  assert.equal(result.steps[2].phaseAfter, 'congestion-avoidance');
  assert.equal(result.steps[3].phaseBefore, 'congestion-avoidance');
  assert.equal(result.steps[0].event, null);
});

test('Reno：慢开始不越过阈值继续翻倍', () => {
  const result = simulateReno(renoInput({ initialWindow: 3, initialThreshold: 5, roundCount: 2 }));
  assert.deepEqual(result.steps.map(({ cwndAfter }) => cwndAfter), [5, 6]);
});

test('Reno：窗口 16 的三次重复 ACK 完成快速恢复后为 8', () => {
  const result = simulateReno(renoInput({
    initialWindow: 16, initialThreshold: 16, roundCount: 1,
    events: [{ round: 1, type: 'triple-dup-ack' }],
  }));
  assert.deepEqual(result.steps[0], {
    round: 1, cwndBefore: 16, cwndAfter: 8, ssthreshBefore: 16, ssthreshAfter: 8,
    event: 'triple-dup-ack', phaseBefore: 'congestion-avoidance', phaseAfter: 'congestion-avoidance',
  });
});

test('Reno：窗口 16 的超时将阈值降到 8，窗口回到 1', () => {
  const result = simulateReno(renoInput({
    initialWindow: 16, initialThreshold: 16, roundCount: 2,
    events: [{ round: 1, type: 'timeout' }],
  }));
  assert.equal(result.steps[0].cwndAfter, 1);
  assert.equal(result.steps[0].ssthreshAfter, 8);
  assert.equal(result.steps[0].phaseAfter, 'slow-start');
  assert.equal(result.steps[1].cwndAfter, 2);
});

test('Reno：丢包阈值基于当轮开始窗口向下取整，最低为 2', () => {
  const odd = simulateReno(renoInput({
    initialWindow: 17, initialThreshold: 100, roundCount: 1,
    events: [{ round: 1, type: 'timeout' }],
  }));
  assert.equal(odd.steps[0].ssthreshAfter, 8);
  const small = simulateReno(renoInput({
    initialWindow: 3, roundCount: 1, events: [{ round: 1, type: 'timeout' }],
  }));
  assert.equal(small.steps[0].ssthreshAfter, 2);
});

test('Reno：无序事件按指定轮次生效且不修改输入', () => {
  const events = Object.freeze([
    Object.freeze({ round: 3, type: 'timeout' }),
    Object.freeze({ round: 1, type: 'triple-dup-ack' }),
  ]);
  const result = simulateReno(Object.freeze(renoInput({ initialWindow: 16, roundCount: 4, events })));
  assert.deepEqual(result.steps.map(({ cwndAfter }) => cwndAfter), [8, 9, 1, 2]);
  assert.deepEqual(result.steps.map(({ event }) => event), ['triple-dup-ack', null, 'timeout', null]);
  assert.equal(result.steps[2].ssthreshAfter, 4);
  assert.equal(events[0].round, 3);
});

for (const [label, overrides, error] of [
  ['小数窗口', { initialWindow: 1.5 }, /安全整数/],
  ['零窗口', { initialWindow: 0 }, /安全整数/],
  ['过小阈值', { initialThreshold: 1 }, /至少为 2/],
  ['超长仿真', { roundCount: 1001 }, /最多为 1000/],
  ['重复轮次事件', { events: [{ round: 1, type: 'timeout' }, { round: 1, type: 'timeout' }] }, /重复事件/],
  ['第零轮事件', { events: [{ round: 0, type: 'timeout' }] }, /1 至 4/],
  ['范围外事件', { events: [{ round: 5, type: 'timeout' }] }, /1 至 4/],
  ['未知事件', { events: [{ round: 1, type: 'ecn' }] }, /timeout 或 triple-dup-ack/],
  ['非数组事件', { events: null }, /事件数组/],
  ['稀疏事件数组', { events: Array(1) }, /事件对象/],
  ['增长溢出', { initialWindow: Number.MAX_SAFE_INTEGER, initialThreshold: 2, roundCount: 1 }, /超过安全整数范围/],
]) {
  test(`Reno 拒绝${label}`, () => assert.throws(() => simulateReno(renoInput(overrides)), error));
}

test('三个模型缺少参数时给出明确错误', () => {
  assert.throws(() => simulateCache(), /Cache 参数必须是对象/);
  assert.throws(() => analyzePaging(null), /分页参数必须是对象/);
  assert.throws(() => simulateReno([]), /Reno 参数必须是对象/);
});
