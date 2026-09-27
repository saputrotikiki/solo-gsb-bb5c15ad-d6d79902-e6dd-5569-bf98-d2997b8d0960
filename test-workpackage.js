/* 工作包模块的 Node 冒烟测试：node test-workpackage.js */
const assert = require('assert');
const WP = require('./public/workpackage.js');
const A = require('./public/anonymize.js');

const text = '张敏：老师您好。'; // UTF-16 长度 8
//                 012 34 5 6 7
const good = {
  version: 1,
  text: text,
  persons: [
    { id: 1, codename: 'A ', aliases: ['张敏', '老师'] },
    { id: 2, codename: 'B', aliases: ['老师'] }
  ],
  selections: [{ id: 1, start: 0, end: 3, personId: 1 }],
  exceptions: [{ id: 9, start: 3, end: 5, personId: 1 }],
  rulings: { '老师': 2 },
  citations: [{ id: 4, start: 0, end: 5 }],
  reviews: [{ start: 0, end: 3, personId: 1, codename: 'A' }]
};
let r = WP.validate(good);
assert.ok(r.ok, () => JSON.stringify(r));
assert.strictEqual(r.pkg.persons[0].codename, 'A'); // trim 归一化
assert.strictEqual(r.pkg.version, 1);
assert.deepStrictEqual(WP.validate({ version: 1, text: 'a' }).pkg.selections, []);

function clone(x) { return JSON.parse(JSON.stringify(x)); }
let d;
function bad(data, pathPart) {
  const res = WP.validate(data);
  assert.ok(!res.ok, 'should fail at ' + pathPart + ' but ok');
  assert.ok(res.path === pathPart || res.path.indexOf(pathPart) === 0,
    'path ' + res.path + ' expected prefix ' + pathPart);
  return res;
}

// 版本
bad(Object.assign(clone(good), { version: 2 }), 'version');
bad(Object.assign(clone(good), { version: '1' }), 'version');
bad({ text: 'x' }, 'version');
// 原稿
bad(Object.assign(clone(good), { text: 123 }), 'text');
bad(Object.assign(clone(good), { text: '   ' }), 'text');
// persons
d = clone(good); d.persons[1].id = 1; bad(d, 'persons[1].id');
d = clone(good); d.persons[0].codename = 1; bad(d, 'persons[0].codename');
d = clone(good); d.persons[0].codename = '  '; bad(d, 'persons[0].codename');
d = clone(good); d.persons[0].aliases = 'x'; bad(d, 'persons[0].aliases');
d = clone(good); d.persons[0].aliases = ['a', 2]; bad(d, 'persons[0].aliases[1]');
d = clone(good); d.persons[0].aliases = [' ']; bad(d, 'persons[0].aliases[0]');
d = clone(good); d.persons = {}; bad(d, 'persons');
d = clone(good); d.persons[0].id = 0; bad(d, 'persons[0].id');
d = clone(good); d.persons.push('x'); bad(d, 'persons[2]');
// selections
d = clone(good); d.selections.push({ id: 1, start: 5, end: 6, personId: 1 }); bad(d, 'selections[1].id');
d = clone(good); d.selections[0].start = 1.5; bad(d, 'selections[0].start');
d = clone(good); d.selections[0].end = 0; bad(d, 'selections[0].end'); // end<=start
d = clone(good); d.selections[0].end = 100; bad(d, 'selections[0].end');
d = clone(good); d.selections[0].start = -1; bad(d, 'selections[0].start');
d = clone(good); d.selections[0].personId = 5; bad(d, 'selections[0].personId');
d = clone(good); d.selections = 'x'; bad(d, 'selections');
// exceptions / citations
d = clone(good); d.exceptions[0].personId = 2; assert.ok(WP.validate(d).ok);
d = clone(good); d.citations[0].end = 8; assert.ok(WP.validate(d).ok);
d = clone(good); d.citations[0].end = 9; bad(d, 'citations[0].end');
d = clone(good); d.citations.push({ id: 4, start: 0, end: 1 }); bad(d, 'citations[1].id');
// rulings
d = clone(good); d.rulings = { '老师': 2 }; assert.ok(WP.validate(d).ok); // 任一候选都合法
d = clone(good);
d.persons.push({ id: 3, codename: 'C', aliases: [] });
d.rulings = { '老师': 3 }; bad(d, 'rulings["老师"]'); // 3 不是候选人物
d = clone(good); d.rulings = { '老师': 5 }; bad(d, 'rulings["老师"]');
d = clone(good); d.rulings = []; bad(d, 'rulings');
d = clone(good); d.rulings = { '张敏': 1 }; bad(d, 'rulings["张敏"]');
d = clone(good); d.rulings = { '不存在的称呼': 1 }; bad(d, 'rulings["不存在的称呼"]');
// reviews
d = clone(good); d.reviews[0].codename = ''; bad(d, 'reviews[0].codename');
d = clone(good); d.reviews[0].start = 4; d.reviews[0].end = 4; bad(d, 'reviews[0].end');
d = clone(good); d.reviews[0].personId = 99; bad(d, 'reviews[0].personId');
// 根
bad('{}', '$');
bad(null, '$');
bad([], '$');

// 校验不修改输入（trim 仅发生在副本上）
assert.strictEqual(good.persons[0].codename, 'A ');

console.log('workpackage validation tests passed');

// ---- 序列化 + 恢复语义 ----
const state = {
  text: text,
  persons: [
    { id: 1, codename: 'A', aliases: ['张敏', '老师'], color: '#fff' },
    { id: 2, codename: 'B', aliases: ['老师'], color: '#000' }
  ],
  selections: [{ id: 1, start: 0, end: 3, personId: 1 }],
  exceptions: [{ id: 9, start: 3, end: 5, personId: 1 }],
  rulings: { '老师': 2 },
  citations: [{ id: 4, start: 0, end: 5 }],
  reviewApprovals: {
    '0:3:1:A': { start: 0, end: 3, personId: 1, codename: 'A' },
    '5:6:2:B': { start: 5, end: 6, personId: 2, codename: 'B' }
  }
};
const pkg = WP.serialize(state);
assert.strictEqual(pkg.version, 1);
assert.strictEqual(pkg.reviews.length, 2);
assert.ok(!('history' in pkg) && !('color' in pkg.persons[0]));
const v = WP.validate(pkg);
assert.ok(v.ok);
const res = A.anonymize(v.pkg.text, v.pkg.persons, v.pkg.selections, v.pkg.exceptions, v.pkg.rulings);
const replaceSegs = res.map.filter(m => m.kind === 'replace');
// 0:3 框选给 A 必然是替换段
assert.ok(replaceSegs.some(m => m.oStart === 0 && m.oEnd === 3 && m.personId === 1),
  JSON.stringify(replaceSegs));
// 老师 3:5 被例外覆盖；裁决给 B 但例外屏蔽命中
assert.ok(res.map.some(m => m.kind === 'keep' && m.oStart === 3 && m.oEnd === 5));
// 位置 5:6（'您'）无替换段：该复核确认恢复时必须丢弃
assert.ok(!replaceSegs.some(m => m.oStart === 5 && m.oEnd === 6));
const cit = A.buildCitation(v.pkg.text, 0, 5, v.pkg.persons, res.map);
assert.strictEqual(cit, '【A】老师', cit); // 框选段输出完整代号；保留例外段截取原文

console.log('restore semantic tests passed');
