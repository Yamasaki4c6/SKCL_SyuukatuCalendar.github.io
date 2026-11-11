/*
  app.js：data/schedule.json を読み込んで、画面を組み立てるファイルです。
  ・タイムラインは「左に会社名、右に週ごとの目盛り」。会社名をタップすると、その会社の締切が1行ずつ開きます。
  ・右側の図（SVG）はデータから毎回描きます。横にスクロール（ドラッグ・スライダー）できます。
  ・締切の行をタップすると、下に詳細（公式ページ・Googleカレンダー追加）が出ます。
  ・日付はすべて日本時間で計算します。
  日程の更新でこのファイルを触る必要はありません（更新は data/schedule.json だけ）。
*/
(function () {
  "use strict";

  // ===== 設定 =====
  var DATA_URL = "data/schedule.json";
  var ROLES = ["デザイン", "TA", "プログラマー"];   // 職種の切り替えボタン
  // 予定の種類（category）と色。data/schedule.json の category はこの中から選ぶ
  var CATEGORY_COLOR = {
    "説明会": "var(--cat-seminar)",
    "インターン": "var(--cat-intern)",
    "早期選考": "var(--cat-early)",
    "本選考": "var(--cat-main)",
    "イベント": "var(--cat-event)",
    "サークル": "var(--cat-circle)"
  };
  var KINDS = ["deadline", "span", "event", "open"];
  var CONFIDENCES = ["確定", "要再確認", "前年実績からの推測"];
  var WEEK_W = 56;        // 1週間の幅（px）。スマホ幅では setWeekWidth() で狭くする
  var HEAD_H = 50;        // 目盛りの高さ
  var COMPANY_H = 48;     // 会社の行の高さ
  var ITEM_H = 56;        // 締切の行の高さ
  var SVG_NS = "http://www.w3.org/2000/svg";

  // ===== 状態 =====
  var data = { updated_at: "", items: [] };
  var state = { roles: ROLES.slice(), hidePast: false, open: {}, selectedId: null };
  var now = getNowJST();
  var firstRender = true;

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
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay() };
  }
  function monthStart(y, m) { return Math.round(Date.UTC(y, m - 1, 1) / 86400000); }
  function mondayOf(n) { return n - ((dayToParts(n).w + 6) % 7); }
  function toMinutes(t) {
    if (!t) return null;
    var a = t.split(":").map(Number);
    return a[0] * 60 + a[1];
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function md(n) { var p = dayToParts(n); return p.m + "/" + p.d; }
  function fmt(n, withYear) {
    var p = dayToParts(n);
    return (withYear || p.y !== dayToParts(now.day).y ? p.y + "/" : "") + p.m + "/" + p.d;
  }
  function fmtCompact(n) { var p = dayToParts(n); return "" + p.y + pad(p.m) + pad(p.d); }
  var WEEK = ["日", "月", "火", "水", "木", "金", "土"];
  function wd(n) { return "（" + WEEK[dayToParts(n).w] + "）"; }

  // ===== 項目ごとの計算 =====
  function startDay(it) { return toDay(it.start); }
  function endDay(it) { return toDay(it.end || it.start); }
  function isDeadlineLike(it) { return it.kind === "deadline" || it.kind === "span"; }
  function isUnsure(it) { return it.confidence && it.confidence !== "確定"; }

  function isPast(it) {
    if (it.kind === "open") return false;
    var e = endDay(it);
    if (e === null) return false;
    if (now.day > e) return true;
    if (now.day === e && isDeadlineLike(it) && it.time) return now.minutes >= toMinutes(it.time);
    return false;
  }
  function sortKey(it) {
    if (it.kind === "open") return 1e12;
    var d = it.kind === "event" ? startDay(it) : endDay(it);
    return d * 1440 + (toMinutes(it.time) || 0);
  }
  function statusText(it) {
    var s = startDay(it), e = endDay(it);
    if (it.kind === "open") return "受付中（締切未定）";
    if (it.kind === "event") {
      if (now.day < s) return "開始まであと" + (s - now.day) + "日";
      return now.day <= e ? "実施中" : "終了";
    }
    if (isPast(it)) return "締切済み";
    if (it.kind === "span" && now.day < s) return "受付開始まであと" + (s - now.day) + "日";
    var left = e - now.day;
    return left === 0 ? "今日締切" : "締切まであと" + left + "日";
  }
  function dateText(it) {
    var s = startDay(it), e = endDay(it), t = it.time ? " " + it.time : "";
    if (it.kind === "open") return s !== null ? fmt(s, true) + wd(s) + "〜 締切未定" : "締切未定";
    if (it.kind === "deadline") return fmt(e, true) + wd(e) + t;
    return fmt(s, true) + wd(s) + " 〜 " + fmt(e, true) + wd(e) + (it.kind === "span" ? t : "");
  }
  function shortDate(it) {
    var s = startDay(it), e = endDay(it);
    if (it.kind === "open") return "受付中";
    if (it.kind === "deadline") return fmt(e) + (it.time ? " " + it.time : "");
    return fmt(s) + "〜" + fmt(e) + (it.kind === "span" && it.time ? " " + it.time : "");
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
      dates = fmtCompact(s) + "/" + fmtCompact(e + 1);
    }
    var details = [
      it.company + "：" + it.title,
      "日程：" + dateText(it),
      it.roles && it.roles.length ? "職種：" + it.roles.join("・") : "",
      it.note ? "補足：" + it.note : "",
      isUnsure(it) ? "※" + it.confidence : "",
      it.url ? "公式：" + it.url : ""
    ].filter(Boolean).join("\n");
    return "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=" + encodeURIComponent("【" + it.company + "】" + it.title) +
      "&dates=" + dates + "&details=" + encodeURIComponent(details) + "&ctz=Asia/Tokyo";
  }

  // ===== 絞り込みと並べ方 =====
  function filteredItems() {
    return data.items.filter(function (it) {
      var roles = it.roles || [];
      if (roles.length && !roles.some(function (r) { return state.roles.indexOf(r) >= 0; })) return false;
      if (state.hidePast && isPast(it)) return false;
      return true;
    });
  }
  function findNext(items) {
    var c = items.filter(function (it) { return isDeadlineLike(it) && !isPast(it); });
    c.sort(function (a, b) { return sortKey(a) - sortKey(b); });
    return c[0] || null;
  }
  // 会社ごとにまとめる。次の締切が近い会社が上、締切済みだけの会社は下
  function groupByCompany(items) {
    var map = {}, list = [];
    items.forEach(function (it) {
      if (!map[it.companyId]) { map[it.companyId] = { name: it.company, items: [] }; list.push(map[it.companyId]); }
      map[it.companyId].items.push(it);
    });
    list.forEach(function (g) {
      g.items.sort(function (a, b) { return sortKey(a) - sortKey(b); });
      var up = g.items.filter(function (it) { return !isPast(it); });
      g.key = up.length ? sortKey(up[0]) : 2e12 + sortKey(g.items[g.items.length - 1]);
      g.allPast = !up.length;
    });
    list.sort(function (a, b) { return a.key - b.key; });
    return list;
  }

  // ===== 部品づくり =====
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

  // 表示する期間：前月の初め〜データの最後の日（と5か月先の遅い方）の2週間後まで
  function chartRange(items) {
    var p = dayToParts(now.day);
    var from = mondayOf(monthStart(p.y, p.m - 1));
    var last = monthStart(p.y, p.m + 6);
    items.forEach(function (it) { var e = endDay(it); if (e !== null && e > last) last = e; });
    var to = mondayOf(last) + 7 * 3;
    return { from: from, to: to };
  }

  // 図形（ひし形・バー）を描く。small=true は会社の行用の小さい版
  function drawMark(g, it, x, cy, range, isNext, small, chartW) {
    var color = isNext ? "var(--accent)" : (CATEGORY_COLOR[it.category] || "var(--muted)");
    var s = startDay(it), e = endDay(it);
    var h = small ? 10 : 16, r = small ? 6 : 8;
    if (it.kind === "deadline") {
      var dx = x(e) + WEEK_W / 14;
      g.appendChild(svg("path", { d: "M" + dx + " " + (cy - r) + "L" + (dx + r) + " " + cy + "L" + dx + " " + (cy + r) + "L" + (dx - r) + " " + cy + "Z", fill: color }));
      return { l: dx - r, r: dx + r };
    }
    if (it.kind === "open") {
      var os = Math.max(s === null ? now.day : s, range.from);
      var solidEnd = Math.max(now.day, os + 1);
      g.appendChild(svg("rect", { x: x(os), y: cy - h / 2, width: x(solidEnd) - x(os), height: h, rx: h / 2, fill: color, opacity: 0.55 }));
      var tail = x(solidEnd) + WEEK_W * 4;
      g.appendChild(svg("line", { x1: x(solidEnd), x2: tail, y1: cy, y2: cy, stroke: color, "stroke-width": h * 0.6, "stroke-dasharray": "3 4", opacity: 0.55 }));
      return { l: x(os), r: tail };
    }
    var bx = x(s), bw = Math.max(x(e + 1) - bx, 6);
    if (it.kind === "span") {
      g.appendChild(svg("rect", { x: bx, y: cy - h / 2, width: bw, height: h, rx: h / 2, fill: color }));
    } else {
      g.appendChild(svg("rect", { x: bx + 1, y: cy - h / 2 + 1, width: bw - 2, height: h - 2, rx: (h - 2) / 2, fill: "none", stroke: color, "stroke-width": 2, "stroke-dasharray": isUnsure(it) ? "5 3" : "none" }));
    }
    return { l: bx, r: bx + bw };
  }

  // ===== タイムライン =====
  function drawChart(items, next) {
    var left = document.getElementById("left-col");
    var area = document.getElementById("chart-area");
    var scroller = document.getElementById("chart-scroll");
    var keepScroll = scroller.scrollLeft;
    left.innerHTML = ""; area.innerHTML = "";

    var groups = groupByCompany(items);
    if (!groups.length) {
      area.appendChild(el("p", { "class": "empty" }, "条件に合う項目はありません。"));
      left.style.display = "none";
      updateSlider();
      return;
    }
    left.style.display = "";

    // 行の一覧（会社の行と、開いている会社の締切の行）
    var rows = [];
    groups.forEach(function (g) {
      rows.push({ type: "company", g: g, h: COMPANY_H });
      if (state.open[g.name]) g.items.forEach(function (it) { rows.push({ type: "item", it: it, h: ITEM_H }); });
    });

    var range = chartRange(data.items);
    var dayW = WEEK_W / 7;
    var width = (range.to - range.from) * dayW;
    var height = HEAD_H + rows.reduce(function (a, r) { return a + r.h; }, 0);
    function x(day) { return (day - range.from) * dayW; }

    // --- 左の列 ---
    left.appendChild(el("div", { "class": "left-head", style: "height:" + HEAD_H + "px" }));
    rows.forEach(function (row) {
      var b;
      if (row.type === "company") {
        var open = !!state.open[row.g.name];
        b = el("button", { type: "button", "class": "left-row company" + (row.g.allPast ? " past" : ""), "aria-expanded": open ? "true" : "false" });
        b.appendChild(el("span", { "class": "arrow", "aria-hidden": "true" }, "▶"));
        b.appendChild(el("span", { "class": "name" }, row.g.name));
        b.addEventListener("click", function () { state.open[row.g.name] = !open; render(); });
      } else {
        var it = row.it;
        b = el("button", { type: "button", "class": "left-row item" + (isPast(it) ? " past" : "") + (next && next.id === it.id ? " is-next" : "") + (state.selectedId === it.id ? " selected" : "") });
        var t = el("span", { "class": "t" });
        if (isUnsure(it)) t.appendChild(el("span", { "class": "w", title: it.confidence }, "⚠ "));
        t.appendChild(document.createTextNode(it.title));
        b.appendChild(t);
        b.appendChild(el("span", { "class": "r" }, (it.roles || []).join("・")));
        b.addEventListener("click", function () { selectItem(it.id); });
      }
      b.style.height = row.h + "px";
      left.appendChild(b);
    });

    // --- 右の図（SVG） ---
    var root = svg("svg", { width: width, height: height, viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": "締切のタイムライン（週ごと）" });

    // 月ごとの薄い色分けと月名
    var p = dayToParts(range.from), i = 0;
    for (;; i++) {
      var ms = monthStart(p.y, p.m + i), me = monthStart(p.y, p.m + i + 1);
      if (ms >= range.to) break;
      var a = Math.max(ms, range.from), b2 = Math.min(me, range.to);
      if (i % 2 === 1) root.appendChild(svg("rect", { x: x(a), y: 0, width: x(b2) - x(a), height: height, fill: "var(--surface-2)", opacity: 0.6 }));
      if (ms >= range.from) root.appendChild(svg("line", { x1: x(ms), x2: x(ms), y1: 0, y2: height, stroke: "var(--border)" }));
      var mp = dayToParts(Math.max(ms, range.from));
      root.appendChild(svg("text", { x: x(a) + 6, y: 18, "font-size": 12, "font-weight": 700, fill: "var(--text)" }, (i === 0 || mp.m === 1 ? mp.y + "年" : "") + mp.m + "月"));
    }
    // 週の目盛り（月曜始まり）
    var thisWeek = mondayOf(now.day);
    for (var w = range.from; w < range.to; w += 7) {
      if (w === thisWeek) root.appendChild(svg("rect", { x: x(w), y: 26, width: WEEK_W, height: HEAD_H - 26, fill: "var(--accent-soft)" }));
      root.appendChild(svg("line", { x1: x(w), x2: x(w), y1: 26, y2: height, stroke: "var(--grid)" }));
      root.appendChild(svg("text", { x: x(w) + 4, y: 42, "font-size": 11, fill: w === thisWeek ? "var(--today)" : "var(--muted)", "font-weight": w === thisWeek ? 700 : 400 }, md(w)));
    }
    root.appendChild(svg("line", { x1: 0, x2: width, y1: HEAD_H - 0.5, y2: HEAD_H - 0.5, stroke: "var(--border)" }));

    // 行
    var y = HEAD_H;
    rows.forEach(function (row) {
      var cy = y + row.h / 2;
      var g = svg("g");
      if (row.type === "company") {
        // 会社の行：閉じているときだけ、その会社の締切をまとめて小さく表示
        if (!state.open[row.g.name]) {
          var upcoming = row.g.items.filter(function (it) { return !isPast(it); })[0];
          row.g.items.forEach(function (it) {
            var mg = svg("g", isPast(it) ? { opacity: 0.35 } : null);
            var box = drawMark(mg, it, x, cy, range, next && next.id === it.id, true, width);
            if (it === upcoming) mg.appendChild(svg("text", { x: box.r + 6, y: cy + 4, "font-size": 11, fill: next && next.id === it.id ? "var(--accent)" : "var(--muted)" }, shortDate(it)));
            g.appendChild(mg);
          });
          if (row.g.allPast) g.setAttribute("opacity", 0.8);
        }
      } else {
        var it = row.it, isNext = next && next.id === it.id;
        g.appendChild(svg("rect", { x: 0, y: y, width: width, height: row.h, fill: state.selectedId === it.id ? "var(--grid)" : "var(--surface-2)", opacity: 0.5 }));
        var ig = svg("g", isPast(it) ? { opacity: 0.4 } : null);
        var box2 = drawMark(ig, it, x, cy, range, isNext, false, width);
        ig.appendChild(svg("text", { x: box2.r + 8, y: cy + 4, "font-size": 12, "font-weight": isNext ? 700 : 400, fill: isNext ? "var(--accent)" : "var(--text)" }, shortDate(it) + (isNext ? "  次の締切" : "")));
        g.appendChild(ig);
        g.style.cursor = "pointer";
        g.addEventListener("click", function () { if (!dragMoved) selectItem(it.id); });
      }
      g.appendChild(svg("line", { x1: 0, x2: width, y1: y + row.h - 0.5, y2: y + row.h - 0.5, stroke: "var(--grid)" }));
      root.appendChild(g);
      y += row.h;
    });

    // 今日の縦線（点線）
    var tx = x(now.day) + dayW * (now.minutes / 1440);
    root.appendChild(svg("line", { x1: tx, x2: tx, y1: 26, y2: height, stroke: "var(--today)", "stroke-width": 1.5, "stroke-dasharray": "4 4" }));

    area.appendChild(root);

    // スクロール位置：初回と「今日へ」は今日の少し前、それ以外はそのまま
    if (firstRender) { scrollToToday(); firstRender = false; }
    else scroller.scrollLeft = keepScroll;
    updateSlider();
  }

  function scrollToToday() {
    var range = chartRange(data.items);
    var scroller = document.getElementById("chart-scroll");
    scroller.scrollLeft = Math.max(0, (mondayOf(now.day) - 14 - range.from) * WEEK_W / 7);
    updateSlider();
  }

  function selectItem(id) {
    state.selectedId = state.selectedId === id ? null : id;
    render();
    var d = document.getElementById("detail");
    if (state.selectedId && d.getBoundingClientRect().top > window.innerHeight - 80) d.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ===== 詳細カード =====
  function drawDetail(items, next) {
    var box = document.getElementById("detail");
    box.innerHTML = "";
    var it = items.filter(function (x) { return x.id === state.selectedId; })[0];
    if (!it) { box.hidden = true; return; }
    box.hidden = false;
    var card = el("article", { "class": "card" + (next && next.id === it.id ? " is-next" : "") });
    card.style.setProperty("--cat", CATEGORY_COLOR[it.category] || "var(--border)");
    var close = el("button", { type: "button", "class": "btn close", "aria-label": "閉じる" }, "×");
    close.addEventListener("click", function () { selectItem(it.id); });
    card.appendChild(close);
    card.appendChild(el("div", { "class": "card-company" }, it.company + "・" + it.category));
    card.appendChild(el("h2", { "class": "card-title" }, it.title));
    card.appendChild(el("p", null, dateText(it)));
    card.appendChild(el("p", { "class": "days" }, statusText(it)));
    if ((it.roles || []).length) card.appendChild(el("p", null, "職種：" + it.roles.join("・")));
    if (isUnsure(it)) card.appendChild(el("p", { "class": "warn" }, "⚠ " + it.confidence));
    if (it.note) card.appendChild(el("p", { "class": "note" }, it.note));
    var links = el("div", { "class": "links" });
    if (it.url) links.appendChild(el("a", { href: it.url, target: "_blank", rel: "noopener" }, "公式ページ ↗"));
    links.appendChild(el("a", { href: gcalUrl(it), target: "_blank", rel: "noopener" }, "Googleカレンダーに追加"));
    card.appendChild(links);
    box.appendChild(card);
  }

  // ===== ヘッダー・一番下のタブ =====
  function drawHeader(next) {
    var box = document.getElementById("next-box");
    box.innerHTML = "";
    if (!next) return;
    var left = endDay(next) - now.day;
    box.appendChild(document.createTextNode("次の締切"));
    box.appendChild(el("strong", null, left === 0 ? "今日" : "あと" + left + "日"));
    box.appendChild(document.createTextNode(next.company + " " + next.title + "（" + fmt(endDay(next)) + (next.time ? " " + next.time : "") + "）"));
  }

  function drawLegend() {
    var ul = document.getElementById("legend");
    function item(shape, text) {
      var li = el("li");
      var s = svg("svg", { viewBox: "0 0 28 16", "aria-hidden": "true" });
      shape(s);
      li.appendChild(s);
      li.appendChild(document.createTextNode(text));
      ul.appendChild(li);
    }
    item(function (s) { s.appendChild(svg("path", { d: "M14 1L21 8L14 15L7 8Z", fill: "var(--muted)" })); }, "締切");
    item(function (s) { s.appendChild(svg("rect", { x: 1, y: 3, width: 26, height: 10, rx: 5, fill: "var(--muted)" })); }, "応募受付期間");
    item(function (s) { s.appendChild(svg("rect", { x: 2, y: 3, width: 24, height: 10, rx: 5, fill: "none", stroke: "var(--muted)", "stroke-width": 2 })); }, "実施期間・イベント");
    item(function (s) { s.appendChild(svg("line", { x1: 1, x2: 27, y1: 8, y2: 8, stroke: "var(--muted)", "stroke-width": 6, "stroke-dasharray": "3 4" })); }, "受付中（締切未定）");
    item(function (s) { s.appendChild(svg("path", { d: "M14 1L21 8L14 15L7 8Z", fill: "var(--accent)" })); }, "次の締切");
    item(function (s) { s.appendChild(svg("line", { x1: 14, x2: 14, y1: 0, y2: 16, stroke: "var(--today)", "stroke-width": 1.5, "stroke-dasharray": "3 3" })); }, "今日");
    Object.keys(CATEGORY_COLOR).forEach(function (c) {
      item(function (s) { s.appendChild(svg("circle", { cx: 14, cy: 8, r: 5, fill: CATEGORY_COLOR[c] })); }, c);
    });
  }

  function setWeekWidth() { WEEK_W = window.matchMedia("(max-width: 760px)").matches ? 44 : 56; }

  function render() {
    setWeekWidth();
    var items = filteredItems();
    var next = findNext(items);
    drawHeader(next);
    drawChart(items, next);
    drawDetail(items, next);
  }

  // ===== 横移動（スライダー・ドラッグ） =====
  var dragMoved = false;
  function updateSlider() {
    var sc = document.getElementById("chart-scroll"), sl = document.getElementById("slider");
    var max = Math.max(0, sc.scrollWidth - sc.clientWidth);
    sl.max = max; sl.value = sc.scrollLeft; sl.hidden = max === 0;
  }
  function setupScroll() {
    var sc = document.getElementById("chart-scroll"), sl = document.getElementById("slider");
    sl.addEventListener("input", function () { sc.scrollLeft = Number(sl.value); });
    sc.addEventListener("scroll", function () { sl.value = sc.scrollLeft; });
    // マウスでつかんで左右に動かす（スマホは指でそのまま動く）
    var startX = 0, startLeft = 0, down = false;
    sc.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "mouse" || e.button !== 0 || e.target.closest(".left-col")) return;
      down = true; dragMoved = false; startX = e.clientX; startLeft = sc.scrollLeft;
    });
    window.addEventListener("pointermove", function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 4) { dragMoved = true; sc.classList.add("dragging"); }
      if (dragMoved) sc.scrollLeft = startLeft - dx;
    });
    window.addEventListener("pointerup", function () {
      if (!down) return;
      down = false; sc.classList.remove("dragging");
      setTimeout(function () { dragMoved = false; }, 0);
    });
    document.getElementById("today-btn").addEventListener("click", scrollToToday);
  }

  // ===== 職種の切り替え・締切済みを隠す =====
  function setupFilters() {
    var box = document.getElementById("role-filters");
    ROLES.forEach(function (r) {
      var b = el("button", { type: "button", "class": "chip", "aria-pressed": "true" }, r);
      b.addEventListener("click", function () {
        var on = b.getAttribute("aria-pressed") === "true";
        b.setAttribute("aria-pressed", on ? "false" : "true");
        state.roles = Array.prototype.filter.call(box.children, function (x) { return x.getAttribute("aria-pressed") === "true"; }).map(function (x) { return x.textContent; });
        render();
      });
      box.appendChild(b);
    });
    document.getElementById("hide-past").addEventListener("change", function (e) { state.hidePast = e.target.checked; render(); });
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

  // ===== データの読み込みとチェック =====
  // companies（会社）と events（予定）をつなぎ、書き間違いがあればその予定だけ外して画面上部に知らせる
  function normalize(json) {
    var problems = [], companies = {}, ids = {}, items = [];
    var dateRe = /^\d{4}-\d{2}-\d{2}$/, timeRe = /^\d{1,2}:\d{2}$/;
    (json.companies || []).forEach(function (c) {
      if (!c || !c.id || !c.name) { problems.push("会社に id か name がない項目があります"); return; }
      if (companies[c.id]) problems.push("会社の id が重複しています：" + c.id);
      companies[c.id] = c;
    });
    (json.events || []).forEach(function (ev, i) {
      var label = (ev && ev.id) || ("events の " + (i + 1) + " 件目");
      var errs = [];
      if (!ev || !ev.id) errs.push("id がない");
      else if (ids[ev.id]) errs.push("id が重複");
      if (!ev || !companies[ev.company]) errs.push("company「" + (ev && ev.company) + "」が companies にない");
      if (ev && KINDS.indexOf(ev.kind) < 0) errs.push("kind「" + ev.kind + "」が不正");
      if (ev && !CATEGORY_COLOR[ev.category]) errs.push("category「" + ev.category + "」が不正");
      if (ev && ev.kind !== "open" && !dateRe.test(ev.start || "")) errs.push("start の日付が不正");
      if (ev && ev.start && !dateRe.test(ev.start)) errs.push("start の日付が不正");
      if (ev && ev.end && !dateRe.test(ev.end)) errs.push("end の日付が不正");
      if (ev && dateRe.test(ev.start || "") && dateRe.test(ev.end || "") && ev.end < ev.start) errs.push("end が start より前");
      if (ev && ev.time && !timeRe.test(ev.time)) errs.push("time の書き方が不正");
      if (ev && ev.confidence && CONFIDENCES.indexOf(ev.confidence) < 0) errs.push("confidence「" + ev.confidence + "」が不正");
      if (errs.length) { problems.push(label + "：" + errs.filter(function (e, k, a) { return a.indexOf(e) === k; }).join("、")); return; }
      ids[ev.id] = true;
      var c = companies[ev.company];
      var it = {};
      Object.keys(ev).forEach(function (k) { it[k] = ev[k]; });
      it.companyId = c.id;
      it.company = c.name;
      it.url = ev.url || c.url || "";
      it.roles = ev.roles || [];
      it.confidence = ev.confidence || "確定";
      items.push(it);
    });
    if (problems.length) {
      var m = document.getElementById("message");
      m.textContent = "data/schedule.json に書き間違いがあり、次の予定を表示していません：" + problems.join(" ／ ");
      m.hidden = false;
      if (window.console) console.warn("schedule.json の問題:", problems);
    }
    return { updated_at: json.updated_at || "", items: items };
  }

  // ===== 起動 =====
  setupTheme();
  drawLegend();
  setupScroll();
  fetch(DATA_URL, { cache: "no-cache" })
    .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
    .then(function (json) {
      data = normalize(json);
      document.getElementById("updated-at").textContent = data.updated_at ? data.updated_at.replace(/-/g, "/") : "—";
      setupFilters();
      render();
      var timer, wasNarrow = WEEK_W;
      window.addEventListener("resize", function () {
        clearTimeout(timer);
        timer = setTimeout(function () { setWeekWidth(); if (WEEK_W !== wasNarrow) { wasNarrow = WEEK_W; render(); scrollToToday(); } else updateSlider(); }, 150);
      });
    })
    .catch(function (err) {
      var m = document.getElementById("message");
      m.textContent = "データ（data/schedule.json）を読み込めませんでした。ファイルを直接開いた場合は README の「ローカルでの確認方法」を見てください。JSONの書き方の誤りでも起こります。（" + err.message + "）";
      m.hidden = false;
    });
})();
