/* 本地工作包：序列化与校验（纯函数，浏览器与 Node 共用）
 *
 * 工作包是编辑状态的离线存档格式（JSON，固定 UTF-8 读写），version: 1。
 * 只保存可重建工作的「事实数据」：
 *   version      固定为 1
 *   text         原稿全文（所有偏移按其 UTF-16 码元长度计数）
 *   persons      人物规则 [{ id, codename, aliases:[非空字符串...] }]
 *   selections   显式框选 [{ id, start, end, personId }]
 *   exceptions    保留原文例外 [{ id, start, end, personId }]
 *   rulings       共享称呼裁决 { [alias]: personId }
 *   citations    引文 [{ id, start, end }]
 *   reviews      复核确认 [{ start, end, personId, codename }]
 *
 * 不保存（恢复后由匿名化引擎重算或直接清空）：
 *   匿名预览文本与区间映射、敏感信息巡检扫描/判级结果、撤销栈、界面筛选状态。
 *
 * 所有区间均为原稿 UTF-16 范围内的非空整数半开区间 [start, end)
 * （0 <= start < end <= text.length，与框选 / 例外 / 引文 / 映射口径一致）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WorkPackage = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function isPosInt(v) {
    return Number.isInteger(v) && v >= 1;
  }

  function typeName(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function fail(path, message) {
    return { ok: false, path: path, message: message };
  }

  // 校验一个区间对象：整数、非空、半开且落在原稿 UTF-16 范围内
  function checkRange(item, basePath, textLen) {
    if (!Number.isInteger(item.start)) {
      return fail(basePath + '.start', '必须是整数偏移（实际类型：' + typeName(item.start) + '）');
    }
    if (item.start < 0) {
      return fail(basePath + '.start', '不能小于 0');
    }
    if (item.start > textLen) {
      return fail(basePath + '.start', '超出原稿长度 ' + textLen);
    }
    if (!Number.isInteger(item.end)) {
      return fail(basePath + '.end', '必须是整数偏移（实际类型：' + typeName(item.end) + '）');
    }
    if (item.end <= item.start) {
      return fail(basePath + '.end', '必须大于 start（非空半开区间 [start, end)）');
    }
    if (item.end > textLen) {
      return fail(basePath + '.end', '超出原稿 UTF-16 长度 ' + textLen + '（end=' + item.end + '）');
    }
    return null;
  }

  function checkPersonRef(item, basePath, personIds) {
    if (!isPosInt(item.personId)) {
      return fail(basePath + '.personId',
        '必须是 ≥1 的人物 ID 整数（实际：' + JSON.stringify(item.personId) + '）');
    }
    if (personIds[item.personId] === undefined) {
      return fail(basePath + '.personId', '引用了不存在的人物 ID：' + item.personId);
    }
    return null;
  }

  // 校验带 id 与区间的集合（selections / exceptions / citations）；错误以 fail 抛出
  function checkIntervalCollection(list, name, textLen, personIds, withPerson) {
    if (!Array.isArray(list)) {
      throw fail(name, '必须是数组（实际类型：' + typeName(list) + '）');
    }
    var seenIds = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var base = name + '[' + i + ']';
      var item = list[i];
      if (!isPlainObject(item)) throw fail(base, '必须是对象（实际类型：' + typeName(item) + '）');
      if (!isPosInt(item.id)) {
        throw fail(base + '.id', '必须是 ≥1 的整数 ID（实际：' + JSON.stringify(item.id) + '）');
      }
      if (seenIds[item.id] !== undefined) {
        throw fail(base + '.id', 'ID ' + item.id + ' 在 ' + name + ' 集合中重复（与 ' +
          name + '[' + seenIds[item.id] + '] 相同）');
      }
      var rErr = checkRange(item, base, textLen);
      if (rErr) throw rErr;
      var rec = { id: item.id, start: item.start, end: item.end };
      if (withPerson) {
        var pErr = checkPersonRef(item, base, personIds);
        if (pErr) throw pErr;
        rec.personId = item.personId;
      }
      seenIds[item.id] = i;
      out.push(rec);
    }
    return out;
  }

  /**
   * 校验并归一化工作包数据（深拷贝、字符串 trim）。
   * @returns {{ok:true, pkg:Object}|{ok:false, path:string, message:string}}
   *   失败时 path 为具体字段路径（如 persons[2].aliases[0]、
   *   rulings["老师"]、selections[3].end），调用方必须保证当前工作不变。
   */
  function validate(data) {
    if (!isPlainObject(data)) {
      return fail('$', '根节点必须是 JSON 对象（实际类型：' + typeName(data) + '）');
    }
    if (data.version === undefined) {
      return fail('version', '缺少 version 字段（当前仅支持 version: 1）');
    }
    if (data.version !== VERSION) {
      return fail('version', '仅支持 version 为数字 1 的工作包（实际：' + JSON.stringify(data.version) + '）');
    }
    if (typeof data.text !== 'string') {
      return fail('text', '必须是字符串原稿（实际类型：' + typeName(data.text) + '）');
    }
    if (!data.text.trim()) {
      return fail('text', '原稿不能为空');
    }
    var textLen = data.text.length;

    var result;
    try {
      // ---- persons ----
      if (data.persons !== undefined && !Array.isArray(data.persons)) {
        throw fail('persons', '必须是数组（实际类型：' + typeName(data.persons) + '）');
      }
      var persons = [];
      var personIds = {};
      (data.persons || []).forEach(function (p0, i) {
        var base = 'persons[' + i + ']';
        if (!isPlainObject(p0)) throw fail(base, '必须是对象（实际类型：' + typeName(p0) + '）');
        if (!isPosInt(p0.id)) {
          throw fail(base + '.id', '必须是 ≥1 的整数 ID（实际：' + JSON.stringify(p0.id) + '）');
        }
        if (personIds[p0.id] !== undefined) {
          throw fail(base + '.id', '人物 ID ' + p0.id + ' 与 persons[' +
            personIds[p0.id] + '] 重复（各集合 ID 必须在本集合内唯一）');
        }
        if (typeof p0.codename !== 'string') {
          throw fail(base + '.codename', '必须是字符串代号（实际类型：' + typeName(p0.codename) + '）');
        }
        var codename = p0.codename.trim();
        if (!codename) throw fail(base + '.codename', '代号不能为空');
        if (!Array.isArray(p0.aliases)) {
          throw fail(base + '.aliases', '必须是字符串数组（实际类型：' + typeName(p0.aliases) + '）');
        }
        var aliases = [];
        p0.aliases.forEach(function (a0, j) {
          if (typeof a0 !== 'string') {
            throw fail(base + '.aliases[' + j + ']',
              '必须是字符串称呼（实际类型：' + typeName(a0) + '）');
          }
          var a = a0.trim();
          if (!a) throw fail(base + '.aliases[' + j + ']', '称呼不能为空字符串');
          aliases.push(a);
        });
        personIds[p0.id] = i;
        persons.push({ id: p0.id, codename: codename, aliases: aliases });
      });

      // ---- selections / exceptions / citations ----
      var selections = checkIntervalCollection(
        data.selections === undefined ? [] : data.selections, 'selections', textLen, personIds, true);
      var exceptions = checkIntervalCollection(
        data.exceptions === undefined ? [] : data.exceptions, 'exceptions', textLen, personIds, true);
      var citations = checkIntervalCollection(
        data.citations === undefined ? [] : data.citations, 'citations', textLen, personIds, false);

      // ---- rulings：仅允许「多位人物共享的称呼 → 其中一位候选人物」 ----
      var rulingsRaw = data.rulings === undefined ? {} : data.rulings;
      if (!isPlainObject(rulingsRaw)) {
        throw fail('rulings', '必须是对象 { "称呼": 人物ID }（实际类型：' +
          typeName(rulingsRaw) + '）');
      }
      var owners = {}; // { [alias]: { [personId]: true } }
      persons.forEach(function (p) {
        p.aliases.forEach(function (a) {
          if (!owners[a]) owners[a] = {};
          owners[a][p.id] = true;
        });
      });
      var rulings = {};
      Object.keys(rulingsRaw).forEach(function (alias) {
        var path = 'rulings[' + JSON.stringify(alias) + ']';
        if (!alias) throw fail(path, '裁决的称呼不能为空');
        var pid = rulingsRaw[alias];
        if (!isPosInt(pid)) {
          throw fail(path, '裁决值必须是 ≥1 的人物 ID 整数（实际：' + JSON.stringify(pid) + '）');
        }
        if (personIds[pid] === undefined) {
          throw fail(path, '裁决给了不存在的人物 ID：' + pid);
        }
        var candidateIds = Object.keys(owners[alias] || {}).map(Number).sort(function (a, b) {
          return a - b;
        });
        if (candidateIds.length < 2) {
          throw fail(path, '称呼 ' + JSON.stringify(alias) +
            ' 并非多位人物共享的称呼（当前登记人物数：' + candidateIds.length +
            '），无需也不接受裁决');
        }
        if (!owners[alias][pid]) {
          throw fail(path, '人物 ' + pid + ' 不是共享称呼 ' + JSON.stringify(alias) +
            ' 的候选人物（候选人物 ID：' + candidateIds.join('、') + '）');
        }
        rulings[alias] = pid;
      });

      // ---- reviews：结构合法即可；是否对应当前替换在恢复时再筛选 ----
      var reviewsRaw = data.reviews === undefined ? [] : data.reviews;
      if (!Array.isArray(reviewsRaw)) {
        throw fail('reviews', '必须是数组（实际类型：' + typeName(reviewsRaw) + '）');
      }
      var reviews = [];
      reviewsRaw.forEach(function (r0, i) {
        var base = 'reviews[' + i + ']';
        if (!isPlainObject(r0)) throw fail(base, '必须是对象（实际类型：' + typeName(r0) + '）');
        var rErr = checkRange(r0, base, textLen);
        if (rErr) throw rErr;
        var pErr2 = checkPersonRef(r0, base, personIds);
        if (pErr2) throw pErr2;
        if (typeof r0.codename !== 'string') {
          throw fail(base + '.codename', '必须是字符串（实际类型：' + typeName(r0.codename) + '）');
        }
        var cn = r0.codename.trim();
        if (!cn) throw fail(base + '.codename', '实际代号文本不能为空');
        reviews.push({ start: r0.start, end: r0.end, personId: r0.personId, codename: cn });
      });

      result = {
        ok: true,
        pkg: {
          version: VERSION,
          text: data.text,
          persons: persons,
          selections: selections,
          exceptions: exceptions,
          rulings: rulings,
          citations: citations,
          reviews: reviews
        }
      };
    } catch (e) {
      if (e && e.ok === false) return e; // 校验错误
      throw e;
    }
    return result;
  }

  /**
   * 从编辑器当前状态序列化工作包（不含预览、巡检结果与撤销栈）。
   * @param {Object} state app.js 的全局 state
   */
  function serialize(state) {
    var reviews = Object.keys(state.reviewApprovals || {}).map(function (k) {
      var a = state.reviewApprovals[k];
      return { start: a.start, end: a.end, personId: a.personId, codename: a.codename };
    });
    return {
      version: VERSION,
      text: state.text,
      persons: (state.persons || []).map(function (p) {
        return { id: p.id, codename: p.codename, aliases: p.aliases.slice() };
      }),
      selections: (state.selections || []).map(function (s) {
        return { id: s.id, start: s.start, end: s.end, personId: s.personId };
      }),
      exceptions: (state.exceptions || []).map(function (x) {
        return { id: x.id, start: x.start, end: x.end, personId: x.personId };
      }),
      rulings: Object.assign({}, state.rulings),
      citations: (state.citations || []).map(function (c) {
        return { id: c.id, start: c.start, end: c.end };
      }),
      reviews: reviews
    };
  }

  return {
    VERSION: VERSION,
    validate: validate,
    serialize: serialize
  };
});
