/*
  app.js：data/schedule.json を読み込んで、画面を組み立てるファイルです。
  ・PC幅：SVGでガントチャート風のタイムラインを描きます（データから毎回描くので手書きの図はありません）。
  ・スマホ幅：日付順のカード一覧を描きます。
  ・「受付中・締切未定」欄、絞り込み、Googleカレンダー追加リンク、ライト/ダーク切り替えもここで作ります。
  ・日付はすべて日本時間で計算します。
  日程の更新でこのファイルを触る必要はありません（更新は data/schedule.json だけ）。
*/
(function () {
  "use strict";

  // ===== 設定 =====
  var DATA_URL = "data/schedule.json";
  var CATEGORIES = ["インターン", "本選考", "イベント", "サークル"];
  var CATEGORY_COLOR = {
    "インターン": "var(--cat-intern)",
    "本選考": "var(--cat-main)",
    "イベント": "var(--cat-event)",
    "サークル": "var(--cat-circle)"
  };
  var MONTHS_BEFORE = 1; // 表示範囲の初期値：前月から
  var MONTHS_AFTER = 5;  // 5か月先まで
  var SVG_NS = "http://www.w3.org/2000/svg";

  // ===== 状態 =====
  var data = { updated_at: "", items: [] };
  var state = {
    categories: CATEGORIES.slice(),
    role: "",
    houdiniOnly: false,
    hidePast: false,
    monthOffset: 0,
    selectedId: null
  };
  var now = getNowJST();

  // ===== 日付の道具（日本時間） =====

  // 今の日本時間を { day: 日数, minutes: 0時からの分 } で返す。
  // URLに ?today=2026-11-28 を付けると、その日として表示できる（確認用）。
  function getNowJST() {
    var parts = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    var result = {
      day: toDay(parts.year + "-" + parts.month + "-" + parts.day),
      minutes: Number(parts.hour) * 60 + Number(parts.minute)
    };
    var m = /[?&]today=(\d{4}-\d{2}-\d{2})/.exec(location.search);
    if (m) { result.day = toDay(m[1]); result.minutes = 0; }
    return result;
  }
  // "YYYY-MM-DD" → 1970/1/1 からの日数（時差の影響を受けない整数）
  function toDay(s) {
    if (!s) return null;
    var a = s.split("-").map(Number);
    return Math.round(Date.UTC(a[0], a[1] - 1, a[2]) / 86400000);
  }
  function dayToParts(n) {
    var d = new Date(n * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  function monthStart(y, m) { // m は 1〜12、範囲外でも繰り上げる
    return Math.round(Date.UTC(y, m - 1, 1) / 86400000);
  }
  function toMinutes(t) {
    if (!t) return null;
    var a = t.split(":").map(Number);
    return a[0] * 60 + a[1];
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(n, withYear) {
    var p = dayToParts(n);
    var thisYear = dayToParts(now.day).y;
    return (withYear || p.y !== thisYear ? p.y + "/" : "") + p.m + "/" + p.d;
  }
  function fmtCompact(n) { var p = dayToParts(n); return "" + p.y + pad(p.m) + pad(p.d); }
  var WEEK = ["日", "月", "火", "水", "木", "金", "土"];
  function weekday(n) { return WEEK[new Date(n * 86400000).getUTCDay()]; }

  // ===== 項目ごとの計算 =====

  function startDay(it) { return toDay(it.start); }
  function endDay(it) { return toDay(it.end || it.start); }

  // 締切の日（deadline と span は end、event は対象外）
  function isDeadlineLike(it) { return it.kind === "deadline" || it.kind === "span"; }

  // 締切済み（終了済み）かどうか
  function isPast(it) {
    if (it.kind === "open") return false;
    var e = endDay(it);
    if (e === null) return false;
    if (now.day > e) return true;
    if (now.day === e && isDeadlineLike(it) && it.time) return now.minutes >= toMinutes(it.time);
    return false;
  }

  // 並べ替え用の日付
  function sortKey(it) {
    var d = it.kind === "event" ? startDay(it) : endDay(it);
    return (d === null ? 1e9 : d) * 1440 + (toMinutes(it.time) || 0);
  }

  // 「あと○日」の文言
  function statusText(it) {
    var s = startDay(it), e = endDay(it);
    if (it.kind === "open") return "受付中";
    if (it.kind === "event") {
      if (now.day < s) return "開始まであと" + (s - now.day) + "日";
      if (now.day <= e) return "実施中";
      return "終了";
    }
    if (isPast(it)) return it.kind === "span" ? "受付終了" : "締切済み";
    if (it.kind === "span" && now.day < s) return "受付開始まであと" + (s - now.day) + "日";
    var left = e - now.day;
    return left === 0 ? "今日締切" : "締切まであと" + left + "日";
  }

  // 日付の表示文言（カード用）
  function dateText(it) {
    var s = startDay(it), e = endDay(it);
    var t = it.time ? " " + it.time : "";
    if (it.kind === "open") return s !== null ? fmt(s, true) + "（" + weekday(s) + "）〜 受付中・締切未定" : "受付中・締切未定";
    if (it.kind === "deadline") return fmt(e, true) + "（" + weekday(e) + "）" + t + (it.time ? " 締切" : "");
    var range = fmt(s, true) + "（" + weekday(s) + "）〜 " + fmt(e, true) + "（" + weekday(e) + "）";
    return range + (it.kind === "span" && it.time ? "　締切 " + it.time : "");
  }

  // タイムラインの横に添える短い日付
  // （年は上の目盛りで分かるので省く。表示範囲の外を指すときは withYear=true で年を付ける）
  function shortDate(it, withYear) {
    var s = startDay(it), e = endDay(it);
    function f(n) { if (withYear) return fmt(n, true); var p = dayToParts(n); return p.m + "/" + p.d; }
    if (it.kind === "deadline") return f(e) + (it.time ? " " + it.time : "");
    if (s === e) return f(s);
    return f(s) + "〜" + f(e) + (it.kind === "span" && it.time ? " " + it.time : "");
  }

  // Googleカレンダーに追加するURL（APIは使わず、URLテンプレートだけ）
  function gcalUrl(it) {
    var s = startDay(it), e = endDay(it), dates;
    if (it.kind === "deadline" && it.time) {
      var m = toMinutes(it.time), m2 = m + 30;
      var d2 = e + Math.floor(m2 / 1440); m2 = m2 % 1440;
      dates = fmtCompact(e) + "T" + pad(Math.floor(m / 60)) + pad(m % 60) + "00/" +
              fmtCompact(d2) + "T" + pad(Math.floor(m2 / 60)) + pad(m2 % 60) + "00";
    } else if (it.kind === "open") {
      var d = (s !== null && s > now.day) ? s : now.day;
      dates = fmtCompact(d) + "/" + fmtCompact(d + 1);
    } else {
      dates = fmtCompact(s) + "/" + fmtCompact(e + 1); // 終日（終了日の翌日まで）
    }
    var details = [
      it.company + "：" + it.title,
      "日程：" + dateText(it),
      it.roles && it.roles.length ? "対象職種：" + it.roles.join("、") : "",
      it.note ? "補足：" + it.note : "",
      it.confidence !== "確定" ? "※" + it.confidence : "",
      "公式：" + it.url
    ].filter(Boolean).join("\n");
    return "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=" + encodeURIComponent("【" + it.company + "】" + it.title) +
      "&dates=" + dates +
      "&details=" + encodeURIComponent(details) +
      "&ctz=Asia/Tokyo";
  }

  // ===== 絞り込み =====

  function filteredItems() {
    return data.items.filter(function (it) {
      if (state.categories.indexOf(it.category) < 0) return false;
      if (state.role && (it.roles || []).indexOf(state.role) < 0) return false;
      if (state.houdiniOnly && !it.houdini) return false;
      if (state.hidePast && isPast(it)) return false;
      return true;
    });
  }

  // 次に来る締切1件
  function findNext(items) {
    var c = items.filter(function (it) { return isDeadlineLike(it) && !isPast(it); });
    c.sort(function (a, b) { return sortKey(a) - sortKey(b); });
    return c[0] || null;
  }

  // ===== 画面の組み立て =====

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function svg(tag, attrs, text) {
    var e = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // カード1枚
  function makeCard(it, next) {
    var card = el("article", { "class": "card" });
    card.style.setProperty("--cat", CATEGORY_COLOR[it.category] || "var(--border)");
    if (isPast(it)) card.classList.add("past");
    if (next && next.id === it.id) card.classList.add("is-next");

    var top = el("div", { "class": "card-top" });
    top.appendChild(el("span", { "class": "card-company" }, it.company));
    top.appendChild(el("span", { "class": "days" }, (next && next.id === it.id ? "次の締切・" : "") + statusText(it)));
    card.appendChild(top);
    card.appendChild(el("h3", { "class": "card-title" }, it.title));
    card.appendChild(el("p", { "class": "card-date" }, dateText(it)));
    if (it.confidence && it.confidence !== "確定") card.appendChild(el("span", { "class": "warn" }, "⚠ " + it.confidence));

    var tags = el("ul", { "class": "tags" });
    var cat = el("li", { "class": "tag cat" }, it.category);
    cat.style.setProperty("--cat", CATEGORY_COLOR[it.category] || "var(--muted)");
    tags.appendChild(cat);
    (it.roles || []).forEach(function (r) { tags.appendChild(el("li", { "class": "tag" }, r)); });
    if (it.houdini) tags.appendChild(el("li", { "class": "tag houdini" }, "Houdini明示"));
    card.appendChild(tags);

    if (it.note) card.appendChild(el("p", { "class": "note" }, it.note));

    var links = el("div", { "class": "links" });
    links.appendChild(el("a", { href: it.url, target: "_blank", rel: "noopener" }, "公式ページ ↗"));
    links.appendChild(el("a", { href: gcalUrl(it), target: "_blank", rel: "noopener" }, "Googleカレンダーに追加"));
    if (it.source && it.source !== it.url) links.appendChild(el("a", { href: it.source, target: "_blank", rel: "noopener" }, "確認元 ↗"));
    card.appendChild(links);
    if (it.checked_at) card.appendChild(el("p", { "class": "checked" }, "最終確認：" + it.checked_at.replace(/-/g, "/")));
    return card;
  }

  // 表示範囲（日数）
  function currentRange() {
    var p = dayToParts(now.day);
    var from = monthStart(p.y, p.m - MONTHS_BEFORE + state.monthOffset);
    var to = monthStart(p.y, p.m + MONTHS_AFTER + 1 + state.monthOffset); // この日の前日まで
    return { from: from, to: to };
  }

  // 文字幅のざっくり見積もり（全角=1、半角=0.6）
  function textWidth(s, size) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) < 256 ? 0.6 : 1;
    return w * size;
  }
  function fitText(s, size, maxW) {
    if (textWidth(s, size) <= maxW) return s;
    while (s.length > 1 && textWidth(s + "…", size) > maxW) s = s.slice(0, -1);
    return s + "…";
  }

  // タイムライン（SVG）
  function drawTimeline(items, next) {
    var box = document.getElementById("timeline");
    box.innerHTML = "";
    var width = box.clientWidth;
    if (!width) return; // スマホ幅で隠れているときは描かない

    var rows = items.filter(function (it) { return it.kind !== "open"; });
    rows.sort(function (a, b) { return (startDay(a) - startDay(b)) || (sortKey(a) - sortKey(b)); });
    if (!rows.length) { box.appendChild(el("p", { "class": "empty" }, "条件に合う項目はありません。")); return; }

    var range = currentRange();
    var labelW = Math.min(300, Math.max(200, width * 0.28));
    var padR = 16, headH = 56, rowH = 46;
    var x0 = labelW, x1 = width - padR;
    var dayW = (x1 - x0) / (range.to - range.from);
    var height = headH + rows.length * rowH + 8;
    function xOf(day) { return x0 + (day - range.from) * dayW; }

    var root = svg("svg", { viewBox: "0 0 " + width + " " + height, width: width, height: height, role: "img", "aria-label": "締切・日程のタイムライン" });
    root.style.fontFamily = "inherit";

    // 月の目盛り
    var p = dayToParts(range.from);
    for (var i = 0; ; i++) {
      var ms = monthStart(p.y, p.m + i);
      if (ms >= range.to) break;
      var me = monthStart(p.y, p.m + i + 1);
      var mp = dayToParts(ms);
      var shade = i % 2 === 0;
      if (shade) root.appendChild(svg("rect", { x: xOf(ms), y: headH, width: (me - ms) * dayW, height: height - headH, fill: "var(--surface-2)", opacity: 0.45 }));
      root.appendChild(svg("line", { x1: xOf(ms), x2: xOf(ms), y1: 0, y2: height, stroke: "var(--grid)" }));
      var label = (i === 0 || mp.m === 1 ? mp.y + "年" : "") + mp.m + "月";
      root.appendChild(svg("text", { x: xOf(ms) + (me - ms) * dayW / 2, y: 24, "text-anchor": "middle", "font-size": 13, "font-weight": 700, fill: "var(--text)" }, label));
    }
    root.appendChild(svg("line", { x1: 0, x2: width, y1: headH, y2: headH, stroke: "var(--border)" }));
    root.appendChild(svg("line", { x1: x0, x2: x0, y1: 0, y2: height, stroke: "var(--border)" }));
    root.appendChild(svg("text", { x: 14, y: 32, "font-size": 12, fill: "var(--muted)" }, "会社・項目"));

    // 行
    rows.forEach(function (it, idx) {
      var y = headH + idx * rowH, cy = y + rowH / 2;
      var past = isPast(it), isNext = next && next.id === it.id;
      var color = isNext ? "var(--accent)" : (CATEGORY_COLOR[it.category] || "var(--muted)");
      var g = svg("g", { "class": "row" + (past ? " past" : "") + (state.selectedId === it.id ? " selected" : ""), tabindex: 0, "data-id": it.id });
      g.appendChild(svg("title", null, it.company + " " + it.title + "（" + dateText(it) + "）"));
      g.appendChild(svg("rect", { "class": "row-bg", x: 0, y: y, width: width, height: rowH, fill: "transparent" }));
      g.appendChild(svg("line", { x1: 0, x2: width, y1: y + rowH, y2: y + rowH, stroke: "var(--grid)" }));

      // 左の項目名
      var warn = it.confidence && it.confidence !== "確定";
      g.appendChild(svg("text", { x: 14, y: cy - 4, "font-size": 12, fill: "var(--muted)" }, fitText(it.company, 12, labelW - 24)));
      var t = svg("text", { x: 14, y: cy + 13, "font-size": 13, "font-weight": 700, fill: isNext ? "var(--accent)" : "var(--text)" });
      if (warn) t.appendChild(svg("tspan", { fill: "var(--warn)" }, "⚠ "));
      t.appendChild(svg("tspan", null, fitText(it.title, 13, labelW - 24 - (warn ? 20 : 0))));
      g.appendChild(t);

      // 右の図形
      var s = startDay(it), e = endDay(it);
      var outside = e < range.from || s >= range.to;
      var label = shortDate(it, outside) + (isNext ? "  次の締切" : "");
      var fontSize = 12;
      if (outside) {
        // 表示範囲の外：端に矢印で知らせる
        var left = e < range.from;
        g.appendChild(svg("text", { x: left ? x0 + 6 : x1 - 6, y: cy + 4, "text-anchor": left ? "start" : "end", "font-size": fontSize, fill: "var(--muted)" }, left ? "◀ " + label : label + " ▶"));
      } else {
        var shapeL, shapeR;
        if (it.kind === "deadline") {
          var dx = xOf(e) + dayW / 2, r = 8;
          g.appendChild(svg("path", { d: "M" + dx + " " + (cy - r) + " L" + (dx + r) + " " + cy + " L" + dx + " " + (cy + r) + " L" + (dx - r) + " " + cy + " Z", fill: color, stroke: isNext ? "var(--accent)" : "none", "stroke-width": isNext ? 3 : 0 }));
          shapeL = dx - r; shapeR = dx + r;
        } else {
          var bx = Math.max(xOf(s), x0), bx2 = Math.min(xOf(e + 1), x1);
          var bw = Math.max(bx2 - bx, 4);
          if (it.kind === "span") {
            g.appendChild(svg("rect", { x: bx, y: cy - 8, width: bw, height: 16, rx: 8, fill: color, opacity: isNext ? 1 : 0.85 }));
          } else { // event：枠だけのバー
            g.appendChild(svg("rect", { x: bx, y: cy - 7, width: bw, height: 14, rx: 7, fill: "var(--surface)", stroke: color, "stroke-width": 2, "stroke-dasharray": warn ? "5 3" : "none" }));
          }
          shapeL = bx; shapeR = bx + bw;
        }
        var tw = textWidth(label, fontSize);
        if (shapeR + 8 + tw <= x1) {
          g.appendChild(svg("text", { x: shapeR + 8, y: cy + 4, "font-size": fontSize, fill: isNext ? "var(--accent)" : "var(--text)", "font-weight": isNext ? 700 : 400 }, label));
        } else if (shapeL - 8 - tw >= x0) {
          g.appendChild(svg("text", { x: shapeL - 8, y: cy + 4, "text-anchor": "end", "font-size": fontSize, fill: isNext ? "var(--accent)" : "var(--text)", "font-weight": isNext ? 700 : 400 }, label));
        } else {
          g.appendChild(svg("text", { x: shapeL, y: cy + 21, "font-size": 11, fill: "var(--muted)" }, label));
        }
      }
      root.appendChild(g);
    });

    // 今日の縦線（点線）
    if (now.day >= range.from && now.day < range.to) {
      var tx = xOf(now.day) + dayW * (now.minutes / 1440);
      root.appendChild(svg("line", { x1: tx, x2: tx, y1: headH - 4, y2: height, stroke: "var(--today)", "stroke-width": 1.5, "stroke-dasharray": "4 4" }));
      root.appendChild(svg("text", { x: tx, y: headH - 7, "text-anchor": "middle", "font-size": 11, "font-weight": 700, fill: "var(--today)" }, "今日 " + fmt(now.day)));
    }

    // 行をクリックすると下に詳細カードを出す
    root.addEventListener("click", function (ev) {
      var g = ev.target.closest && ev.target.closest(".row");
      if (g) selectRow(g.getAttribute("data-id"));
    });
    root.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      var g = ev.target.closest && ev.target.closest(".row");
      if (g) { ev.preventDefault(); selectRow(g.getAttribute("data-id")); }
    });
    box.appendChild(root);
  }

  function selectRow(id) {
    state.selectedId = state.selectedId === id ? null : id;
    render();
    if (state.selectedId) {
      var focusRow = document.querySelector('.row[data-id="' + id + '"]');
      if (focusRow) focusRow.focus();
    }
  }

  function drawDetail(items, next) {
    var box = document.getElementById("detail");
    box.innerHTML = "";
    var it = items.filter(function (x) { return x.id === state.selectedId; })[0];
    if (!it) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(makeCard(it, next));
  }

  function drawCards(items, next) {
    var box = document.getElementById("card-list");
    box.innerHTML = "";
    var list = items.filter(function (it) { return it.kind !== "open"; });
    list.sort(function (a, b) { return sortKey(a) - sortKey(b); });
    if (!list.length) { box.appendChild(el("p", { "class": "empty" }, "条件に合う項目はありません。")); return; }
    list.forEach(function (it) { box.appendChild(makeCard(it, next)); });
  }

  function drawOpen(items, next) {
    var box = document.getElementById("open-list");
    box.innerHTML = "";
    var list = items.filter(function (it) { return it.kind === "open"; });
    list.sort(function (a, b) { return (startDay(a) || 0) - (startDay(b) || 0); });
    if (!list.length) { box.appendChild(el("p", { "class": "empty" }, "条件に合う項目はありません。")); return; }
    list.forEach(function (it) { box.appendChild(makeCard(it, next)); });
  }

  function drawHeader(next) {
    document.getElementById("updated-at").textContent = data.updated_at ? data.updated_at.replace(/-/g, "/") : "—";
    var days = document.getElementById("next-days"), what = document.getElementById("next-what");
    if (!next) { days.textContent = "—"; what.textContent = "予定されている締切はありません"; return; }
    var left = endDay(next) - now.day;
    days.textContent = left === 0 ? "今日" : "あと" + left + "日";
    what.textContent = next.company + " " + next.title + "（" + fmt(endDay(next)) + (next.time ? " " + next.time : "") + "）";
  }

  function drawRangeLabel() {
    var r = currentRange();
    var a = dayToParts(r.from), b = dayToParts(r.to - 1);
    document.getElementById("range-label").textContent = a.y + "年" + a.m + "月 〜 " + b.y + "年" + b.m + "月";
  }

  function drawLegend() {
    var ul = document.getElementById("legend");
    ul.innerHTML = "";
    function item(shape, text) {
      var li = el("li");
      var s = svg("svg", { viewBox: "0 0 28 16", "aria-hidden": "true" });
      shape(s);
      li.appendChild(s);
      li.appendChild(document.createTextNode(text));
      ul.appendChild(li);
    }
    item(function (s) { s.appendChild(svg("path", { d: "M14 1 L21 8 L14 15 L7 8 Z", fill: "var(--muted)" })); }, "締切（1日）");
    item(function (s) { s.appendChild(svg("rect", { x: 1, y: 3, width: 26, height: 10, rx: 5, fill: "var(--muted)" })); }, "応募受付期間");
    item(function (s) { s.appendChild(svg("rect", { x: 2, y: 3, width: 24, height: 10, rx: 5, fill: "none", stroke: "var(--muted)", "stroke-width": 2 })); }, "実施期間・イベント");
    item(function (s) { s.appendChild(svg("path", { d: "M14 1 L21 8 L14 15 L7 8 Z", fill: "var(--accent)" })); }, "次の締切");
    item(function (s) { s.appendChild(svg("line", { x1: 14, x2: 14, y1: 0, y2: 16, stroke: "var(--today)", "stroke-width": 1.5, "stroke-dasharray": "3 3" })); }, "今日");
    item(function (s) { s.appendChild(svg("text", { x: 14, y: 13, "text-anchor": "middle", "font-size": 13, fill: "var(--warn)" }, "⚠")); }, "要再確認・前年実績からの推測");
    CATEGORIES.forEach(function (c) {
      item(function (s) { s.appendChild(svg("circle", { cx: 14, cy: 8, r: 5, fill: CATEGORY_COLOR[c] })); }, c);
    });
    item(function (s) { s.appendChild(svg("rect", { x: 1, y: 3, width: 26, height: 10, rx: 5, fill: "var(--muted)", opacity: 0.35 })); }, "締切済み（薄く表示）");
  }

  function render() {
    var items = filteredItems();
    var next = findNext(items);
    drawHeader(next);
    drawRangeLabel();
    drawTimeline(items, next);
    drawDetail(items, next);
    drawCards(items, next);
    drawOpen(items, next);
  }

  // ===== 絞り込みの部品 =====
  function setupFilters() {
    var catBox = document.getElementById("category-filters");
    CATEGORIES.forEach(function (c) {
      var label = el("label", { "class": "chip" });
      var cb = el("input", { type: "checkbox", value: c });
      cb.checked = true;
      cb.addEventListener("change", function () {
        state.categories = Array.prototype.filter.call(catBox.querySelectorAll("input"), function (x) { return x.checked; }).map(function (x) { return x.value; });
        render();
      });
      var dot = el("span", { "class": "dot" });
      dot.style.background = CATEGORY_COLOR[c];
      label.appendChild(cb); label.appendChild(dot); label.appendChild(document.createTextNode(c));
      catBox.appendChild(label);
    });

    var roles = [];
    data.items.forEach(function (it) { (it.roles || []).forEach(function (r) { if (roles.indexOf(r) < 0) roles.push(r); }); });
    var sel = document.getElementById("role-filter");
    roles.forEach(function (r) { sel.appendChild(el("option", { value: r }, r)); });
    sel.addEventListener("change", function () { state.role = sel.value; render(); });

    document.getElementById("houdini-filter").addEventListener("change", function (e) { state.houdiniOnly = e.target.checked; render(); });
    document.getElementById("hide-past").addEventListener("change", function (e) { state.hidePast = e.target.checked; render(); });
    document.getElementById("prev-btn").addEventListener("click", function () { state.monthOffset--; render(); });
    document.getElementById("next-btn").addEventListener("click", function () { state.monthOffset++; render(); });
    document.getElementById("today-btn").addEventListener("click", function () { state.monthOffset = 0; render(); });
  }

  // ===== ライト/ダーク切り替え（自動 → ライト → ダーク） =====
  function setupTheme() {
    var btn = document.getElementById("theme-btn");
    var names = { auto: "自動", light: "ライト", dark: "ダーク" };
    var mode = "auto";
    try { mode = localStorage.getItem("theme") || "auto"; } catch (e) { /* 保存できない環境では自動のまま */ }
    function apply() {
      if (mode === "auto") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", mode);
      btn.textContent = "表示：" + names[mode];
    }
    btn.addEventListener("click", function () {
      mode = mode === "auto" ? "light" : mode === "light" ? "dark" : "auto";
      try { localStorage.setItem("theme", mode); } catch (e) { /* 無視 */ }
      apply();
    });
    apply();
  }

  function showMessage(text) {
    var m = document.getElementById("message");
    m.textContent = text;
    m.hidden = false;
  }

  // ===== 起動 =====
  setupTheme();
  drawLegend();
  fetch(DATA_URL, { cache: "no-cache" })
    .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
    .then(function (json) {
      data = json;
      data.items = (data.items || []).filter(function (it) { return it && it.id; });
      setupFilters();
      render();
      var timer;
      window.addEventListener("resize", function () { clearTimeout(timer); timer = setTimeout(render, 150); });
    })
    .catch(function (err) {
      showMessage("データ（data/schedule.json）を読み込めませんでした。ファイルを直接ダブルクリックで開いた場合は、README の「ローカルでの確認方法」の手順でサーバーを立てて開いてください。JSONの書き方の誤りでも起こります。（" + err.message + "）");
    });
})();
