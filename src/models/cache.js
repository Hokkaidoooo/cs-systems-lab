const MAX_ACCESSES = 256;
const MAX_SET_COUNT = 4096;

function validatePowerOfTwo(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正的安全整数。`);
  }
  const bits = BigInt(value);
  if ((bits & (bits - 1n)) !== 0n) {
    throw new RangeError(`${name} 必须是 2 的整数次幂。`);
  }
}

function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Cache 参数必须是对象。');
  }
  const { cacheSize, blockSize, ways, policy, addresses } = input;
  for (const [name, value] of Object.entries({ cacheSize, blockSize, ways })) {
    validatePowerOfTwo(value, name);
  }
  const blockCount = cacheSize / blockSize;
  if (blockSize > cacheSize || ways > blockCount) {
    throw new RangeError('块大小不能超过 Cache 容量，路数不能超过总块数。');
  }
  const setCount = blockCount / ways;
  if (setCount > MAX_SET_COUNT) {
    throw new RangeError(`逐步快照最多支持 ${MAX_SET_COUNT} 组，请增大块大小或路数。`);
  }
  if (policy !== 'LRU' && policy !== 'FIFO') {
    throw new RangeError('policy 只能是 LRU 或 FIFO。');
  }
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_ACCESSES) {
    throw new RangeError(`addresses 必须包含 1 至 ${MAX_ACCESSES} 个字节地址。`);
  }
  for (const [index, address] of addresses.entries()) {
    if (!Number.isSafeInteger(address) || address < 0) {
      throw new RangeError(`addresses[${index}] 必须是非负安全整数。`);
    }
  }
  return { cacheSize, blockSize, ways, policy, blockCount, setCount };
}

function accessSet(blocks, block, capacity, policy) {
  const index = blocks.indexOf(block);
  if (index !== -1) {
    if (policy === 'LRU') {
      blocks.splice(index, 1);
      blocks.push(block);
    }
    return { hit: true, evictedBlock: null };
  }
  const evictedBlock = blocks.length === capacity ? blocks.shift() : null;
  blocks.push(block);
  return { hit: false, evictedBlock };
}

/** 单级、初始为空的 Cache；组内顺序为下一待淘汰块到最新块。 */
export function simulateCache(input) {
  const config = validateConfig(input);
  const { blockSize, ways, policy, blockCount, setCount } = config;
  const sets = Array.from({ length: setCount }, () => []);
  const shadow = [];
  const seen = new Set();
  const classification = policy === 'LRU' ? { compulsory: 0, capacity: 0, conflict: 0 } : null;
  let hits = 0;

  const steps = input.addresses.map((address, index) => {
    const block = Math.floor(address / blockSize);
    const set = block % setCount;
    const tag = Math.floor(block / setCount);
    const result = accessSet(sets[set], block, ways, policy);
    hits += Number(result.hit);

    if (classification) {
      // 影子 Cache 在每次访问时独立更新，不能只接收实际 Cache 的缺失。
      const shadowResult = accessSet(shadow, block, blockCount, 'LRU');
      if (!result.hit) {
        const kind = !seen.has(block) ? 'compulsory' : shadowResult.hit ? 'conflict' : 'capacity';
        classification[kind] += 1;
      }
      seen.add(block);
    }

    return {
      step: index + 1,
      address,
      block,
      set,
      tag,
      ...result,
      sets: sets.map((blocks) => [...blocks]),
    };
  });

  const accesses = steps.length;
  return {
    config,
    steps,
    stats: { accesses, hits, misses: accesses - hits, hitRate: hits / accesses },
    classification,
  };
}
