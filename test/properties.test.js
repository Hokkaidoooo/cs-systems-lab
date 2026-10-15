import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateCache } from '../src/models/cache.js';
import { analyzePaging } from '../src/models/paging.js';
import { simulateReno } from '../src/models/reno.js';

const SEEDS = [1, 408, 20261015, 0xdeadbeef];
function random(seed) {
  let value = seed >>> 0;
  return (limit) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value % limit;
  };
}

// 失败时删除仍可触发同一性质失败的元素，输出可直接粘贴重跑的 1-minimal 输入。
function checkProperty(seed, input, arrayKey, check) {
  try { check(input); } catch (failure) {
    let minimal = structuredClone(input);
    for (let i = 0; i < minimal[arrayKey].length;) {
      if (minimal[arrayKey].length <= (arrayKey === 'events' ? 0 : 1)) break;
      const candidate = { ...minimal, [arrayKey]: minimal[arrayKey].filter((_, j) => j !== i) };
      try { check(candidate); i += 1; } catch { minimal = candidate; i = 0; }
    }
    throw new Error(`seed=${seed}; 1-minimal=${JSON.stringify(minimal)}`, { cause: failure });
  }
}

function immutableCall(calculate, input) {
  const before = structuredClone(input);
  const result = calculate(input);
  assert.deepEqual(input, before, '模型不能修改调用者输入');
  return result;
}

for (const seed of SEEDS) {
  test(`性质 Cache 计数、分类和容量不变量 seed=${seed}`, () => {
    const next = random(seed);
    for (let trial = 0; trial < 80; trial += 1) {
      const blockSize = 2 ** next(5);
      const blocks = 2 ** next(5);
      const input = { cacheSize: blockSize * blocks, blockSize, ways: 2 ** next(Math.log2(blocks) + 1),
        policy: next(2) ? 'LRU' : 'FIFO', addresses: Array.from({ length: 1 + next(64) }, () => next(512)) };
      checkProperty(seed, input, 'addresses', (value) => {
        const result = immutableCall(simulateCache, value);
        assert.equal(result.stats.hits + result.stats.misses, value.addresses.length);
        assert.equal(result.stats.hits, result.steps.filter((step) => step.hit).length);
        if (value.policy === 'LRU') {
          assert.equal(Object.values(result.classification).reduce((a, b) => a + b, 0), result.stats.misses);
          assert.equal(result.classification.compulsory, new Set(value.addresses.map((a) => Math.floor(a / value.blockSize))).size);
          const stepCounts = { compulsory: 0, capacity: 0, conflict: 0 };
          for (const step of result.steps) {
            assert.equal(typeof step.shadowHit, 'boolean');
            if (step.hit) assert.equal(step.missType, null);
            else {
              assert.ok(Object.hasOwn(stepCounts, step.missType));
              stepCounts[step.missType] += 1;
            }
          }
          assert.deepEqual(stepCounts, result.classification, '逐步分类必须与汇总相同');
        } else assert.equal(result.classification, null);
        const seen = new Set();
        for (const step of result.steps) {
          assert.equal(step.firstAccess, !seen.has(step.block));
          seen.add(step.block);
          if (value.policy === 'FIFO') {
            assert.equal(step.missType, null);
            assert.equal(step.shadowHit, null);
          }
        }
        for (const step of result.steps) for (const set of step.sets) {
          assert.ok(set.length <= value.ways);
          assert.equal(new Set(set).size, set.length);
        }
      });
    }
  });

  test(`性质 分页重复映射不增加页表 seed=${seed}`, () => {
    const next = random(seed);
    for (let trial = 0; trial < 80; trial += 1) {
      const input = { virtualBits: next(2) ? 48 : 57, pageSize: [4096, 2097152, 1073741824][next(3)],
        addresses: Array.from({ length: 1 + next(20) }, () => `0x${(BigInt(next(2 ** 30)) * 4096n).toString(16)}`) };
      checkProperty(seed, input, 'addresses', (value) => {
        const result = immutableCall(analyzePaging, value);
        const duplicate = immutableCall(analyzePaging, { ...value, addresses: [...value.addresses, ...value.addresses] });
        assert.deepEqual(result.tables, duplicate.tables);
        assert.equal(result.totalTableBytes, duplicate.totalTableBytes);
        assert.equal(result.mappedPages, duplicate.mappedPages);
        const samePages = value.addresses.map((address) => (BigInt(address) / BigInt(value.pageSize) * BigInt(value.pageSize) + 1n).toString());
        assert.deepEqual(result.tables, analyzePaging({ ...value, addresses: samePages }).tables);
      });
    }
  });

  test(`性质 Reno 窗口边界与事件 seed=${seed}`, () => {
    const next = random(seed);
    for (let trial = 0; trial < 80; trial += 1) {
      const roundCount = 1 + next(80);
      const input = { initialWindow: 1 + next(32), initialThreshold: 2 + next(64), roundCount,
        events: Array.from({ length: roundCount }, (_, i) => ({ round: i + 1, type: next(2) ? 'timeout' : 'triple-dup-ack' })).filter(() => next(5) === 0) };
      checkProperty(seed, input, 'events', (value) => {
        const result = immutableCall(simulateReno, value);
        assert.equal(result.steps.length, value.roundCount);
        for (const step of result.steps) {
          assert.ok(Number.isSafeInteger(step.cwndAfter) && step.cwndAfter >= 1);
          assert.ok(step.ssthreshAfter >= 2);
          if (step.event === 'timeout') assert.equal(step.cwndAfter, 1);
          else if (step.event === 'triple-dup-ack') assert.equal(step.cwndAfter, step.ssthreshAfter);
          else if (step.cwndBefore < step.ssthreshBefore) assert.ok(step.cwndAfter <= step.ssthreshBefore);
          else assert.equal(step.cwndAfter - step.cwndBefore, 1);
        }
      });
    }
  });
}
