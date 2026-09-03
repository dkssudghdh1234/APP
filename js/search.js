/* ============================================================
   사도행전의 전도 여정 — 말씀 검색
   data.js(JOURNEYS·PLACES) · acts-text.js(ACTS_TEXT) ·
   people.js(PAUL_PEOPLE) · epistles.js(PAUL_EPISTLES)를 한 색인으로 묶어
   ① 성경 구절 (행 16:9 · 16장 · 27:39-28:10)
   ② 말씀 본문 문구 (마게도냐 사람 하나가 …)
   ③ 지명 · 인물 · 서신 이름
   을 검색하고, 그 본문과 이어진 지도 위 정차지로 데려간다.
   app.js가 노출한 window.ActsMap API를 사용한다.
   ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MAX_VERSE_HITS = 40;   // 본문 문구 검색에서 보여줄 최대 절 수
  const MAX_REF_VERSES = 30;   // 구절 검색에서 펼칠 최대 절 수
  const LAST_CH = 28;

  /* ---------- 유틸 ---------- */
  function escapeHtml(t) {
    return String(t == null ? "" : t)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeReg(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  const squash = (s) => norm(s).replace(/[\s.,·'"()[\]{}!?;:~‘’“”–—-]/g, "");
  const VNO = (c, v) => c * 1000 + v;

  /* 조사를 떼어 낸 형태 — "빌립보에서" → "빌립보".
     1차 검색이 비었을 때만 쓰는 보조 수단이라 다소 거칠어도 된다. */
  const JOSA = /(으로써|으로서|에서는|에게서|으로|에서|에게|께서|부터|까지|처럼|보다|와는|과는|이란|라는|은|는|이|가|을|를|로|의|도|만|과|와|에)$/;
  function stem(t) {
    if (t.length <= 2) return t;
    const m = t.match(JOSA);
    if (m && t.length - m[0].length >= 2) return t.slice(0, t.length - m[0].length);
    return t;
  }

  /* 검색어 강조 — HTML 이스케이프 후 안전하게 감싼다 */
  function mark(text, terms) {
    let html = escapeHtml(text);
    (terms || []).forEach(function (t) {
      if (!t) return;
      try {
        html = html.replace(new RegExp(escapeReg(escapeHtml(t)), "gi"), function (m) {
          return "\u0001" + m + "\u0002";
        });
      } catch (e) { /* noop */ }
    });
    return html.replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
  }

  /* 매칭 지점 주변만 잘라낸 스니펫 */
  function snippet(text, terms, len) {
    const raw = String(text || "");
    const width = len || 92;
    if (!raw) return "";
    let at = -1;
    const low = raw.toLowerCase();
    for (let i = 0; i < (terms || []).length; i++) {
      const p = low.indexOf(terms[i]);
      if (p >= 0 && (at < 0 || p < at)) at = p;
    }
    if (at < 0) return raw.length > width ? raw.slice(0, width) + "…" : raw;
    const from = Math.max(0, at - Math.floor(width / 3));
    const to = Math.min(raw.length, from + width);
    return (from > 0 ? "…" : "") + raw.slice(from, to) + (to < raw.length ? "…" : "");
  }

  /* ---------- 본문 데이터 ---------- */
  const TEXT = (typeof window.ACTS_TEXT !== "undefined") ? window.ACTS_TEXT : null;
  const CH_MAX = {};   // 장별 마지막 절
  if (TEXT) {
    Object.keys(TEXT).forEach(function (c) {
      let m = 0;
      Object.keys(TEXT[c]).forEach(function (v) { if (+v > m) m = +v; });
      CH_MAX[+c] = m;
    });
  }

  /* ---------- 성경 참조 파서 ---------- */
  /* data.js의 ref 문자열 → [[시작절, 끝절] …]
     "행 13:1-3" · "행 8:40; 21:8-9" · "행 27:39-28:10" 형태를 모두 처리 */
  function parseRefField(ref) {
    const out = [];
    let lastCh = 0;
    String(ref || "").replace(/^행\s*/, "").split(";").forEach(function (part) {
      const m = part.trim().match(/^(?:(\d{1,2}):)?(\d{1,3})(?:\s*[-–~]\s*(?:(\d{1,2}):)?(\d{1,3}))?/);
      if (!m) return;
      const c1 = m[1] ? +m[1] : lastCh;
      if (!c1) return;
      const v1 = +m[2];
      const c2 = m[3] ? +m[3] : c1;
      const v2 = m[4] ? +m[4] : v1;
      out.push([VNO(c1, v1), VNO(c2, v2)]);
      lastCh = c2;
    });
    return out;
  }

  /* 사용자 입력 → 참조 범위. 참조로 읽히지 않으면 null(→ 본문 문구 검색) */
  function parseQuery(input) {
    let s = norm(input).replace(/\./g, ":");
    if (!s) return null;

    // 앞에 붙은 책 이름(행 · 사도행전 · acts)은 떼어낸다
    const bm = s.match(/^(사도행전|사도행|사도|행|acts|act)\s*/);
    let hadBook = false;
    if (bm) { s = s.slice(bm[0].length).trim(); hadBook = true; }
    if (!s) return null;
    if (!/^[\d\s:장절–~-]+$/.test(s)) return null;   // 숫자·구분자 외 글자가 있으면 참조가 아니다

    const okCh = (c) => c >= 1 && c <= LAST_CH;
    const clampV = (c, v) => Math.min(Math.max(v, 1), CH_MAX[c] || 999);
    function make(c1, v1, c2, v2, label) {
      return { ranges: [[VNO(c1, v1), VNO(c2, v2)]], label: label, hadBook: hadBook };
    }

    let m;
    // 13-14장 (장 범위)
    m = s.match(/^(\d{1,2})\s*장?\s*[-–~]\s*(\d{1,2})\s*장$/);
    if (m) {
      const a = +m[1], b = +m[2];
      if (okCh(a) && okCh(b) && a <= b)
        return make(a, 1, b, CH_MAX[b] || 999, "사도행전 " + a + "–" + b + "장");
    }
    // 13:2 · 13장 2절 · 13:1-3 · 27:39-28:10
    m = s.match(/^(\d{1,2})\s*(?::|장)\s*(\d{1,3})\s*절?(?:\s*[-–~]\s*(?:(\d{1,2})\s*(?::|장)\s*)?(\d{1,3})\s*절?)?$/);
    if (m) {
      const c1 = +m[1];
      if (!okCh(c1)) return null;
      const v1 = clampV(c1, +m[2]);
      const c2 = m[3] ? +m[3] : c1;
      if (!okCh(c2)) return null;
      const v2 = m[4] ? clampV(c2, +m[4]) : v1;
      if (VNO(c2, v2) < VNO(c1, v1)) return null;
      const label = "사도행전 " + c1 + ":" + v1 +
        (VNO(c2, v2) === VNO(c1, v1) ? "" : (c2 === c1 ? "-" + v2 : "–" + c2 + ":" + v2));
      return make(c1, v1, c2, v2, label);
    }
    // 13장 · (책 이름과 함께라면) 13
    m = s.match(/^(\d{1,2})\s*장?$/);
    if (m) {
      const c = +m[1];
      if (!okCh(c)) return null;
      if (!hadBook && s.indexOf("장") < 0) return null;   // 맨 숫자는 문구 검색으로 넘긴다
      return make(c, 1, c, CH_MAX[c] || 999, "사도행전 " + c + "장");
    }
    return null;
  }

  /* ---------- 색인 ---------- */
  const STOPS = [];
  const PEOPLE = [];
  const EPISTLES = [];

  function buildIndex() {
    if (typeof JOURNEYS === "undefined" || typeof JOURNEY_ORDER === "undefined") return;
    JOURNEY_ORDER.forEach(function (jid, ji) {
      const j = JOURNEYS[jid];
      if (!j) return;
      j.stops.forEach(function (s) {
        const place = (typeof PLACES !== "undefined" && PLACES[s.en]) || null;
        /* 그 정차지에서 실제로 일어난 일만 색인한다.
           여정 전체 요약(j.summary 등)을 넣으면 한 낱말에 그 여정의 모든 정차지가
           딸려 나오므로 제외한다. */
        const parts = [
          s.ko, s.koShort, s.en, s.type, s.event, s.story,
          s.theme && s.theme.title, s.theme && s.theme.text,
          s.companionStory, (s.companions || []).join(" "),
          place && place.region, place && place.modern, place && place.character
        ].filter(Boolean).join(" ");
        const nameStr = s.ko + " " + (s.koShort || "") + " " + (s.en || "");
        STOPS.push({
          jid: jid, ji: ji, j: j, stop: s, n: s.n,
          ko: s.ko, en: s.en || "", ref: s.ref || "",
          ranges: parseRefField(s.ref),
          name: norm(nameStr), nameSq: squash(nameStr),
          body: norm(parts), bodySq: squash(parts), raw: parts
        });
      });
    });

    if (typeof PAUL_PEOPLE !== "undefined") {
      Object.keys(PAUL_PEOPLE).forEach(function (name) {
        const p = PAUL_PEOPLE[name];
        const parts = [name, p.nameEn, p.role, p.bio, p.refs].filter(Boolean).join(" ");
        PEOPLE.push({
          name: name, p: p, key: norm(name + " " + (p.nameEn || "")),
          body: norm(parts), bodySq: squash(parts), raw: parts
        });
      });
    }
    if (typeof PAUL_EPISTLES !== "undefined") {
      Object.keys(PAUL_EPISTLES).forEach(function (book) {
        const e = PAUL_EPISTLES[book];
        const parts = [book, e.nameEn, e.written, e.recipient, e.theme, e.summary, e.keyVerse]
          .filter(Boolean).join(" ");
        EPISTLES.push({
          book: book, e: e, key: norm(book + " " + (e.nameEn || "")),
          body: norm(parts), bodySq: squash(parts), raw: parts
        });
      });
    }
  }

  /* 한 절이 어느 정차지의 본문에 속하는가 */
  function stopsAtVerse(vno) {
    return STOPS.filter(function (it) {
      return it.ranges.some(function (r) { return vno >= r[0] && vno <= r[1]; });
    });
  }
  /* 질의 범위와 겹치는 정차지 */
  function stopsInRanges(ranges) {
    return STOPS.filter(function (it) {
      return it.ranges.some(function (r) {
        return ranges.some(function (q) { return r[0] <= q[1] && q[0] <= r[1]; });
      });
    });
  }
  /* 범위에 속한 절 목록 */
  function versesInRanges(ranges) {
    const out = [];
    if (!TEXT) return out;
    ranges.forEach(function (r) {
      const c1 = Math.floor(r[0] / 1000), c2 = Math.floor(r[1] / 1000);
      for (let c = c1; c <= c2; c++) {
        const ch = TEXT[String(c)];
        if (!ch) continue;
        Object.keys(ch).forEach(function (vs) {
          const vno = VNO(c, +vs);
          if (vno >= r[0] && vno <= r[1]) out.push({ c: c, v: +vs, text: ch[vs], vno: vno });
        });
      }
    });
    out.sort(function (a, b) { return a.vno - b.vno; });
    return out;
  }

  /* ---------- 검색 ---------- */
  function search(raw) {
    const q = String(raw || "").trim();
    const res = { q: q, ref: null, terms: [], verses: [], stops: [], people: [], epistles: [], truncated: 0, loose: false };
    if (!q) return res;

    const ref = parseQuery(q);
    if (ref) {
      res.ref = ref;
      const all = versesInRanges(ref.ranges);
      if (all.length > MAX_REF_VERSES) {
        res.truncated = all.length - MAX_REF_VERSES;
        res.verses = all.slice(0, MAX_REF_VERSES);
      } else {
        res.verses = all;
      }
      res.stops = stopsInRanges(ref.ranges).map(function (it) { return { it: it, score: 100 - it.ji }; });
      return res;
    }

    const terms = norm(q).split(" ").filter(function (t) { return t.length > 0; });
    const stems = terms.map(stem);
    const sq = squash(q);
    res.terms = terms;

    /* 검색어가 몇 개나 걸렸는지 센다.
       lv 0 = 적은 그대로 · lv 1 = 조사를 떼고도 허용 */
    function hits(n, nsq, lv) {
      let c = 0;
      for (let i = 0; i < terms.length; i++) {
        if (n.indexOf(terms[i]) >= 0) { c++; continue; }
        if (lv && stems[i] !== terms[i] && n.indexOf(stems[i]) >= 0) c++;
      }
      if (c < terms.length && sq.length >= 2 && nsq.indexOf(sq) >= 0) c = terms.length;
      return c;
    }
    /* k: 0 = 전부 일치 · 1 = 조사를 떼면 전부 일치 · 2 = 일부만 일치 · -1 = 무관
       h: 걸린 검색어 개수(일부만 일치한 결과를 줄 세울 때 쓴다) */
    function rank(n, nsq) {
      const h0 = hits(n, nsq, 0);
      if (h0 === terms.length) return { k: 0, h: h0 };
      const h1 = hits(n, nsq, 1);
      if (h1 === terms.length) return { k: 1, h: h1 };
      return { k: h1 > 0 ? 2 : -1, h: h1 };
    }

    const B = [
      { verses: [], stops: [], people: [], epistles: [], cut: 0 },
      { verses: [], stops: [], people: [], epistles: [], cut: 0 },
      { verses: [], stops: [], people: [], epistles: [], cut: 0 }
    ];

    // 사도행전 본문 절
    if (TEXT) {
      for (let c = 1; c <= LAST_CH; c++) {
        const ch = TEXT[String(c)];
        if (!ch) continue;
        const vs = Object.keys(ch).sort(function (a, b) { return a - b; });
        for (let i = 0; i < vs.length; i++) {
          const t = ch[vs[i]];
          const r = rank(norm(t), squash(t));
          if (r.k < 0) continue;
          if (B[r.k].verses.length >= MAX_VERSE_HITS) { B[r.k].cut++; continue; }
          B[r.k].verses.push({ c: c, v: +vs[i], text: t, vno: VNO(c, +vs[i]), h: r.h });
        }
      }
    }

    // 정차지 — 지명이 걸린 곳을 위로
    STOPS.forEach(function (it) {
      const r = rank(it.body, it.bodySq);
      if (r.k < 0) return;
      let score = 10 - it.ji * 0.1 + r.h * 5;
      if (rank(it.name, it.nameSq).k === 0) score += 60;
      B[r.k].stops.push({ it: it, score: score });
    });

    // 인물 · 서신
    PEOPLE.forEach(function (o) {
      const r = rank(o.body, o.bodySq);
      if (r.k < 0) return;
      B[r.k].people.push({ o: o, score: r.h * 5 + (o.key.indexOf(terms[0]) >= 0 ? 50 : 10) });
    });
    EPISTLES.forEach(function (o) {
      const r = rank(o.body, o.bodySq);
      if (r.k < 0) return;
      B[r.k].epistles.push({ o: o, score: r.h * 5 + (o.key.indexOf(terms[0]) >= 0 ? 50 : 10) });
    });

    /* 갈래마다 따로 고른다 — 꼭 맞는 결과가 있으면 그것만,
       없으면 조사를 뗀 형태 → 일부만 맞는 결과 순으로 내려간다 */
    function pick(field) {
      for (let k = 0; k < 3; k++) {
        if (B[k][field].length) {
          if (k > 0) res.loose = true;
          if (field === "verses") res.truncated = B[k].cut;
          return B[k][field];
        }
      }
      return [];
    }
    const byScore = function (a, b2) { return b2.score - a.score; };
    res.verses = pick("verses");
    // 일부만 맞은 결과는 많이 맞은 절을 앞에 둔다(완전 일치일 때는 본문 순서 그대로)
    if (res.loose && terms.length > 1) {
      res.verses = res.verses.slice().sort(function (a, b2) { return (b2.h - a.h) || (a.vno - b2.vno); });
    }
    res.stops = pick("stops").sort(byScore);
    res.people = pick("people").sort(byScore);
    res.epistles = pick("epistles").sort(byScore);

    return res;
  }

  /* ---------- 렌더 ---------- */
  const box = $("searchResults");
  const input = $("searchInput");
  const clearBtn = $("searchClear");
  const sidebarBody = $("sidebarBody");

  const JCOLOR = { jp: "#16a34a", j1: "#c0392b", j2: "#1f6feb", j3: "#8e44ad", j4: "#d97706" };
  function colorOf(jid) { return JCOLOR[jid] || "#7b83eb"; }
  function chipOf(jid) {
    const A = window.ActsMap;
    const j = (typeof JOURNEYS !== "undefined") ? JOURNEYS[jid] : null;
    if (!j) return "";
    if (A && A.journeyChip) return A.journeyChip(j);
    return j.label || "";
  }

  function stopBtnHtml(it, terms, vno) {
    const col = colorOf(it.jid);
    const snip = (terms && terms.length) ? snippet(it.raw, terms, 88) : (it.stop.event || "");
    return (
      '<button class="sr-item sr-stop" data-jid="' + it.jid + '" data-n="' + it.n +
      '" data-ref="' + escapeHtml(it.ref) + '"' + (vno ? ' data-vno="' + vno + '"' : "") + ' type="button">' +
      '<span class="sr-line">' +
      '<span class="sr-badge" style="background:' + col + '">' + escapeHtml(chipOf(it.jid)) + "</span>" +
      '<span class="sr-name">' + mark(it.ko, terms) + "</span>" +
      '<span class="sr-ref">' + escapeHtml(it.ref) + "</span></span>" +
      (snip ? '<span class="sr-snip">' + mark(snip, terms) + "</span>" : "") +
      "</button>"
    );
  }

  /* 절 카드 — 절 자체를 눌러도 그 말씀이 일어난 자리로 간다(첫 연결 지점).
     여러 곳에 걸친 절이면 아래 칩으로 곳을 골라 갈 수 있다. */
  function verseHtml(v, terms) {
    const links = stopsAtVerse(v.vno);
    const first = links[0];
    return (
      '<div class="sr-verse' + (first ? " sr-verse--go" : "") + '"' +
      (first ? ' data-jid="' + first.jid + '" data-n="' + first.n +
        '" data-ref="' + escapeHtml(first.ref) + '" data-vno="' + v.vno +
        '" role="button" tabindex="0" title="누르면 이 말씀의 자리로 갑니다"' : "") + ">" +
      '<span class="sr-vno">' + v.c + ":" + v.v + "</span>" +
      '<p class="sr-vtext">' + mark(v.text, terms) + "</p>" +
      (links.length
        ? '<div class="sr-links">' + links.map(function (it) {
            return '<button class="sr-chip" data-jid="' + it.jid + '" data-n="' + it.n +
              '" data-ref="' + escapeHtml(it.ref) + '" data-vno="' + v.vno +
              '" type="button"><i style="background:' + colorOf(it.jid) + '"></i>' +
              escapeHtml(chipOf(it.jid)) + " · " + escapeHtml(it.ko) + "</button>";
          }).join("") + "</div>"
        : "") +
      "</div>"
    );
  }

  function sectionHead(title, count) {
    return '<div class="sr-head">' + escapeHtml(title) +
      (count != null ? ' <span class="sr-count">' + count + "</span>" : "") + "</div>";
  }

  function render(res) {
    if (!box) return;
    const parts = [];
    parts.push(
      '<div class="sr-top"><span class="sr-q">' + escapeHtml(res.q) + "</span>" +
      '<button class="sr-close" id="srClose" type="button" aria-label="검색 결과 닫기">×</button></div>'
    );

    const nothing = !res.verses.length && !res.stops.length && !res.people.length && !res.epistles.length;

    if (res.ref) {
      parts.push(sectionHead(res.ref.label));
      if (res.verses.length) {
        parts.push('<div class="sr-verses">' + res.verses.map(function (v) { return verseHtml(v, []); }).join("") + "</div>");
        if (res.truncated) parts.push('<p class="sr-more">… ' + res.truncated + "절이 더 있습니다. 범위를 좁혀 보세요.</p>");
      } else {
        parts.push('<p class="sr-empty">해당 본문을 찾지 못했습니다.</p>');
      }
      if (res.stops.length) {
        parts.push(sectionHead("이 본문의 지도 위 자리", res.stops.length));
        // 찾은 구절의 첫 절을 함께 넘겨, 눌렀을 때 본문에서 그 절이 표시되게 한다
        const qv = res.ref.ranges[0][0];
        parts.push(res.stops.map(function (r) { return stopBtnHtml(r.it, [], qv); }).join(""));
      } else if (res.verses.length) {
        parts.push(
          '<p class="sr-note">이 본문은 지도에 그려진 전도 여정 밖에 있습니다. ' +
          "이 지도는 <b>사도행전 8장</b>(빌립의 전도)과 <b>13–28장</b>(바울의 여정)을 담고 있습니다.</p>"
        );
      }
    } else {
      if (res.loose && !nothing) {
        parts.push('<p class="sr-note">검색어와 꼭 맞는 결과가 없어, 가까운 결과를 보여 드립니다.</p>');
      }
      if (res.stops.length) {
        parts.push(sectionHead("지역 · 여정", res.stops.length));
        parts.push(res.stops.slice(0, 25).map(function (r) { return stopBtnHtml(r.it, res.terms); }).join(""));
      }
      if (res.verses.length) {
        parts.push(sectionHead("사도행전 본문", res.verses.length + (res.truncated ? "+" : "")));
        parts.push('<div class="sr-verses">' + res.verses.map(function (v) { return verseHtml(v, res.terms); }).join("") + "</div>");
        if (res.truncated) parts.push('<p class="sr-more">그 밖에 ' + res.truncated + "절이 더 있습니다.</p>");
      }
      if (res.people.length) {
        parts.push(sectionHead("인물", res.people.length));
        parts.push(res.people.slice(0, 8).map(function (r) {
          return '<div class="sr-item sr-plain"><span class="sr-line">' +
            '<span class="sr-badge sr-badge--soft">인물</span>' +
            '<span class="sr-name">' + mark(r.o.name, res.terms) + "</span></span>" +
            '<span class="sr-snip">' + mark(snippet(r.o.p.bio || r.o.p.role || "", res.terms, 96), res.terms) + "</span></div>";
        }).join(""));
      }
      if (res.epistles.length) {
        parts.push(sectionHead("서신", res.epistles.length));
        parts.push(res.epistles.slice(0, 8).map(function (r) {
          return '<div class="sr-item sr-plain"><span class="sr-line">' +
            '<span class="sr-badge sr-badge--soft">서신</span>' +
            '<span class="sr-name">' + mark(r.o.book, res.terms) + "</span></span>" +
            '<span class="sr-snip">' + mark(snippet(r.o.e.summary || r.o.e.theme || "", res.terms, 96), res.terms) + "</span></div>";
        }).join(""));
      }
      if (nothing) {
        parts.push(
          '<p class="sr-empty">검색 결과가 없습니다.<br/>' +
          '<span class="sr-hint">구절(<b>행 16:9</b> · <b>13장</b>)이나 말씀 속 낱말(<b>마게도냐</b>), ' +
          "지명 · 인물 이름으로 찾아보세요.</span></p>"
        );
      }
    }

    box.innerHTML = parts.join("");
    box.hidden = false;
    if (sidebarBody) { sidebarBody.classList.add("searching"); sidebarBody.scrollTop = 0; }
    const cl = $("srClose");
    if (cl) cl.onclick = closeResults;
  }

  function closeResults() {
    if (box) { box.hidden = true; box.innerHTML = ""; }
    if (sidebarBody) sidebarBody.classList.remove("searching");
    if (input) input.value = "";
    if (clearBtn) clearBtn.hidden = true;
  }

  /* ---------- 정차지로 이동 ----------
     검색 결과를 누르면 ① 지도가 그 자리로 가서 말풍선으로 위치를 찍고
     ② 상세 패널이 열리며 ③ 그 구절 본문이 자동으로 펼쳐진다.
     검색해 온 절은 본문 안에서 따로 표시한다. */
  function goTo(jid, n, ref, vno) {
    const A = window.ActsMap;
    if (!A || !A.focusStop) return;

    let pinVerse = "";
    if (vno && TEXT) {
      const c = Math.floor(vno / 1000), v = vno % 1000;
      const t = TEXT[String(c)] && TEXT[String(c)][String(v)];
      if (t) {
        pinVerse = '<span class="mp-vno">' + c + ":" + v + "</span>" +
          escapeHtml(t.length > 68 ? t.slice(0, 68) + "…" : t);
      }
    }
    A.focusStop(jid, +n, {
      pin: true,
      verseHtml: pinVerse,
      // 여정을 갈아 끼우는 경우 패널이 조금 뒤에 그려지므로 콜백에서 펼친다
      after: ref ? function () { openBibleIn(ref, vno); } : null,
    });
    // 좁은 화면에서는 app.js가 지도 화면으로 넘겨 준다.
    // 목록으로 돌아왔을 때 검색 결과가 그대로 남아 있도록 여기서 접지 않는다.
  }

  /* 상세 패널에서 그 구절의 본문 카드를 펼치고, 찾던 절로 스크롤해 표시한다 */
  function openBibleIn(ref, vno) {
    const body = $("detailBody");
    if (!body) return;
    const els = [].slice.call(body.querySelectorAll(".scripture-chip, .visit-ref"));
    let el = null;
    for (let i = 0; i < els.length; i++) {
      if (els[i].textContent.trim() === String(ref).trim()) { el = els[i]; break; }
    }
    if (!el) el = els[0];
    if (!el) return;
    if (!el.classList.contains("is-open")) el.click();

    const host = el.closest(".detail-block, .visit-card") || el.parentNode;
    const card = host.querySelector(".bible-card");
    if (!card) return;
    card.querySelectorAll(".bible-v.is-hit").forEach(function (p) { p.classList.remove("is-hit"); });
    if (!vno) return;
    const hit = card.querySelector('.bible-v[data-vno="' + vno + '"]');
    if (!hit) return;
    hit.classList.add("is-hit");
    try { hit.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { /* noop */ }
  }

  /* ---------- 상세 패널: 본문 펼쳐 보기 ----------
     상세 패널의 성경 본문 표시(scripture-chip · visit-ref)를 누르면
     그 구절의 개역개정 본문을 바로 아래에 펼친다. */
  function refCardHtml(ref) {
    const ranges = parseRefField(ref);
    if (!ranges.length || !TEXT) return null;
    const verses = versesInRanges(ranges);
    if (!verses.length) return null;
    const shown = verses.slice(0, 60);
    return (
      '<div class="bible-card">' +
      '<div class="bible-card-head">' + escapeHtml(ref) + " <span>개역개정</span></div>" +
      shown.map(function (v) {
        return '<p class="bible-v" data-vno="' + v.vno + '"><span class="bible-vno">' +
          v.c + ":" + v.v + "</span>" + escapeHtml(v.text) + "</p>";
      }).join("") +
      (verses.length > shown.length ? '<p class="bible-more">… ' + (verses.length - shown.length) + "절 생략</p>" : "") +
      "</div>"
    );
  }

  function setupDetailBible() {
    const body = $("detailBody");
    if (!body) return;
    body.addEventListener("click", function (e) {
      const el = e.target.closest(".scripture-chip, .visit-ref");
      if (!el || !body.contains(el)) return;
      const ref = el.textContent.trim();
      if (!ref || ref === "—") return;
      const host = el.closest(".detail-block, .visit-card") || el.parentNode;
      const existing = host.querySelector(".bible-card");
      if (existing) {
        existing.remove();
        el.classList.remove("is-open");
        return;
      }
      const html = refCardHtml(ref);
      if (!html) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = html;
      host.appendChild(wrap.firstChild);
      el.classList.add("is-open");
    });
  }

  /* ---------- 입력 바인딩 ---------- */
  function setup() {
    buildIndex();
    setupDetailBible();
    if (!input || !box) return;

    let timer = null;
    let last = null;

    function run() {
      const q = input.value.trim();
      if (clearBtn) clearBtn.hidden = q.length === 0;
      if (!q) { if (box) { box.hidden = true; box.innerHTML = ""; } if (sidebarBody) sidebarBody.classList.remove("searching"); last = null; return; }
      if (q === last) { if (box.hidden) render(search(q)); return; }
      last = q;
      render(search(q));
    }

    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(run, 170);
    });
    // 좁은 화면에서 결과를 접어 둔 뒤 다시 검색창을 누르면 그 결과를 되살린다
    input.addEventListener("focus", function () {
      if (input.value.trim() && box.hidden) run();
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(timer);
        run();
        const first = box.querySelector(".sr-stop, .sr-chip, .sr-verse[data-jid]");
        if (first) goTo(first.dataset.jid, first.dataset.n, first.dataset.ref, +first.dataset.vno || 0);
      } else if (e.key === "Escape") {
        e.stopPropagation();
        closeResults();
        input.blur();
      }
    });
    if (clearBtn) clearBtn.onclick = function () { closeResults(); input.focus(); };

    // 칩 > 정차지 버튼 > 절 카드 순으로 잡는다(칩이 절 카드 안에 들어 있으므로)
    function hitTarget(e) {
      const chip = e.target.closest(".sr-chip");
      if (chip) return chip;
      const stopBtn = e.target.closest(".sr-stop");
      if (stopBtn) return stopBtn;
      const verse = e.target.closest(".sr-verse");
      return verse && verse.dataset.jid ? verse : null;
    }
    box.addEventListener("click", function (e) {
      const b = hitTarget(e);
      if (!b) return;
      goTo(b.dataset.jid, b.dataset.n, b.dataset.ref, +b.dataset.vno || 0);
    });
    // 절 카드는 버튼이 아니므로 키보드 조작을 따로 받는다
    box.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      const v = e.target.closest(".sr-verse");
      if (!v || !v.dataset.jid) return;
      e.preventDefault();
      goTo(v.dataset.jid, v.dataset.n, v.dataset.ref, +v.dataset.vno || 0);
    });

    // 단축키: / 또는 Ctrl+K 로 검색창 포커스
    document.addEventListener("keydown", function (e) {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k")) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();

  window.ActsSearch = {
    search: search, parseQuery: parseQuery,
    parseRefField: parseRefField, versesInRanges: versesInRanges
  };
})();
