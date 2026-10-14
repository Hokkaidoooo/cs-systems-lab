const MAX_ADDRESSES = 64;
const TABLE_PAGE_BYTES = 4096;
const INDEX_BITS = 9;
const INDEX_MASK = (1n << BigInt(INDEX_BITS)) - 1n;
const UINT64_MASK = (1n << 64n) - 1n;
const OFFSET_BITS = new Map([[4096, 12], [2097152, 21], [1073741824, 30]]);
const LEVELS = new Map([
  [48, ['PML4', 'PDPT', 'PD', 'PT']],
  [57, ['PML5', 'PML4', 'PDPT', 'PD', 'PT']],
]);

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('分页参数必须是对象。');
  }
  const { virtualBits, pageSize, addresses } = input;
  if (!LEVELS.has(virtualBits)) {
    throw new RangeError('virtualBits 只能是 48 或 57。');
  }
  if (!OFFSET_BITS.has(pageSize)) {
    throw new RangeError('pageSize 只能是 4096、2097152 或 1073741824 字节。');
  }
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_ADDRESSES) {
    throw new RangeError(`addresses 必须包含 1 至 ${MAX_ADDRESSES} 个地址字符串。`);
  }
}

function parseAddress(value, index, virtualBits) {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) {
    throw new TypeError(`addresses[${index}] 必须是十进制或以 0x 开头的十六进制字符串。`);
  }
  const address = BigInt(value);
  if (address > UINT64_MASK) {
    throw new RangeError(`addresses[${index}] 超过无符号 64 位地址范围。`);
  }
  const width = BigInt(virtualBits);
  const lowMask = (1n << width) - 1n;
  const low = address & lowMask;
  const signBit = 1n << (width - 1n);
  const canonical = (low & signBit) === 0n ? low : low | (UINT64_MASK ^ lowMask);
  if (address !== canonical) {
    throw new RangeError(`addresses[${index}] 不是 ${virtualBits} 位规范地址：高位必须按符号位扩展到 64 位。`);
  }
  return address;
}

function hex(value) {
  return `0x${value.toString(16)}`;
}

/** 单一地址空间、统一页大小，统计覆盖给定地址集合的页表。 */
export function analyzePaging(input) {
  validateInput(input);
  const { virtualBits, pageSize, addresses } = input;
  const offsetBits = OFFSET_BITS.get(pageSize);
  const levelCount = (virtualBits - offsetBits) / INDEX_BITS;
  const levels = LEVELS.get(virtualBits).slice(0, levelCount);
  const tablePrefixes = levels.map(() => new Set());
  const mapped = new Set();
  const offsetMask = BigInt(pageSize) - 1n;
  const walks = [];

  for (const [addressIndex, value] of addresses.entries()) {
    const address = parseAddress(value, addressIndex, virtualBits);
    const indices = [];
    let prefix = '';
    for (const [levelIndex, level] of levels.entries()) {
      const shift = BigInt(virtualBits - INDEX_BITS * (levelIndex + 1));
      const index = Number((address >> shift) & INDEX_MASK);
      tablePrefixes[levelIndex].add(prefix);
      indices.push({ level, value: index });
      prefix += `${index}/`;
    }
    mapped.add(address >> BigInt(offsetBits));
    walks.push({
      address: hex(address),
      indices,
      offset: hex(address & offsetMask),
      tableAccesses: levelCount,
      totalMemoryAccesses: levelCount + 1,
    });
  }

  const tables = levels.map((level, index) => ({
    level,
    pages: tablePrefixes[index].size,
    bytes: tablePrefixes[index].size * TABLE_PAGE_BYTES,
  }));
  const totalTablePages = tables.reduce((total, table) => total + table.pages, 0);
  return {
    virtualBits,
    pageSize,
    levels,
    offsetBits,
    walks,
    tables,
    totalTablePages,
    totalTableBytes: totalTablePages * TABLE_PAGE_BYTES,
    mappedPages: mapped.size,
  };
}
