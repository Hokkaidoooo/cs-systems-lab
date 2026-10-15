import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, serializeSnapshot, deserializeSnapshot } from '../src/share.js';

test('分享完整参数可往返，64 位十六进制文本不经过浮点转换', () => {
  const fields = Object.fromEntries(Object.values(FIELDS).flat().map((key) => [key, '1']));
  fields['paging-addresses'] = '0xffff800000000001, 18446603336221196289';
  for (const active of Object.keys(FIELDS)) {
    assert.deepEqual(deserializeSnapshot(serializeSnapshot(active, fields)), { version: 1, active, fields });
  }
});

test('未知版本、字段缺失、非法结构显式失败', () => {
  for (const value of ['{', 'null', '[]', '{"version":2}', '{"version":1,"active":"cache","fields":{}}']) {
    assert.throws(() => deserializeSnapshot(value));
  }
});
