import { describe, expect, it } from 'vitest';
import { jcs } from '../src/jcs.js';

describe('JCS 规范序列化(RFC 8785 / D23)', () => {
  it('RFC 8785 数字/字符串/字面量向量', () => {
    const input = JSON.parse(
      String.raw`{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/", "literals": [null, true, false]}`,
    );
    const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;
    expect(jcs(input)).toBe(expected);
  });

  it('键按 UTF-16 码元排序', () => {
    expect(jcs({ '€uro': 1, alpha: 3, Beta: 2 })).toBe('{"Beta":2,"alpha":3,"€uro":1}');
  });

  it('嵌套/数组/安全整数边界', () => {
    expect(jcs({ b: [1, 2, { c: null }], a: 9007199254740991 })).toBe(
      '{"a":9007199254740991,"b":[1,2,{"c":null}]}',
    );
  });

  it('输入键序与空白不影响输出', () => {
    const x = JSON.parse('{"z":1,"a":{"y":2,"x":[3,4]}}');
    const y = JSON.parse('{"a":{"x":[3,4],"y":2},"z":1}');
    expect(jcs(x)).toBe(jcs(y));
  });
});