import { simulateCache } from './models/cache.js';
import { analyzePaging } from './models/paging.js';
import { simulateReno } from './models/reno.js';
import { FIELDS, serializeSnapshot, deserializeSnapshot } from './share.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GROUPS_PER_PAGE = 16;
const state = { cache: null, cacheComparison: null, cacheIndex: 0, cacheGroupPage: 0, paging: null, reno: null, renoIndex: 0 };
const mobileChart = window.matchMedia('(max-width: 640px)');
const byId = (id) => document.getElementById(id);
const setText = (id, value) => { byId(id).textContent = String(value); };
const formatNumber = (value) => Number.isInteger(value) ? String(value) : value.toFixed(2);
const hex = (value) => `0x${value.toString(16).toUpperCase()}`;
let renoGeometry;

class InputError extends Error {
  constructor(message, fieldId) {
    super(message);
    this.name = 'InputError';
    this.fieldId = fieldId;
  }
}

function phaseName(phase) {
  if (phase === 'slow-start') return '慢启动';
  if (phase === 'congestion-avoidance') return '拥塞避免';
  throw new Error('模型返回了未知的拥塞控制阶段。');
}

function eventName(event) {
  if (event === null) return '正常确认';
  if (event === 'timeout') return '超时';
  if (event === 'triple-dup-ack') return '三次重复 ACK';
  throw new Error('模型返回了未知的拥塞事件。');
}

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${formatNumber(bytes / 1073741824)} GiB`;
  if (bytes >= 1048576) return `${formatNumber(bytes / 1048576)} MiB`;
  if (bytes >= 1024) return `${formatNumber(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function validateForm(form) {
  for (const field of form.querySelectorAll('input, select, textarea')) {
    if (field.validity.valid) continue;
    const label = form.querySelector(`label[for="${field.id}"]`).textContent.trim();
    if (field.validity.valueMissing) throw new InputError(`请填写“${label}”。`, field.id);
    if (field.validity.rangeUnderflow) throw new InputError(`“${label}”不能小于 ${field.min}。`, field.id);
    if (field.validity.stepMismatch) throw new InputError(`“${label}”请输入整数。`, field.id);
    throw new InputError(`“${label}”不是有效的输入值，请检查后重试。`, field.id);
  }
}

function tokens(fieldId, allowEmpty = false) {
  const values = byId(fieldId).value.trim().split(/[,，;；\s]+/u).filter(Boolean);
  if (!allowEmpty && values.length === 0) throw new InputError('请至少输入一个地址。', fieldId);
  return values;
}

function cacheInput() {
  const addresses = tokens('cache-addresses').map((token, index) => {
    if (!/^(?:0x[\da-f]+|\d+)$/i.test(token)) {
      throw new InputError(`访问序列第 ${index + 1} 项不是十进制或 0x 十六进制整数。`, 'cache-addresses');
    }
    return Number(token);
  });
  return {
    cacheSize: Number(byId('cache-size').value),
    blockSize: Number(byId('cache-block').value),
    ways: Number(byId('cache-ways').value),
    policy: byId('cache-policy').value,
    addresses,
  };
}

function renoEvents(fieldId, type) {
  return tokens(fieldId, true).map((token, index) => {
    if (!/^\d+$/.test(token)) throw new InputError(`事件列表第 ${index + 1} 项应为整数轮次。`, fieldId);
    return { round: Number(token), type };
  });
}

function renoInput() {
  return {
    initialWindow: Number(byId('reno-window').value),
    initialThreshold: Number(byId('reno-threshold').value),
    roundCount: Number(byId('reno-rounds').value),
    events: [...renoEvents('reno-duplicate', 'triple-dup-ack'), ...renoEvents('reno-timeouts', 'timeout')],
  };
}

function runExperiment(name, calculate, render, announce = true) {
  const form = byId(`${name}-form`);
  const errorBox = byId(`${name}-error`);
  errorBox.hidden = true;
  errorBox.textContent = '';
  form.querySelectorAll('[aria-invalid]').forEach((field) => field.removeAttribute('aria-invalid'));
  try {
    validateForm(form);
    const result = calculate();
    render(result);
    byId(`${name}-results`).hidden = false;
    if (announce) setText('live-status', '实验已完成。参数与结果已更新。');
    return true;
  } catch (error) {
    byId(`${name}-results`).hidden = true;
    errorBox.textContent = `实验未运行成功：${error.message}`;
    errorBox.hidden = false;
    if (error instanceof InputError) byId(error.fieldId).setAttribute('aria-invalid', 'true');
    if (announce) errorBox.focus({ preventScroll: true });
    console.error(`${name} 实验失败`, error);
    return false;
  }
}

function runCache(announce = true) {
  return runExperiment('cache', () => {
    const input = cacheInput();
    const comparison = Object.fromEntries(['LRU', 'FIFO'].map((policy) => [policy, simulateCache({ ...input, policy })]));
    return { data: comparison[input.policy], comparison };
  }, ({ data, comparison }) => {
    state.cacheComparison = comparison;
    renderCache(data);
    renderComparisonSummary();
  }, announce);
}

function renderComparisonSummary() {
  const { LRU, FIFO } = state.cacheComparison;
  const firstOrder = LRU.steps.findIndex((step, index) => JSON.stringify(step.sets) !== JSON.stringify(FIFO.steps[index].sets));
  const firstEviction = LRU.steps.findIndex((step, index) => step.evictedBlock !== FIFO.steps[index].evictedBlock);
  setText('cache-comparison-summary', `LRU ${LRU.stats.hits}/${LRU.stats.accesses} 命中；FIFO ${FIFO.stats.hits}/${FIFO.stats.accesses} 命中。`
    + (firstOrder < 0 ? '组内顺序没有分歧。' : `首次组内顺序分歧：第 ${firstOrder + 1} 次访问。`)
    + (firstEviction < 0 ? '被替换块没有分歧。' : `首次替换分歧：第 ${firstEviction + 1} 次访问，LRU 替换块 ${LRU.steps[firstEviction].evictedBlock}，FIFO 替换块 ${FIFO.steps[firstEviction].evictedBlock}。`));
}

function renderComparisonStep(index) {
  for (const policy of ['LRU', 'FIFO']) {
    const step = state.cacheComparison[policy].steps[index];
    setText(`compare-${policy}-result`, `第 ${step.step} 次 · ${step.hit ? '命中' : '未命中'} · ${step.evictedBlock === null ? '无替换' : `替换块 ${step.evictedBlock}`}`);
    const blocks = step.sets[step.set];
    setText(`compare-${policy}-blocks`, `组 ${step.set}：${blocks.map((block) => `#${block}`).join(' → ')}`);
  }
}

function runPaging(announce = true) {
  return runExperiment('paging', () => analyzePaging({
    virtualBits: Number(byId('paging-bits').value),
    pageSize: Number(byId('paging-size').value),
    addresses: tokens('paging-addresses'),
  }), renderPaging, announce);
}

function runReno(announce = true) {
  return runExperiment('reno', () => simulateReno(renoInput()), renderReno, announce);
}

function traceButton(step, onSelect) {
  const button = element('button', 'trace-button', String(step).padStart(2, '0'));
  button.type = 'button';
  button.setAttribute('aria-label', `查看第 ${step} 轮`);
  button.addEventListener('click', onSelect);
  return button;
}

function tableCell(content) {
  const cell = element('td');
  cell.append(content instanceof Node ? content : document.createTextNode(String(content)));
  return cell;
}

function markCurrentRow(tbodyId, index) {
  for (const [rowIndex, row] of [...byId(tbodyId).rows].entries()) {
    const current = rowIndex === index;
    row.classList.toggle('is-current', current);
    if (current) row.setAttribute('aria-current', 'step');
    else row.removeAttribute('aria-current');
  }
}

function syncReplay(prefix, index, count, description) {
  const slider = byId(`${prefix}-step`);
  slider.max = String(count);
  slider.value = String(index + 1);
  slider.setAttribute('aria-valuetext', description);
  setText(`${prefix}-step-count`, `${String(index + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}`);
  byId(`${prefix}-prev`).disabled = index === 0;
  byId(`${prefix}-next`).disabled = index === count - 1;
}

function renderCache(data) {
  state.cache = data;
  state.cacheIndex = data.steps.length - 1;
  const groupCount = data.steps[0].sets.length;
  setText('cache-hit-rate', `${formatNumber(data.stats.hitRate * 100)}%`);
  setText('cache-hit-detail', `${data.stats.hits} / ${data.stats.accesses} 次访问命中`);
  setText('cache-geometry', `${groupCount} × ${data.config.ways}`);
  setText('cache-line-detail', `${groupCount} 组 × ${data.config.ways} 路`);
  setText('cache-misses', data.stats.misses);
  setText('cache-miss-detail', `共 ${data.stats.accesses} 次访问 · ${data.config.policy}`);
  setText('cache-order-note', data.config.policy === 'LRU' ? '组内：最久未用 → 最近使用' : '组内：最早进入 → 最近进入');
  renderClassification(data.classification);
  renderCacheTrace(data.steps);
  selectCacheStep(state.cacheIndex, false);
}

function renderClassification(classification) {
  const container = byId('cache-classification');
  container.replaceChildren();
  setText('cache-classification-tag', classification === null ? 'FIFO' : 'LRU · 3C');
  if (classification === null) {
    container.append(element('p', 'explanation', 'FIFO 的替换顺序不满足这里使用的 LRU 3C 分类条件，因此只比较命中与未命中，不显示 3C 数量。'));
    return;
  }
  const categories = [['compulsory', '强制未命中'], ['capacity', '容量未命中'], ['conflict', '冲突未命中']];
  const total = categories.reduce((sum, [key]) => sum + classification[key], 0);
  const bar = element('div', 'classification-bar');
  bar.setAttribute('aria-hidden', 'true');
  const legend = element('div', 'classification-legend');
  for (const [key, label] of categories) {
    const segment = element('span', `classification-segment ${key}`);
    segment.style.width = `${total === 0 ? 0 : classification[key] / total * 100}%`;
    bar.append(segment);
    const item = element('div', 'classification-item');
    const name = element('span');
    const dot = element('i', `legend-dot ${key}`);
    dot.setAttribute('aria-hidden', 'true');
    name.append(dot, document.createTextNode(label));
    item.append(name, element('strong', '', classification[key]));
    legend.append(item);
  }
  container.append(bar, legend);
}

function renderCacheTrace(steps) {
  const rows = steps.map((step, index) => {
    const row = element('tr');
    const badge = element('span', `table-badge ${step.hit ? 'hit' : 'miss'}`, step.hit ? '命中' : '未命中');
    row.append(
      tableCell(traceButton(step.step, () => selectCacheStep(index))), tableCell(hex(step.address)),
      tableCell(step.block), tableCell(`${step.set} / ${step.tag}`), tableCell(badge),
      tableCell(step.evictedBlock === null ? '—' : step.evictedBlock),
    );
    return row;
  });
  byId('cache-trace').replaceChildren(...rows);
}

function selectCacheStep(index, announce = true) {
  state.cacheIndex = index;
  const step = state.cache.steps[index];
  state.cacheGroupPage = Math.floor(step.set / GROUPS_PER_PAGE);
  const description = `第 ${step.step} 次访问，地址 ${hex(step.address)}，${step.hit ? '命中' : '未命中'}`;
  syncReplay('cache', index, state.cache.steps.length, description);
  setText('cache-current-result', step.hit ? 'HIT · 命中' : 'MISS · 未命中');
  byId('cache-current-result').className = `result-badge ${step.hit ? 'hit' : 'miss'}`;
  setText('cache-current-address', hex(step.address));
  setText('cache-current-block', `#${step.block}`);
  setText('cache-current-location', `${step.set} / ${step.tag}`);
  setText('cache-current-eviction', step.evictedBlock === null ? '无替换' : `#${step.evictedBlock}`);
  renderCacheSets();
  renderComparisonStep(index);
  markCurrentRow('cache-trace', index);
  if (announce) setText('live-status', description);
}

function cacheSetCard(blocks, setIndex, step, ways) {
  const card = element('div', `cache-set${setIndex === step.set ? ' is-current' : ''}`);
  const label = element('div', 'set-label');
  label.append(element('span', '', `SET ${String(setIndex).padStart(2, '0')}`));
  const contents = element('div', 'set-blocks');
  for (const block of blocks) {
    const accessed = setIndex === step.set && block === step.block;
    contents.append(element('span', `block-chip${accessed ? ' accessed' : ''}`, `块 ${block}`));
  }
  if (blocks.length < ways) {
    const empty = ways - blocks.length;
    contents.append(element('span', 'block-chip empty', empty === 1 ? '空闲' : `空闲 ×${empty}`));
  }
  card.append(label, contents);
  return card;
}

function renderCacheSets() {
  const step = state.cache.steps[state.cacheIndex];
  const start = state.cacheGroupPage * GROUPS_PER_PAGE;
  const end = Math.min(start + GROUPS_PER_PAGE, step.sets.length);
  const cards = step.sets.slice(start, end).map((blocks, offset) => cacheSetCard(blocks, start + offset, step, state.cache.config.ways));
  byId('cache-sets').replaceChildren(...cards);
  byId('cache-group-pager').hidden = step.sets.length <= GROUPS_PER_PAGE;
  setText('cache-group-range', `${start}–${end - 1} / 共 ${step.sets.length} 组`);
  byId('cache-groups-prev').disabled = start === 0;
  byId('cache-groups-next').disabled = end === step.sets.length;
}

function renderPaging(data) {
  state.paging = data;
  setText('paging-levels', `${data.levels.length} 级`);
  setText('paging-level-detail', `页大小 ${formatBytes(data.pageSize)}`);
  setText('paging-memory', formatBytes(data.totalTableBytes));
  setText('paging-table-detail', `${data.totalTablePages} 张 4 KiB 页表页`);
  setText('paging-mapped', data.mappedPages);
  setText('paging-mapped-detail', '由输入地址的映射集合计算');
  setText('paging-effective-bits', `${data.virtualBits} BIT`);
  setText('paging-bit-note', `图示为低 ${data.virtualBits} 位。更高位需按最高有效位进行符号扩展，形成规范地址。`);
  const options = data.walks.map((walk, index) => {
    const option = element('option', '', `${String(index + 1).padStart(2, '0')} · ${walk.address}`);
    option.value = String(index);
    return option;
  });
  byId('paging-walk-select').replaceChildren(...options);
  renderPageTables(data.tables);
  renderPageWalk(0);
}

function bitField(label, value, highBit, lowBit, offset = false) {
  const field = element('div', `bit-field${offset ? ' offset' : ''}`);
  field.style.flex = String(highBit - lowBit + 1);
  field.append(element('span', 'bit-label', label), element('strong', '', value), element('span', 'bit-range', `${highBit}:${lowBit}`));
  field.setAttribute('aria-label', `${label}，第 ${highBit} 至 ${lowBit} 位，值 ${value}`);
  return field;
}

function renderPageWalk(index) {
  const data = state.paging;
  const walk = data.walks[index];
  setText('paging-address-readout', walk.address);
  const fields = [];
  let highBit = data.virtualBits - 1;
  for (const item of walk.indices) {
    fields.push(bitField(item.level, item.value, highBit, highBit - 8));
    highBit -= 9;
  }
  fields.push(bitField('OFFSET', walk.offset, data.offsetBits - 1, 0, true));
  byId('paging-bit-fields').replaceChildren(...fields);
  const nodes = walk.indices.map((item, levelIndex) => {
    const node = element('div', 'walk-node');
    node.append(element('span', '', `STEP ${String(levelIndex + 1).padStart(2, '0')}`), element('h4', '', item.level), element('p', '', `索引 ${item.value}`));
    return node;
  });
  const dataNode = element('div', 'walk-node data-node');
  dataNode.append(element('span', '', `STEP ${String(nodes.length + 1).padStart(2, '0')}`), element('h4', '', '访问数据'), element('p', '', '页内偏移已确定'));
  const container = byId('paging-walk');
  container.style.setProperty('--walk-columns', String(nodes.length + 1));
  container.replaceChildren(...nodes, dataNode);
  renderAccessEquation(walk);
}

function renderAccessEquation(walk) {
  const equation = byId('paging-accesses');
  const parts = [[walk.tableAccesses, ' 次页表访问'], [walk.totalMemoryAccesses - walk.tableAccesses, ' 次数据访问'], [walk.totalMemoryAccesses, ' 次内存访问']];
  equation.replaceChildren();
  parts.forEach(([count, label], index) => {
    if (index > 0) equation.append(element('span', '', index === 1 ? '+' : '='));
    const part = element('span', 'equation-part');
    part.append(element('strong', '', count), document.createTextNode(label));
    equation.append(part);
  });
}

function renderPageTables(tables) {
  const maximum = Math.max(...tables.map((table) => table.pages));
  const rows = tables.map((table) => {
    const row = element('tr');
    const bar = element('span', 'table-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = element('span');
    fill.style.width = `${table.pages / maximum * 100}%`;
    bar.append(fill);
    row.append(tableCell(table.level), tableCell(table.pages), tableCell(formatBytes(table.bytes)), tableCell(bar));
    return row;
  });
  byId('paging-tables').replaceChildren(...rows);
}

function renderReno(data) {
  state.reno = data;
  state.renoIndex = data.steps.length - 1;
  const last = data.steps.at(-1);
  const timeouts = data.steps.filter((step) => step.event === 'timeout').length;
  const duplicateAcks = data.steps.filter((step) => step.event === 'triple-dup-ack').length;
  setText('reno-final-window', formatNumber(last.cwndAfter));
  setText('reno-final-threshold', formatNumber(last.ssthreshAfter));
  setText('reno-event-count', timeouts + duplicateAcks);
  setText('reno-event-detail', `${duplicateAcks} 次三重 ACK · ${timeouts} 次超时`);
  renderRenoTrace(data.steps);
  renderRenoChart(data);
  selectRenoStep(state.renoIndex, false);
}

function niceTickStep(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  if (fraction <= 1) return magnitude;
  if (fraction <= 2) return 2 * magnitude;
  if (fraction <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function chartGeometry(data) {
  const narrow = mobileChart.matches;
  const width = narrow ? 440 : 880;
  const height = narrow ? 286 : 350;
  const padding = { left: narrow ? 36 : 54, right: 20, top: 30, bottom: 38 };
  const maximum = Math.max(data.initialWindow, data.initialThreshold, ...data.steps.map((step) => Math.max(step.cwndAfter, step.ssthreshAfter)));
  const tickStep = niceTickStep(maximum * 1.1 / 5);
  const ceiling = Math.ceil(maximum * 1.1 / tickStep) * tickStep;
  const x = (round) => padding.left + round / data.roundCount * (width - padding.left - padding.right);
  const y = (value) => height - padding.bottom - value / ceiling * (height - padding.top - padding.bottom);
  return { width, height, padding, tickStep, ceiling, x, y, fontSize: narrow ? 11 : 13, tickCount: narrow ? 5 : 8 };
}

function renderRenoAxes(svg, geometry, roundCount) {
  const { width, height, padding, tickStep, ceiling, x, y, fontSize, tickCount } = geometry;
  for (let value = 0; value <= ceiling; value += tickStep) {
    svg.append(svgElement('line', { x1: padding.left, x2: width - padding.right, y1: y(value), y2: y(value), stroke: '#40513b', 'stroke-width': 1, 'stroke-dasharray': '3 5' }));
    svg.append(svgElement('text', { x: padding.left - 9, y: y(value) + 4, fill: '#9fb091', 'font-size': fontSize, 'text-anchor': 'end' }, formatNumber(value)));
  }
  const tickSpacing = Math.max(1, Math.ceil(roundCount / tickCount));
  const ticks = Array.from({ length: Math.floor(roundCount / tickSpacing) + 1 }, (_, index) => index * tickSpacing);
  if (ticks.at(-1) !== roundCount) ticks.push(roundCount);
  for (const round of ticks) {
    svg.append(svgElement('text', { x: x(round), y: height - 17, fill: '#9fb091', 'font-size': fontSize, 'text-anchor': 'middle' }, round));
  }
  svg.append(svgElement('text', { x: padding.left, y: 14, fill: '#9fb091', 'font-size': fontSize - 1 }, 'MSS'));
  svg.append(svgElement('text', { x: width - padding.right, y: height - 1, fill: '#9fb091', 'font-size': fontSize - 1, 'text-anchor': 'end' }, 'RTT'));
}

function renderRenoLines(svg, data, geometry) {
  const { x, y } = geometry;
  const points = [[0, data.initialWindow], ...data.steps.map((step) => [step.round, step.cwndAfter])];
  const windowPath = points.map(([round, value], index) => `${index === 0 ? 'M' : 'L'}${x(round)},${y(value)}`).join(' ');
  const areaPath = `${windowPath} L${x(data.roundCount)},${y(0)} L${x(0)},${y(0)} Z`;
  let thresholdPath = `M${x(0)},${y(data.initialThreshold)}`;
  for (const step of data.steps) thresholdPath += ` H${x(step.round)} V${y(step.ssthreshAfter)}`;
  svg.append(svgElement('path', { d: areaPath, fill: '#d7ef91', opacity: .075 }));
  svg.append(svgElement('path', { d: thresholdPath, fill: 'none', stroke: '#90b7bf', 'stroke-width': 1.8, 'stroke-dasharray': '6 5', 'stroke-linejoin': 'round' }));
  svg.append(svgElement('path', { d: windowPath, fill: 'none', stroke: '#d7ef91', 'stroke-width': 2.7, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

function renderRenoEvents(svg, data, geometry) {
  const { x, y, padding, fontSize, width } = geometry;
  const events = data.steps.filter((step) => step.event !== null);
  let previousLabelX = -Infinity;
  let staggered = false;
  for (const step of events) {
    const color = step.event === 'timeout' ? '#ec9e84' : '#e4c48c';
    const group = svgElement('g');
    group.append(svgElement('title', {}, `第 ${step.round} 轮 · ${eventName(step.event)} · 窗口 ${formatNumber(step.cwndBefore)} → ${formatNumber(step.cwndAfter)} MSS`));
    group.append(svgElement('line', { x1: x(step.round), x2: x(step.round), y1: padding.top, y2: y(0), stroke: color, opacity: .4, 'stroke-dasharray': '3 5', 'stroke-width': 1 }));
    group.append(svgElement('circle', { cx: x(step.round), cy: y(step.cwndAfter), r: 4.5, fill: color, stroke: '#182522', 'stroke-width': 1.5 }));
    if (events.length <= 6) {
      staggered = x(step.round) - previousLabelX < 65 ? !staggered : false;
      const anchor = x(step.round) > width - 68 ? 'end' : x(step.round) < padding.left + 28 ? 'start' : 'middle';
      group.append(svgElement('text', { x: x(step.round), y: padding.top + (staggered ? 27 : 11), fill: color, 'font-size': fontSize - 1, 'text-anchor': anchor }, step.event === 'timeout' ? '超时' : '3 ACK'));
      previousLabelX = x(step.round);
    }
    svg.append(group);
  }
}

function renderRenoChart(data) {
  renoGeometry = chartGeometry(data);
  const { width, height } = renoGeometry;
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': 'reno-svg-title reno-svg-desc' });
  svg.append(svgElement('title', { id: 'reno-svg-title' }, 'TCP Reno 拥塞窗口与慢启动门限'));
  svg.append(svgElement('desc', { id: 'reno-svg-desc' }, `共 ${data.roundCount} 轮。绿色实线为拥塞窗口，蓝色虚线为门限。每轮的准确数值及事件见下方逐轮轨迹表；也可用滑块逐轮观察。`));
  renderRenoAxes(svg, renoGeometry, data.roundCount);
  renderRenoLines(svg, data, renoGeometry);
  renderRenoEvents(svg, data, renoGeometry);
  svg.append(svgElement('line', { id: 'reno-selection-line', stroke: '#e2edcf', 'stroke-width': 1, opacity: .45, 'stroke-dasharray': '2 4' }));
  svg.append(svgElement('circle', { id: 'reno-selection-dot', r: 5, fill: '#d7ef91', stroke: '#182522', 'stroke-width': 2 }));
  byId('reno-chart').replaceChildren(svg);
}

function renderRenoTrace(steps) {
  const rows = steps.map((step, index) => {
    const row = element('tr');
    row.append(
      tableCell(traceButton(step.round, () => selectRenoStep(index))),
      tableCell(`${formatNumber(step.cwndBefore)} → ${formatNumber(step.cwndAfter)}`),
      tableCell(formatNumber(step.ssthreshAfter)), tableCell(eventName(step.event)), tableCell(phaseName(step.phaseAfter)),
    );
    return row;
  });
  byId('reno-trace').replaceChildren(...rows);
}

function selectRenoStep(index, announce = true) {
  state.renoIndex = index;
  const step = state.reno.steps[index];
  const windowChange = `${formatNumber(step.cwndBefore)} → ${formatNumber(step.cwndAfter)}`;
  const description = `第 ${step.round} 轮，${eventName(step.event)}，拥塞窗口 ${windowChange} MSS`;
  syncReplay('reno', index, state.reno.steps.length, description);
  setText('reno-current-window', windowChange);
  setText('reno-current-threshold', formatNumber(step.ssthreshAfter));
  setText('reno-current-phase', phaseName(step.phaseAfter));
  setText('reno-current-note', `${eventName(step.event)}：本轮由${phaseName(step.phaseBefore)}阶段的 ${formatNumber(step.cwndBefore)} MSS，变化至 ${formatNumber(step.cwndAfter)} MSS。${step.event === 'triple-dup-ack' ? '此处为快速恢复完成后的快照。' : ''}`);
  const { x, y, padding } = renoGeometry;
  const line = byId('reno-selection-line');
  line.setAttribute('x1', x(step.round));
  line.setAttribute('x2', x(step.round));
  line.setAttribute('y1', padding.top);
  line.setAttribute('y2', y(0));
  const dot = byId('reno-selection-dot');
  dot.setAttribute('cx', x(step.round));
  dot.setAttribute('cy', y(step.cwndAfter));
  markCurrentRow('reno-trace', index);
  if (announce) setText('live-status', description);
}

function wireReplay(prefix, getIndex, getLength, select) {
  byId(`${prefix}-step`).addEventListener('input', (event) => select(Number(event.target.value) - 1));
  byId(`${prefix}-prev`).addEventListener('click', () => { if (getIndex() > 0) select(getIndex() - 1); });
  byId(`${prefix}-next`).addEventListener('click', () => { if (getIndex() < getLength() - 1) select(getIndex() + 1); });
}

function applyPreset(values, button, run) {
  for (const [id, value] of Object.entries(values)) byId(id).value = String(value);
  const group = button.closest('.preset-buttons');
  group.querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  run();
}

function wirePresets() {
  byId('cache-compare-preset').addEventListener('click', (event) => applyPreset({
    'cache-size': 64, 'cache-block': 16, 'cache-ways': 4,
    'cache-policy': 'LRU', 'cache-addresses': '0,16,32,48,0,64,0',
  }, event.currentTarget, runCache));
  document.querySelectorAll('[data-cache-preset]').forEach((button) => {
    button.addEventListener('click', () => applyPreset({
      'cache-size': 256, 'cache-block': 16, 'cache-ways': button.dataset.cachePreset === 'direct' ? 1 : 4,
      'cache-policy': 'LRU', 'cache-addresses': '0,256,512,0,256,512,0,256',
    }, button, runCache));
  });
  document.querySelectorAll('[data-paging-preset]').forEach((button) => {
    button.addEventListener('click', () => applyPreset({
      'paging-bits': 48, 'paging-size': 4096,
      'paging-addresses': button.dataset.pagingPreset === 'near' ? '0x0, 0x1000' : '0x0, 0x8000000000',
    }, button, runPaging));
  });
  document.querySelectorAll('[data-reno-preset]').forEach((button) => {
    const loss = button.dataset.renoPreset === 'loss';
    button.addEventListener('click', () => applyPreset({
      'reno-window': 1, 'reno-threshold': 16, 'reno-rounds': 24,
      'reno-duplicate': loss ? '10' : '', 'reno-timeouts': loss ? '20' : '',
    }, button, runReno));
  });
}

function activateTab(name, focus = false, updateHash = true) {
  const tab = byId(`tab-${name}`);
  if (!tab) return;
  for (const item of document.querySelectorAll('[data-tab]')) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    byId(`panel-${item.dataset.tab}`).hidden = !active;
  }
  if (focus) tab.focus();
  if (updateHash && window.location.hash !== `#${name}`) window.history.replaceState(null, '', `#${name}`);
}

function wireTabs() {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const moves = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (!(event.key in moves)) return;
      event.preventDefault();
      activateTab(tabs[moves[event.key]].dataset.tab, true);
    });
  });
  window.addEventListener('hashchange', () => activateTab(window.location.hash.slice(1), false, false));
  const initialTab = window.location.hash.slice(1);
  if (['cache', 'paging', 'reno'].includes(initialTab)) activateTab(initialTab, false, false);
}

function shareError(error) {
  const box = byId('share-error');
  box.textContent = `分享链接未生效：${error.message}`;
  box.hidden = false;
  box.focus();
  console.error('分享链接错误', error);
}

function wireShare() {
  byId('share-button').addEventListener('click', () => {
    byId('share-error').hidden = true;
    byId('share-output').hidden = true;
    const outcomes = [runCache(false), runPaging(false), runReno(false)];
    if (outcomes.includes(false)) {
      const name = ['cache', 'paging', 'reno'][outcomes.indexOf(false)];
      activateTab(name);
      byId(`${name}-error`).focus();
      return;
    }
    const fields = Object.fromEntries(Object.values(FIELDS).flat().map((id) => [id, byId(id).value]));
    const active = document.querySelector('[data-tab][aria-selected="true"]').dataset.tab;
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('experiment', serializeSnapshot(active, fields));
    url.hash = active;
    byId('share-url').value = url.href;
    byId('share-output').hidden = false;
    byId('share-url').focus();
    byId('share-url').select();
    setText('live-status', '完整实验链接已生成，可复制保存。');
  });
}

function restoreSharedExperiment() {
  const params = new URL(window.location.href).searchParams;
  if (!params.has('experiment')) return false;
  try {
    if (params.getAll('experiment').length !== 1) throw new TypeError('实验参数不能重复。');
    const snapshot = deserializeSnapshot(params.get('experiment'));
    for (const [id, value] of Object.entries(snapshot.fields)) byId(id).value = value;
    const outcomes = [runCache(false), runPaging(false), runReno(false)];
    if (outcomes.includes(false)) {
      const name = ['cache', 'paging', 'reno'][outcomes.indexOf(false)];
      activateTab(name);
      byId(`${name}-error`).focus();
      throw new TypeError('链接中的实验参数未通过模型校验，请检查对应错误。');
    }
    activateTab(snapshot.active);
    setText('live-status', '已恢复链接中的全部实验参数和结果。');
  } catch (error) {
    for (const name of Object.keys(FIELDS)) byId(`${name}-results`).hidden = true;
    shareError(error);
  }
  return true;
}

function initialize() {
  for (const [name, run] of [['cache', runCache], ['paging', runPaging], ['reno', runReno]]) {
    byId(`${name}-form`).addEventListener('submit', (event) => { event.preventDefault(); run(); });
    byId(`${name}-form`).addEventListener('input', () => {
      byId(`${name}-form`).closest('.control-panel').querySelectorAll('.preset-buttons button').forEach((button) => button.setAttribute('aria-pressed', 'false'));
    });
  }
  wireTabs();
  wirePresets();
  wireShare();
  wireReplay('cache', () => state.cacheIndex, () => state.cache.steps.length, selectCacheStep);
  wireReplay('reno', () => state.renoIndex, () => state.reno.steps.length, selectRenoStep);
  byId('cache-groups-prev').addEventListener('click', () => { state.cacheGroupPage -= 1; renderCacheSets(); });
  byId('cache-groups-next').addEventListener('click', () => { state.cacheGroupPage += 1; renderCacheSets(); });
  byId('paging-walk-select').addEventListener('change', (event) => {
    renderPageWalk(Number(event.target.value));
    setText('live-status', `已拆解地址 ${state.paging.walks[Number(event.target.value)].address}。`);
  });
  mobileChart.addEventListener('change', () => {
    if (state.reno === null) return;
    renderRenoChart(state.reno);
    selectRenoStep(state.renoIndex, false);
  });
  if (!restoreSharedExperiment()) {
    runCache(false);
    runPaging(false);
    runReno(false);
  }
}

initialize();
