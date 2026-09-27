/* 匿名化引擎（纯函数，浏览器与 Node 共用）
 *
 * 规则（优先级从高到低）：
 * 1. 显式框选优先：框选片段占据其字符区间，称呼命中、保留原文例外与之重叠时均让位；
 * 2. 保留原文例外：按原稿字符区间记录，区间内（扣除被显式框选覆盖的部分）原文照录，
 *    并屏蔽与之重叠的所有自动称呼命中；
 * 3. 最长称呼优先：称呼命中之间重叠时，更长者优先，长度相同则位置靠前者优先；
 * 4. 共享称呼裁决：同一称呼被多位人物登记时，只有经 adjudications 裁决给唯一归属人物
 *    的称呼才产生自动命中；未裁决（或裁决已失效）的共享称呼一律不参与自动替换，
 *    不再由人物列表顺序暗中决定代号；
 * 5. 原稿不被改动：仅生成预览文本与双向字符区间映射。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Anonymizer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function validRange(text, s, e) {
    return Number.isInteger(s) && Number.isInteger(e) && e > s && s >= 0 && e <= text.length;
  }

  /**
   * 从 [s,e) 中扣除所有与之重叠的显式框选区间，返回剩余的零到多个子区间。
   * 即：显式框选可以切开并覆盖保留原文例外。
   */
  function subtractClaimed(parts, claimed) {
    claimed.forEach(function (c) {
      var next = [];
      parts.forEach(function (part) {
        if (c[0] >= part[1] || c[1] <= part[0]) {
          next.push(part); // 不相交
          return;
        }
        if (c[0] > part[0]) next.push([part[0], Math.min(c[0], part[1])]);
        if (c[1] < part[1]) next.push([Math.max(c[1], part[0]), part[1]]);
      });
      parts = next;
    });
    return parts;
  }

  /**
   * 统计每个称呼当前登记在哪些人物名下（同一人物重复登记同一称呼只计一次）。
   * 结果保留称呼首次登记的出现顺序（按人物顺序、人物内称呼顺序）。
   *
   * @param {Array} persons [{ id, aliases: [] }]
   * @returns {Object} { [alias]: personId[] }
   */
  function aliasOwners(persons) {
    var owners = {};
    (persons || []).forEach(function (p) {
      (p.aliases || []).forEach(function (alias) {
        if (!alias) return;
        if (!owners[alias]) owners[alias] = [];
        if (owners[alias].indexOf(p.id) === -1) owners[alias].push(p.id);
      });
    });
    return owners;
  }

  /**
   * @param {string} text 原稿
   * @param {Array} persons [{ id, codename, aliases: [] }]
   * @param {Array} selections [{ start, end, personId }] 显式框选（最高优先级）
   * @param {Array} exceptions [{ id, start, end, personId }] 保留原文例外（来源人物）
   * @param {Object} [adjudications] 共享称呼裁决 { [alias]: personId }：
   *   仅当称呼同时登记在多位人物名下且裁决给其中一位时，该称呼才产生自动命中；
   *   未裁决或裁决给非候选人物（已删除 / 已合并）的称呼不参与自动替换。
   *   仅属于一位人物的称呼无需裁决，照常自动命中。
   * @returns {{ preview: string, map: Array }} 预览文本与双向区间映射
   *   map 项: { id, kind:'replace'|'keep', oStart, oEnd, pStart, pEnd,
   *             personId, explicit, exId }
   */
  function anonymize(text, persons, selections, exceptions, adjudications) {
    selections = selections || [];
    exceptions = exceptions || [];
    adjudications = adjudications || {};
    var byId = {};
    persons.forEach(function (p) { byId[p.id] = p; });
    var owners = aliasOwners(persons);

    var claimed = []; // 已被占用的字符区间 [[s,e),...]
    var reps = [];    // 最终替换项
    var keeps = [];   // 最终保留原文项

    // 1) 显式框选优先占位（可覆盖例外）
    selections.forEach(function (s) {
      if (!byId[s.personId]) return;
      if (!validRange(text, s.start, s.end)) return;
      reps.push({ start: s.start, end: s.end, personId: s.personId, explicit: true });
      claimed.push([s.start, s.end]);
    });

    // 2) 保留原文例外：扣除被显式框选覆盖的部分，剩余部分占位并屏蔽称呼命中
    exceptions.forEach(function (x) {
      if (!byId[x.personId]) return;
      if (!validRange(text, x.start, x.end)) return;
      var parts = subtractClaimed([[x.start, x.end]], claimed);
      parts.forEach(function (part) {
        keeps.push({ start: part[0], end: part[1], personId: x.personId, exId: x.id });
        claimed.push(part);
      });
    });

    // 3) 收集所有称呼命中
    //    共享称呼（登记在多位人物名下）必须经裁决归属于唯一候选人物后才产生命中；
    //    未裁决或裁决失效的共享称呼不参与自动替换，不由人物列表顺序暗中决定代号。
    var hits = [];
    persons.forEach(function (p) {
      p.aliases.forEach(function (alias) {
        if (!alias) return;
        var ownerIds = owners[alias] || [p.id];
        if (ownerIds.length > 1 && adjudications[alias] !== p.id) return;
        var i = text.indexOf(alias);
        while (i !== -1) {
          hits.push({ start: i, end: i + alias.length, personId: p.id });
          i = text.indexOf(alias, i + 1);
        }
      });
    });

    // 最长称呼优先；长度相同则位置靠前者优先
    hits.sort(function (a, b) {
      return (b.end - b.start) - (a.end - a.start) || a.start - b.start;
    });

    function overlaps(s, e) {
      return claimed.some(function (c) { return s < c[1] && e > c[0]; });
    }
    hits.forEach(function (h) {
      if (overlaps(h.start, h.end)) return; // 与框选/例外/更长称呼重叠，让位
      h.explicit = false;
      reps.push(h);
      claimed.push([h.start, h.end]);
    });

    // 4) 按原稿顺序生成预览与双向映射（替换项与保留项统一编号，便于双向高亮）
    var items = reps.concat(keeps).sort(function (a, b) { return a.start - b.start; });
    var preview = '';
    var map = [];
    var cursor = 0;
    items.forEach(function (r, idx) {
      var person = byId[r.personId];
      if (!person) return;
      preview += text.slice(cursor, r.start);
      var pStart = preview.length;
      var isKeep = !!r.exId;
      if (isKeep) {
        preview += text.slice(r.start, r.end); // 保留原文：预览照录
      } else {
        preview += '【' + person.codename + '】';
      }
      map.push({
        id: idx,
        kind: isKeep ? 'keep' : 'replace',
        oStart: r.start, oEnd: r.end,
        pStart: pStart, pEnd: preview.length,
        personId: r.personId,
        explicit: !isKeep && !!r.explicit,
        exId: isKeep ? r.exId : null
      });
      cursor = r.end;
    });
    preview += text.slice(cursor);
    return { preview: preview, map: map };
  }

  /**
   * 基于最终匿名映射生成一条引文：取原稿非空半开区间 [start,end) 的「预览投影」。
   *
   * - 未被任何映射覆盖的空隙（未替换段）：只截取落在区间内的原文字符；
   * - kind='keep'（保留原文例外）：只截取与区间相交部分的原文字符；
   * - kind='replace'（替换段，含显式框选与称呼命中）：只要与区间有交集
   *   （哪怕引文边界落在该段内部），就输出一次完整代号「【代号】」，
   *   绝不带入该段区间外的原文；
   * - 多条引文各自独立调用，允许相互重叠。
   *
   * 偏移量一律沿用原稿的字符计数（JS 字符串索引，即 UTF-16 码元），
   * 与框选 / 例外 / 映射表的计数方式一致。
   *
   * @param {string} text 原稿
   * @param {number} start 引文起点（含）
   * @param {number} end 引文终点（不含），要求 0 <= start < end <= text.length
   * @param {Array} persons [{ id, codename }]
   * @param {Array} map anonymize 返回的映射（按 oStart 排序、互不重叠）
   * @returns {string} 引文正文（匿名后）；区间非法时返回空串
   */
  function buildCitation(text, start, end, persons, map) {
    if (!validRange(text, start, end)) return '';
    var byId = {};
    (persons || []).forEach(function (p) { byId[p.id] = p; });
    var out = '';
    var cursor = start;
    (map || []).forEach(function (m) {
      if (m.oEnd <= start || m.oStart >= end) return; // 与引文区间无交集
      if (m.oStart > cursor) out += text.slice(cursor, Math.min(m.oStart, end));
      if (m.kind === 'keep') {
        out += text.slice(Math.max(m.oStart, start), Math.min(m.oEnd, end));
      } else {
        var person = byId[m.personId];
        out += '【' + (person ? person.codename : '') + '】';
      }
      cursor = Math.max(cursor, Math.min(m.oEnd, end));
    });
    if (cursor < end) out += text.slice(cursor, end);
    return out;
  }

  /**
   * 批量同文片段指派：匹配与冲突分类（纯函数，不修改输入）。
   *
   * 匹配规则：按原稿从左到右取互不重叠的完全相同片段（从上一匹配末尾之后继续查找）。
   * 冲突分类（互斥，按优先级归并，三类之和等于匹配总数）：
   *   1. 与既有显式框选重叠 → clashSelections；
   *   2. 否则与保留原文例外重叠 → clashExceptions；
   *   3. 否则 → ok（可处理，确认后新增为显式框选；与称呼命中的重叠不算冲突，
   *      因为显式框选优先级更高，可覆盖称呼命中）。
   *
   * @param {string} text 原稿
   * @param {string} frag 待批量指派的片段（非空）
   * @param {Array} selections 既有显式框选 [{ start, end }]
   * @param {Array} exceptions 保留原文例外 [{ start, end }]
   * @returns {{ total: number, ok: Array<[number,number]>,
   *             clashSelections: number, clashExceptions: number }}
   */
  function planBatchAssign(text, frag, selections, exceptions) {
    var result = { total: 0, ok: [], clashSelections: 0, clashExceptions: 0 };
    if (!frag) return result; // 空片段不匹配（且避免 indexOf('') 死循环）
    selections = selections || [];
    exceptions = exceptions || [];
    var i = text.indexOf(frag);
    while (i !== -1) {
      var s = i, e = i + frag.length;
      result.total++;
      if (selections.some(function (x) { return s < x.end && e > x.start; })) {
        result.clashSelections++;
      } else if (exceptions.some(function (x) { return s < x.end && e > x.start; })) {
        result.clashExceptions++;
      } else {
        result.ok.push([s, e]);
      }
      i = text.indexOf(frag, e); // 互不重叠：从上一匹配末尾继续
    }
    return result;
  }

  // ================= 敏感信息巡检（离线识别，纯函数） =================
  var ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  var ID_CHECK_CODES = '10X98765432'; // 加权和 mod 11 后的校验码（含末位 X）

  // 手机号：1 开头、第二位 3-9 的 11 位数字
  var RE_PHONE = /1[3-9]\d{9}/g;
  // 邮箱：常见本地部分 @ 域名.顶级域
  var RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // 18 位身份证：17 位数字 + 数字或 X
  var RE_IDCARD = /\d{17}[\dXx]/g;

  function isDigitChar(ch) { return ch >= '0' && ch <= '9'; }

  function scanRegex(text, re) {
    var out = [];
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
      if (m.index === re.lastIndex) re.lastIndex++; // 防止零宽匹配死循环
    }
    return out;
  }

  // 校验身份证第 7-14 位出生日期（公历，含闰年）
  function validIdBirth(id) {
    var y = +id.slice(6, 10);
    var mo = +id.slice(10, 12);
    var d = +id.slice(12, 14);
    if (!(y >= 1900 && y <= 2100)) return false;
    if (mo < 1 || mo > 12) return false;
    var days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (mo === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) days[1] = 29;
    return d >= 1 && d <= days[mo - 1];
  }

  // 校验身份证末位（ISO 7064 mod 11-2）
  function validIdChecksum(id) {
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += (+id[i]) * ID_WEIGHTS[i];
    return id[17].toUpperCase() === ID_CHECK_CODES[sum % 11];
  }

  /**
   * 离线识别原稿中的手机号、邮箱与 18 位身份证号（身份证同时校验出生日期与校验位）。
   * 重叠候选去重：身份证号 ＞ 邮箱 ＞ 手机号；同类更长优先，长度相同取位置靠前者。
   *
   * @param {string} text 原稿
   * @returns {Array<{type:'idcard'|'email'|'phone', start:number, end:number, value:string}>}
   */
  function detectSensitive(text) {
    text = text || '';
    var cands = [];

    scanRegex(text, RE_PHONE).forEach(function (c) {
      // 不截取更长数字串中的 11 位（含身份证内部片段，交叉去重时身份证也会优先）
      if (c.start > 0 && isDigitChar(text[c.start - 1])) return;
      if (c.end < text.length && isDigitChar(text[c.end])) return;
      cands.push({ type: 'phone', start: c.start, end: c.end, value: c.value });
    });

    scanRegex(text, RE_EMAIL).forEach(function (c) {
      // 两侧若仍是邮箱合法字符，则只是更长邮箱的一部分
      if (c.start > 0 && /[A-Za-z0-9._%+-]/.test(text[c.start - 1])) return;
      if (c.end < text.length && /[A-Za-z0-9.-]/.test(text[c.end])) return;
      cands.push({ type: 'email', start: c.start, end: c.end, value: c.value });
    });

    scanRegex(text, RE_IDCARD).forEach(function (c) {
      // 不截取更长数字/X 串
      if (c.start > 0 && isDigitChar(text[c.start - 1])) return;
      if (c.end < text.length && (isDigitChar(text[c.end]) || text[c.end] === 'X' || text[c.end] === 'x')) return;
      if (!validIdBirth(c.value) || !validIdChecksum(c.value)) return;
      cands.push({ type: 'idcard', start: c.start, end: c.end, value: c.value.toUpperCase() });
    });

    var RANK = { idcard: 0, email: 1, phone: 2 };
    cands.sort(function (a, b) {
      return RANK[a.type] - RANK[b.type] ||
        (b.end - b.start) - (a.end - b.start) ||
        a.start - b.start;
    });
    var kept = [];
    cands.forEach(function (c) {
      var overlap = kept.some(function (k) { return c.start < k.end && c.end > k.start; });
      if (!overlap) kept.push(c);
    });
    kept.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return kept;
  }

  /**
   * 依据最终匿名映射判定每个候选的状态：
   *   anonymized 已匿名：候选每个字符都被 replace 映射覆盖（预览中不再出现原文）；
   *   kept 保留原文：无字符泄漏，但至少一个字符落在 keep 例外中（用户有意保留）；
   *   leaking 仍泄漏：存在未被任何映射覆盖的字符，原文片段会照录进预览。
   *
   * @param {Array} candidates detectSensitive 的结果
   * @param {Array} map anonymize 返回的映射（按 oStart 排序、互不重叠）
   * @returns {Array} 在每个候选上附加 { status, leakRanges:Array<[number,number]> }
   *   leakRanges 为候选中仍会泄漏（照录）的连续原稿子区间，可直接用于补框选
   */
  function classifyCandidates(candidates, map) {
    map = map || [];
    return (candidates || []).map(function (c) {
      var pos = c.start;
      var hasKeep = false;
      var leakRanges = [];
      for (var i = 0; i < map.length; i++) {
        var m = map[i];
        if (m.oEnd <= c.start) continue;
        if (m.oStart >= c.end) break;
        if (m.oStart > pos) leakRanges.push([pos, Math.min(m.oStart, c.end)]);
        if (m.kind === 'keep') hasKeep = true;
        var b = Math.min(m.oEnd, c.end);
        if (b > pos) pos = b;
      }
      if (pos < c.end) leakRanges.push([pos, c.end]);
      var status = leakRanges.length ? 'leaking' : (hasKeep ? 'kept' : 'anonymized');
      return {
        type: c.type, start: c.start, end: c.end, value: c.value,
        status: status, leakRanges: leakRanges
      };
    });
  }

  // ================= 本地工作包（version=1，纯函数） =================
  // 工作包保存：原稿、人物规则、框选、保留例外、共享称呼裁决、引文与复核确认；
  // 不保存匿名预览、巡检结果与撤销栈（均可由保存内容重算）。
  var WORK_PACK_VERSION = 1;

  /**
   * 由当前工作状态生成工作包对象（version=1），可直接 JSON.stringify 后下载。
   * 人物的 color 等界面派生字段不写入（导入时按列表顺序重新配色）；
   * 复核确认由按键索引的记录展开为数组。
   *
   * @param {Object} state { text, persons, selections, exceptions, rulings,
   *   citations, reviewApprovals }（reviewApprovals 为 key -> {start,end,personId,codename}）
   * @returns {Object} 工作包对象
   */
  function buildWorkPack(state) {
    var approvals = [];
    Object.keys(state.reviewApprovals || {}).forEach(function (k) {
      var a = state.reviewApprovals[k];
      approvals.push({ start: a.start, end: a.end, personId: a.personId, codename: a.codename });
    });
    return {
      version: WORK_PACK_VERSION,
      text: state.text,
      persons: (state.persons || []).map(function (p) {
        return { id: p.id, codename: p.codename, aliases: (p.aliases || []).slice() };
      }),
      selections: (state.selections || []).map(function (s) {
        return { id: s.id, start: s.start, end: s.end, personId: s.personId };
      }),
      exceptions: (state.exceptions || []).map(function (x) {
        return { id: x.id, start: x.start, end: x.end, personId: x.personId };
      }),
      rulings: Object.assign({}, state.rulings || {}),
      citations: (state.citations || []).map(function (c) {
        return { id: c.id, start: c.start, end: c.end };
      }),
      reviewApprovals: approvals
    };
  }

  /**
   * 校验工作包（version=1）。返回错误数组 [{ path, message }]，空数组表示通过；
   * path 为具体字段路径（如 selections[2].end、rulings["老师"]），供导入方逐条提示。
   *
   * 校验项：
   *   1. 版本必须为 1（版本不符时无法按本格式解释其余字段，直接返回）；
   *   2. 各字段类型（text 字符串；persons/selections/exceptions/citations/reviewApprovals
   *      为对象数组；rulings 为对象；id/personId/start/end 为整数；codename/aliases 为字符串）；
   *   3. 各集合（persons/selections/exceptions/citations）内 id 唯一；
   *   4. selections/exceptions 的 personId 必须引用已存在的人物；
   *   5. rulings 的每个键必须是多位人物共有的共享称呼，且裁决值属于该称呼的候选人物；
   *   6. 所有 start/end 为原稿 UTF-16 码元范围内的非空整数半开区间（0 <= start < end <= 原稿长度）。
   *
   * 复核确认是否与当前替换匹配属于恢复阶段的保留/丢弃判定，不在此报错；
   * 未列出的字段一律忽略（前向兼容）。校验失败时调用方不得改动当前工作。
   *
   * @param {*} pack 待校验的工作包（JSON.parse 结果）
   * @returns {Array<{path:string, message:string}>}
   */
  function validateWorkPack(pack) {
    var errors = [];
    function err(path, msg) { errors.push({ path: path, message: msg }); }

    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
      err('$', '工作包必须是 JSON 对象');
      return errors;
    }
    if (pack.version !== WORK_PACK_VERSION) {
      err('version', '必须为 ' + WORK_PACK_VERSION + '（当前工作包格式版本），实际为 ' +
        (pack.version === undefined ? '（缺失）' : JSON.stringify(pack.version)));
      return errors;
    }

    var textOk = typeof pack.text === 'string';
    if (!textOk) err('text', '必须为字符串（原稿全文）');
    var textLen = textOk ? pack.text.length : 0;

    // 区间：原稿 UTF-16 码元范围内的非空整数半开区间 [start, end)
    function checkInterval(path, s, e) {
      var sOk = Number.isInteger(s), eOk = Number.isInteger(e);
      if (!sOk) err(path + '.start', '必须为整数（UTF-16 码元偏移）');
      if (!eOk) err(path + '.end', '必须为整数（UTF-16 码元偏移）');
      if (!sOk || !eOk || !textOk) return;
      if (s < 0) err(path + '.start', '必须 ≥ 0');
      if (e <= s) err(path, '必须为非空半开区间（start < end），实际为 [' + s + ', ' + e + ')');
      else if (e > textLen) {
        err(path + '.end', '超出原稿范围（原稿共 ' + textLen + ' 个 UTF-16 码元，end 最大为 ' + textLen + '）');
      }
    }

    // persons：对象形状 + id 唯一 + codename/aliases 类型
    var persons = pack.persons;
    var personsOk = Array.isArray(persons);
    if (!personsOk) { err('persons', '必须为数组'); persons = []; }
    var personIds = {};
    persons.forEach(function (p, i) {
      var path = 'persons[' + i + ']';
      if (!p || typeof p !== 'object' || Array.isArray(p)) { err(path, '必须为对象'); return; }
      if (!Number.isInteger(p.id)) err(path + '.id', '必须为整数');
      else if (personIds[p.id]) err(path + '.id', '人物 ID 重复：' + p.id);
      else personIds[p.id] = true;
      if (typeof p.codename !== 'string') err(path + '.codename', '必须为字符串（统一代号）');
      if (!Array.isArray(p.aliases)) err(path + '.aliases', '必须为字符串数组（称呼列表）');
      else p.aliases.forEach(function (a, j) {
        if (typeof a !== 'string') err(path + '.aliases[' + j + ']', '称呼必须为字符串');
      });
    });

    function checkPersonRef(path, pid) {
      if (!Number.isInteger(pid)) { err(path, '必须为整数（人物 ID）'); return; }
      if (personsOk && !personIds[pid]) err(path, '引用了不存在的人物 ID：' + pid);
    }

    // 带 id 的集合：对象形状 + id 唯一 + 逐项校验
    function checkIdCollection(name, list, eachItem) {
      if (!Array.isArray(list)) { err(name, '必须为数组'); return; }
      var ids = {};
      list.forEach(function (item, i) {
        var path = name + '[' + i + ']';
        if (!item || typeof item !== 'object' || Array.isArray(item)) { err(path, '必须为对象'); return; }
        if (!Number.isInteger(item.id)) err(path + '.id', '必须为整数');
        else if (ids[item.id]) err(path + '.id', 'ID 重复：' + item.id);
        else ids[item.id] = true;
        eachItem(item, path);
      });
    }

    checkIdCollection('selections', pack.selections, function (s, path) {
      checkInterval(path, s.start, s.end);
      checkPersonRef(path + '.personId', s.personId);
    });
    checkIdCollection('exceptions', pack.exceptions, function (x, path) {
      checkInterval(path, x.start, x.end);
      checkPersonRef(path + '.personId', x.personId);
    });
    checkIdCollection('citations', pack.citations, function (c, path) {
      checkInterval(path, c.start, c.end);
    });

    // 共享称呼裁决：每个裁决必须属于对应共享称呼的候选人物
    var rulings = pack.rulings;
    if (!rulings || typeof rulings !== 'object' || Array.isArray(rulings)) {
      err('rulings', '必须为对象（{ "共享称呼": 归属人物ID }）');
    } else {
      var safePersons = (personsOk ? persons : []).map(function (p) {
        return { id: p && p.id, aliases: Array.isArray(p && p.aliases) ? p.aliases : [] };
      });
      var owners = aliasOwners(safePersons);
      Object.keys(rulings).forEach(function (alias) {
        var pid = rulings[alias];
        var path = 'rulings[' + JSON.stringify(alias) + ']';
        if (!Number.isInteger(pid)) { err(path, '裁决值必须为整数（归属人物 ID）'); return; }
        if (!personsOk) return;
        var ids = owners[alias];
        if (!ids || ids.length < 2) {
          err(path, '「' + alias + '」不是多位人物共有的共享称呼，不能登记裁决');
        } else if (ids.indexOf(pid) === -1) {
          err(path, '人物 ID ' + pid + ' 不属于共享称呼「' + alias + '」的候选人物（候选：' + ids.join('、') + '）');
        }
      });
    }

    // 复核确认：区间 + 人物 ID + 实际代号的类型校验；
    // 与当前替换不匹配的确认在恢复时丢弃，不在此报错
    var approvals = pack.reviewApprovals;
    if (!Array.isArray(approvals)) err('reviewApprovals', '必须为数组');
    else approvals.forEach(function (a, i) {
      var path = 'reviewApprovals[' + i + ']';
      if (!a || typeof a !== 'object' || Array.isArray(a)) { err(path, '必须为对象'); return; }
      checkInterval(path, a.start, a.end);
      if (!Number.isInteger(a.personId)) err(path + '.personId', '必须为整数（人物 ID）');
      if (typeof a.codename !== 'string') err(path + '.codename', '必须为字符串（确认时的实际代号）');
    });

    return errors;
  }

  return {
    anonymize: anonymize,
    aliasOwners: aliasOwners,
    buildCitation: buildCitation,
    planBatchAssign: planBatchAssign,
    detectSensitive: detectSensitive,
    classifyCandidates: classifyCandidates,
    WORK_PACK_VERSION: WORK_PACK_VERSION,
    buildWorkPack: buildWorkPack,
    validateWorkPack: validateWorkPack
  };
});
