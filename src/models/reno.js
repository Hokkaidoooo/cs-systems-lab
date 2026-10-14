const MAX_ROUNDS = 1000;
const MIN_THRESHOLD = 2;
const LOSS_EVENTS = new Set(['timeout', 'triple-dup-ack']);

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Reno 参数必须是对象。');
  }
  const { initialWindow, initialThreshold, roundCount } = input;
  for (const [name, value] of Object.entries({ initialWindow, initialThreshold, roundCount })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} 必须是正的安全整数。`);
    }
  }
  if (initialThreshold < MIN_THRESHOLD) {
    throw new RangeError(`initialThreshold 至少为 ${MIN_THRESHOLD} MSS。`);
  }
  if (roundCount > MAX_ROUNDS) {
    throw new RangeError(`roundCount 最多为 ${MAX_ROUNDS}。`);
  }
}

function readEvents(events, roundCount) {
  if (!Array.isArray(events)) {
    throw new TypeError('events 必须是事件数组。');
  }
  const byRound = new Map();
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError(`events[${index}] 必须是事件对象。`);
    }
    const { round, type } = event;
    if (!Number.isSafeInteger(round) || round < 1 || round > roundCount) {
      throw new RangeError(`events[${index}].round 必须在 1 至 ${roundCount} 之间。`);
    }
    if (!LOSS_EVENTS.has(type)) {
      throw new RangeError(`events[${index}].type 只能是 timeout 或 triple-dup-ack。`);
    }
    if (byRound.has(round)) {
      throw new RangeError(`第 ${round} 轮存在重复事件。`);
    }
    byRound.set(round, type);
  }
  return byRound;
}

function phase(window, threshold) {
  return window < threshold ? 'slow-start' : 'congestion-avoidance';
}

function nextState(window, threshold, event) {
  if (event) {
    const nextThreshold = Math.max(Math.floor(window / 2), MIN_THRESHOLD);
    return {
      window: event === 'timeout' ? 1 : nextThreshold,
      threshold: nextThreshold,
    };
  }
  return {
    window: window < threshold ? Math.min(window * 2, threshold) : window + 1,
    threshold,
  };
}

/** 满窗发送、每 RTT 汇总；三次重复 ACK 展示快速恢复完成后的窗口。 */
export function simulateReno(input) {
  validateInput(input);
  const { initialWindow, initialThreshold, roundCount, events = [] } = input;
  const byRound = readEvents(events, roundCount);
  let window = initialWindow;
  let threshold = initialThreshold;
  const steps = [];

  for (let round = 1; round <= roundCount; round += 1) {
    const event = byRound.get(round) ?? null;
    const next = nextState(window, threshold, event);
    if (!Number.isSafeInteger(next.window)) {
      throw new RangeError(`第 ${round} 轮拥塞窗口超过安全整数范围。`);
    }
    steps.push({
      round,
      cwndBefore: window,
      cwndAfter: next.window,
      ssthreshBefore: threshold,
      ssthreshAfter: next.threshold,
      event,
      phaseBefore: phase(window, threshold),
      phaseAfter: phase(next.window, next.threshold),
    });
    window = next.window;
    threshold = next.threshold;
  }

  return { initialWindow, initialThreshold, roundCount, steps };
}
