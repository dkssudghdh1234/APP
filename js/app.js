/* ============================================================
   사도행전의 전도 여정 — 인터랙티브 지도 로직 (Leaflet)
   데이터: js/data.js (JOURNEYS / JOURNEY_ORDER / PLACES)
          js/people.js (PAUL_PEOPLE) / js/epistles.js (PAUL_EPISTLE_BOOKS·PAUL_EPISTLES)
   ============================================================ */
(function () {
  "use strict";

  /* 차수별 대표색 (탭·경로·마커·칩 공통) */
  const COLORS = { jp: "#16a34a", j1: "#c0392b", j2: "#1f6feb", j3: "#8e44ad", j4: "#d97706" };

  /* 전진/귀환 구분: 전진=여정 색(실선), 귀환=아래 색(점선) */
  const RETURN_COLOR = "#2a9d8f";   // 귀환 경로 색(청록)
  const RETURN_OFFSET_DEG = 0.09;   // 전진선에 딱 붙는 평행 간격(도) — 선 두께 수준

  /* 항해 기착지(작은 원형 마커로 표시)는 data.js의 각 정차지 sea:true 로 지정 */

  /* ---------- 지도 초기화 ---------- */
  // SVG 렌더러 clip padding을 넉넉히 잡아 팬/줌 직후 경로선 잘림을 방지
  const map = L.map("map", {
    center: [37.5, 30.0],
    zoom: 6,
    minZoom: 4,
    maxZoom: 11,
    zoomControl: true,
    scrollWheelZoom: true,
    worldCopyJump: false,
    renderer: L.svg({ padding: 0.5 }),
    // 부드러운 휠 줌 — 휠 도중엔 분수 줌, 멈추면 1/4 단위 정착
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    wheelPxPerZoomLevel: 120,
    wheelDebounceTime: 25,
    zoomAnimation: true,
  });

  /* 베이스 레이어: 현대 지도(Esri Light Gray) ⇄ 로마 시대 지도(DARE)
     CARTO 무료 타일은 2026년부터 이미지에 "API KEY REQUIRED" 워터마크를 찍으므로
     키 없이 쓸 수 있는 Esri Light Gray Canvas로 옮겼다.
     바탕(지형·경계)과 라벨(지명)이 별도 레이어라 둘을 겹쳐 하나처럼 쓴다. */
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  const ESRI_ATTR =
    'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Esri, HERE, Garmin, ' +
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const modernTiles = L.layerGroup([
    L.tileLayer(ESRI + "World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: ESRI_ATTR,
      maxZoom: 16,
      maxNativeZoom: 16,
    }),
    L.tileLayer(ESRI + "World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 16,
      maxNativeZoom: 16,
    }),
  ]);

  /* 타일 레이어(또는 레이어 묶음)를 지도 맨 아래로 — layerGroup에는 bringToBack이 없다 */
  function tilesToBack(layer) {
    if (layer.bringToBack) { layer.bringToBack(); return; }
    const ls = [];
    layer.eachLayer(function (l) { ls.push(l); });
    ls.reverse().forEach(function (l) { if (l.bringToBack) l.bringToBack(); });
  }
  // Digital Atlas of the Roman Empire — 1~2세기 로마 속주·고대 지명·로마 가도
  const romanTiles = L.tileLayer("https://dh.gu.se/tiles/imperium/{z}/{x}/{y}.png", {
    attribution:
      '고지도: <a href="https://dare.ht.lu.se/">Digital Atlas of the Roman Empire</a> · J. Åhlfeldt',
    maxZoom: 11,
    maxNativeZoom: 11,
  });
  // 로마 시대 타일 서버(개인 연구 서버)가 응답하지 않을 때 안내
  let romanTileFailNotified = false;
  romanTiles.on("tileerror", function () {
    if (romanTileFailNotified || baseMode !== "roman") return;
    romanTileFailNotified = true;
    const credit = document.querySelector(".map-overlay-credit");
    if (credit) credit.textContent = "로마 시대 지도를 일부 불러오지 못했습니다 — 잠시 후 다시 시도하거나 현대 지도를 이용해 주세요.";
  });
  modernTiles.addTo(map);
  let baseMode = "modern";

  function setBaseLayer(mode) {
    if (mode === baseMode) return;
    if (mode === "roman") {
      romanTileFailNotified = false; // 재시도 시 실패 안내를 다시 허용
      map.removeLayer(modernTiles);
      romanTiles.addTo(map);
      romanTiles.bringToBack();
    } else {
      map.removeLayer(romanTiles);
      modernTiles.addTo(map);
      tilesToBack(modernTiles);
    }
    baseMode = mode;
    const credit = document.querySelector(".map-overlay-credit");
    if (credit) {
      credit.textContent =
        mode === "roman"
          ? "고지도 © Digital Atlas of the Roman Empire (J. Åhlfeldt)"
          : "지도 데이터 © Esri · HERE · Garmin · OpenStreetMap";
    }
    document.querySelectorAll("#baseToggle .base-opt").forEach((b) => {
      b.classList.toggle("is-on", b.dataset.base === mode);
    });
  }
  function setupBaseToggle() {
    const tg = $("baseToggle");
    if (!tg) return;
    tg.querySelectorAll(".base-opt").forEach((b) => {
      b.onclick = () => setBaseLayer(b.dataset.base);
    });
  }

  /* ---------- 상태 ---------- */
  let activeJourney = null;
  let renderToken = 0;      // 빠른 탭 전환 시 늦게 도착하는 애니메이션 무효화
  let onMap = [];           // 현재 지도에 올린 레이어들
  let current = null;       // 단일 여행 모드 빌드 결과
  let activeMarkers = [];   // 선택(펄스)된 마커들
  let pendingRecenter = null; // 검색으로 찾아간 지점 — 패널을 닫을 때 화면에 되돌릴 좌표
  let allByKey = null;      // 전체 보기: 위치별 [{jid,color,stops,marker}] 교차 색인

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const tabsEl = $("journeyTabs");
  const emptyState = $("emptyState");
  const overview = $("journeyOverview");
  const stopListEl = $("stopList");
  const detailPanel = $("detailPanel");

  /* ---------- 유틸 ---------- */
  const locKey = (s) => s.lat.toFixed(3) + "," + s.lng.toFixed(3);
  function escapeHtml(t) {
    return String(t == null ? "" : t)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  const placeOf = (s) => (typeof PLACES !== "undefined" && PLACES[s.en]) || null;

  /* ===== 모노라인 SVG 아이콘 세트 (viewBox 0 0 24 24, currentColor) ===== */
  const ICONS = {
    location:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 21s6.5-5.7 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.3 6.5 11 6.5 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>',
    city:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 9.5 12 4l8 5.5"/><path d="M5.5 9.5v8M10 9.5v8M14 9.5v8M18.5 9.5v8"/><path d="M3.5 20.5h17"/><path d="M4.5 17.5h15"/></svg>',
    book:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 6.2C10.4 5.2 8.3 4.6 5 4.6v12.6c3.3 0 5.4.6 7 1.6 1.6-1 3.7-1.6 7-1.6V4.6c-3.3 0-5.4.6-7 1.6Z"/><path d="M12 6.2v12.6"/></svg>',
    event:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3.5 14.4 9l5.6.5-4.3 3.8 1.3 5.7L12 16l-5 3 1.3-5.7L4 9.5 9.6 9 12 3.5Z"/></svg>',
    spirit:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 8.5c2.6 0 4 1.5 5.5 3.5 1.6 2.1 3 3.7 5.5 3.7 3 0 5-2.2 5.5-5.2-1.2.9-2.3 1-3.4.4 1.4-.9 2-2.2 1.9-3.9-1.3 1.2-2.5 1.4-3.8.9C18.6 5 16.6 4 14.2 4.7c-2.4.7-3.4 3-3.1 5.6"/><path d="M11 16.5 9.5 20.5"/><path d="M16 8.2h.01"/></svg>',
    companions:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.2a3 3 0 0 1 0 5.6"/><path d="M17.5 14.2c2.2.6 3.8 2.4 3.8 4.8"/></svg>',
    coworker:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M11 7.5 8.6 5.4a2 2 0 0 0-2.7.1L2.5 8.8M13 7.5l2.4-2.1a2 2 0 0 1 2.7.1l3.4 3.3"/><path d="M21.5 10.1 16 15.6c-.7.7-1.7.7-2.4 0l-.6-.6-.9.9c-.7.7-1.8.7-2.5 0l-.5-.5-.8.8c-.7.7-1.8.7-2.5 0L3 14.2"/><path d="m9.5 13.5 1.5 1.5M12 11.5l1.6 1.6"/></svg>',
    epistle:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/></svg>',
    fullscreen:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 3.5H4.5A1.5 1.5 0 0 0 3 5v3.5M16 3.5h3.5A1.5 1.5 0 0 1 21 5v3.5M8 20.5H4.5A1.5 1.5 0 0 1 3 19v-3.5M16 20.5h3.5A1.5 1.5 0 0 0 21 19v-3.5"/></svg>',
    fullscreenExit:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 8H7a1.5 1.5 0 0 0 1.5-1.5V3M20.5 8H17a1.5 1.5 0 0 1-1.5-1.5V3M3.5 16H7a1.5 1.5 0 0 1 1.5 1.5V21M20.5 16H17a1.5 1.5 0 0 0-1.5 1.5V21"/></svg>',
    /* 마커/심볼용 (흰 채움) */
    markerStart:
      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false"><path d="M8 5.2a1 1 0 0 1 1.5-.87l9 6.8a1 1 0 0 1 0 1.74l-9 6.8A1 1 0 0 1 8 18.8Z"/></svg>',
    markerEnd:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 21V4"/><path d="M6 5.2c3-1.8 6 1.4 9-.2v7.2c-3 1.6-6-1.6-9 .2" fill="currentColor"/></svg>',
    anchor:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="5" r="2.2"/><path d="M12 7.2V20"/><path d="M7.5 11H16.5"/><path d="M4.5 13.5c0 4 3.4 6.5 7.5 6.5s7.5-2.5 7.5-6.5"/></svg>',
  };

  function icon(name) {
    const svg = ICONS[name] || "";
    return svg ? svg.replace("<svg ", '<svg class="lbl-icon" ') : "";
  }
  function iconLabel(name, text) {
    return '<span class="lbl-with-icon">' + icon(name) + '<span class="lbl-text">' + escapeHtml(text) + "</span></span>";
  }
  function pinGlyph(name) {
    const svg = ICONS[name] || "";
    return svg ? svg.replace("<svg ", '<svg class="pin-glyph" ') : "";
  }

  /* 방문 성격 라벨 — data.js의 type을 우선 사용 */
  function visitRole(s, i, total) {
    if (s.type) return s.type;
    return total > 1 ? (i === 0 ? "첫 방문" : "재방문") : "방문";
  }

  /* 표시용 라벨: 빌립은 전도자, 1~3차는 전도여행, 4차는 로마 압송 */
  function jLabels(j) {
    if (j.id === "jp") return { main: "빌립", sub: "전도자", chip: "빌립" };
    if (j.id === "j4") return { main: "로마", sub: "압송", chip: "로마 압송" };
    return { main: j.label, sub: "전도여행", chip: j.label };
  }

  /* ---------- 경로 곡선 — 중심형(centripetal) Catmull-Rom 스플라인 ----------
     실제 도시 좌표는 그대로 통과하고, 사이 구간만 자연스러운 곡선으로 보간 */
  function lerpT(a, b, ta, tb, t) {
    if (tb === ta) return [a[0], a[1]];
    const f = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
  function smoothLatLngs(pts) {
    const p = [];
    for (let i = 0; i < pts.length; i++) {
      if (i === 0 || pts[i][0] !== pts[i - 1][0] || pts[i][1] !== pts[i - 1][1]) p.push(pts[i]);
    }
    if (p.length < 3) return p;
    const SEG = 18, ALPHA = 0.5;
    const dist = (a, b) => Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2));
    const out = [];
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i === 0 ? 0 : i - 1];
      const p1 = p[i];
      const p2 = p[i + 1];
      const p3 = p[i + 2 < p.length ? i + 2 : p.length - 1];
      const t0 = 0;
      const t1 = t0 + Math.pow(dist(p0, p1) || 1e-6, ALPHA);
      const t2 = t1 + Math.pow(dist(p1, p2) || 1e-6, ALPHA);
      const t3 = t2 + Math.pow(dist(p2, p3) || 1e-6, ALPHA);
      for (let s = 0; s < SEG; s++) {
        const t = t1 + (t2 - t1) * (s / SEG);
        const a1 = lerpT(p0, p1, t0, t1, t);
        const a2 = lerpT(p1, p2, t1, t2, t);
        const a3 = lerpT(p2, p3, t2, t3, t);
        const b1 = lerpT(a1, a2, t0, t2, t);
        const b2 = lerpT(a2, a3, t1, t3, t);
        out.push(lerpT(b1, b2, t1, t2, t));
      }
    }
    out.push(p[p.length - 1]);
    return out;
  }

  /* ---------- 귀환선: 전진 곡선의 평행 트윈 ----------
     전진 경로와 같은 회랑을 지나는 구간에서는, 빨간 전진 곡선의 해당 부분을
     그대로 가져와 귀환 진행 방향으로 뒤집고, 각 점을 일정 간격(offDeg)만큼
     옆으로 평행 이동한다. 결과적으로 귀환선이 전진선 '바로 옆에 붙어서'
     같은 모양으로 나란히 달린다(포물선 벌어짐 없음). 공유하지 않는 구간
     (버가→앗달리아→안디옥)은 도시 좌표를 그대로 잇는다. */
  function offsetSharedLegs(pts, sharedKeys, offDeg, fwdSmooth) {
    const n = pts.length;
    if (n < 2) return pts.slice();
    const key = (a, b) => {
      const ka = a[0].toFixed(3) + "," + a[1].toFixed(3);
      const kb = b[0].toFixed(3) + "," + b[1].toFixed(3);
      return ka < kb ? ka + "|" + kb : kb + "|" + ka;
    };
    const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;
    const out = [pts[0].slice()];

    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      let ia = -1, ib = -1;
      if (sharedKeys.has(key(a, b)) && fwdSmooth && fwdSmooth.length) {
        fwdSmooth.forEach((p, idx) => {
          if (ia < 0 && same(p, a)) ia = idx;
          if (ib < 0 && same(p, b)) ib = idx;
        });
      }
      if (ia < 0 || ib < 0 || ia === ib) { out.push(b.slice()); continue; }

      // 전진 곡선에서 a→b 구간을 떼어 귀환 진행 방향으로 정렬
      const portion = ia < ib ? fwdSmooth.slice(ia, ib + 1) : fwdSmooth.slice(ib, ia + 1).reverse();

      // 각 점을 국소 접선의 법선 방향으로 평행 이동.
      // 도시 정점(양 끝) 근처에서는 가중치를 0으로 수렴시켜 거점을 정확히 관통하고,
      // 그 사이 구간은 가중치 1로 전진선에 일정 간격으로 딱 붙어 나란히 간다.
      const RAMP = 0.18; // 구간 양 끝에서 오프셋이 붙기/풀리기까지의 비율
      const ease = (x) => x * x * (3 - 2 * x); // smoothstep
      for (let k = 0; k < portion.length; k++) {
        const p = portion[k];
        const prev = portion[Math.max(0, k - 1)];
        const next = portion[Math.min(portion.length - 1, k + 1)];
        const cosL = Math.max(0.2, Math.cos((p[0] * Math.PI) / 180));
        const tLat = next[0] - prev[0];
        const tLonS = (next[1] - prev[1]) * cosL;
        const len = Math.hypot(tLat, tLonS) || 1e-6;
        const nLat = -tLonS / len;          // 진행 방향의 오른쪽 법선
        const nLonS = tLat / len;
        const t = portion.length > 1 ? k / (portion.length - 1) : 0;
        const edge = Math.min(t, 1 - t);
        const w = edge >= RAMP ? 1 : ease(edge / RAMP);
        out.push([p[0] + nLat * offDeg * w, p[1] + (nLonS / cosL) * offDeg * w]);
      }
    }
    return out;
  }

  /* ---------- 왕복 경로선 분리 ----------
     같은 도시쌍 회랑을 2회 이상 지나는(왕복) 구간을 진행 방향 옆으로
     살짝 부풀려, 갈 때/올 때 선이 겹치지 않게 한다. 마커 좌표는 그대로. */
  function buildOffsetLatLngs(stops) {
    const pts = stops.map((s) => [s.lat, s.lng]);
    const n = pts.length;
    if (n < 2) return pts;

    const legKey = (a, b) => {
      const ka = a[0].toFixed(3) + "," + a[1].toFixed(3);
      const kb = b[0].toFixed(3) + "," + b[1].toFixed(3);
      return ka < kb ? ka + "|" + kb : kb + "|" + ka;
    };

    // 각 회랑(무방향 도시쌍) 통과 횟수 집계 → 2회 이상이면 왕복
    const passCount = {};
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const k = legKey(a, b);
      passCount[k] = (passCount[k] || 0) + 1;
    }

    const OFFSET_DEG = 0.05;
    const seenInCorridor = {};
    function laneFor(k) {
      const idx = seenInCorridor[k] || 0;
      seenInCorridor[k] = idx + 1;
      const mag = Math.floor(idx / 2) + 1;
      const sign = idx % 2 === 0 ? 1 : -1;
      return sign * mag;
    }

    const SUB = 16;
    const out = [];
    out.push(pts[0].slice());

    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a[0] === b[0] && a[1] === b[1]) continue;

      const k = legKey(a, b);
      const shared = (passCount[k] || 0) >= 2;
      if (!shared) { out.push(b.slice()); continue; }

      const lane = laneFor(k);
      const amp = OFFSET_DEG * lane;

      const midLat = (a[0] + b[0]) / 2;
      const cosL = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
      const dLat = b[0] - a[0];
      const dLonScaled = (b[1] - a[1]) * cosL;
      const len = Math.hypot(dLat, dLonScaled) || 1e-6;
      const nLat = -dLonScaled / len;
      const nLon = (dLat / len) / cosL;

      // 끝점에서 0, 중앙에서 최대인 벨 가중 → 도시 정점은 원좌표 유지
      for (let s = 1; s <= SUB; s++) {
        const t = s / SUB;
        const baseLat = a[0] + (b[0] - a[0]) * t;
        const baseLon = a[1] + (b[1] - a[1]) * t;
        const w = Math.sin(Math.PI * t);
        out.push([baseLat + nLat * amp * w, baseLon + nLon * amp * w]);
      }
    }
    return out;
  }

  /* ---------- 탭 버튼 ---------- */
  function buildTabs() {
    tabsEl.innerHTML = "";
    JOURNEY_ORDER.forEach((jid) => {
      const j = JOURNEYS[jid];
      const b = document.createElement("button");
      b.className = "tab-btn";
      b.dataset.j = jid;
      const L = jLabels(j);
      b.innerHTML = `${L.main}<small>${L.sub}</small>`;
      b.onclick = () => selectJourney(jid, true);
      tabsEl.appendChild(b);
    });
    const all = document.createElement("button");
    all.className = "tab-btn";
    all.dataset.j = "all";
    all.innerHTML = `전체<small>한눈에</small>`;
    all.onclick = () => selectAll();
    tabsEl.appendChild(all);
  }

  /* ---------- 마커 아이콘 ---------- */
  function makeIcon(grp, color, mode) {
    const primary = grp.stops[0];
    const idx = (grp.seq || 1) - 1;
    const delay = (mode === "all" ? idx * 0.02 : 0.05 + idx * 0.045).toFixed(2);

    if (mode === "all") {
      return L.divIcon({
        className: "mk",
        html: `<div class="pin-reveal pre" style="--pc:${color};animation-delay:${delay}s"><div class="dot" style="background:${color}"></div></div>`,
        iconSize: [15, 15],
        iconAnchor: [7, 7],
      });
    }

    const isSea = !!primary.sea && grp.stops.length === 1;

    let mod = "pin--visit";
    let label = grp.seq;
    if (grp.isStart) { mod = "pin--start"; label = pinGlyph("markerStart"); }
    else if (grp.isEnd) { mod = "pin--end"; label = pinGlyph("markerEnd"); }
    else if (isSea) { mod = "pin--sea"; }

    const badge = grp.stops.length > 1 ? `<i class="pin-badge">${grp.stops.length}</i>` : "";
    const size = grp.isStart || grp.isEnd ? [34, 44] : isSea ? [22, 22] : [30, 40];
    const anchor = isSea ? [11, 11] : [size[0] / 2, size[1] - 2];

    return L.divIcon({
      className: "mk",
      html:
        `<div class="pin-reveal pre" style="--pc:${color};animation-delay:${delay}s">` +
        `<span class="place-label${isSea ? " place-label--sea" : ""}">${escapeHtml(primary.koShort || primary.ko)}</span>` +
        `<div class="pin ${mod}" style="background:${color}"><span>${label}</span></div>${badge}</div>`,
      iconSize: size,
      iconAnchor: anchor,
      popupAnchor: [0, -size[1] + 8],
    });
  }

  /* ---------- 여행 레이어 생성 ---------- */
  function buildJourneyLayer(j, mode) {
    const color = COLORS[j.id];
    const group = L.layerGroup();
    const hasLegs = j.stops.some((s) => s.leg);

    const lines = [];      // 그리기(reveal) 애니메이션 대상 — 전진 실선
    const flowLines = [];  // 흐르는 점선 오버레이(단일 여행에서만)

    // 실선 + (단일 여행일 때) 흐르는 점선 한 세트 추가
    function addSolid(pts, col) {
      const line = L.polyline(pts, {
        color: col,
        weight: mode === "all" ? 2.1 : 2.9,
        opacity: mode === "all" ? 0.5 : 0.9,
        className: "route-line",
        smoothFactor: 0,
      });
      group.addLayer(line);
      lines.push(line);
      if (mode !== "all") {
        flowLines.push(L.polyline(pts, {
          color: "#ffffff",
          weight: 2.2,
          opacity: 0.9,
          dashArray: "0.1 13",
          className: "route-flow",
          interactive: false,
        }));
      }
      return line;
    }

    let legLines = null;
    if (hasLegs) {
      // 전진(out) 실선 + 귀환(return) 점선을 나란히 그린다
      const outCoords = j.stops.filter((s) => s.leg === "out").map((s) => [s.lat, s.lng]);
      const retStops = j.stops.filter((s) => s.leg === "return");
      // 귀환선은 마지막 전진 지점(더베)에서 시작해 연결
      const retCoords = (outCoords.length ? [outCoords[outCoords.length - 1]] : [])
        .concat(retStops.map((s) => [s.lat, s.lng]));

      const outSmooth = smoothLatLngs(outCoords);
      const outLine = addSolid(outSmooth, color);

      // 전진선이 지나는 회랑(도시쌍) 집합 — 이 구간에서만 귀환선을 옆으로 벌린다
      const outKeys = new Set();
      for (let i = 0; i < outCoords.length - 1; i++) {
        const a = outCoords[i], b = outCoords[i + 1];
        const ka = a[0].toFixed(3) + "," + a[1].toFixed(3);
        const kb = b[0].toFixed(3) + "," + b[1].toFixed(3);
        outKeys.add(ka < kb ? ka + "|" + kb : kb + "|" + ka);
      }

      // 귀환 점선 — 공유 구간은 전진 곡선의 평행 트윈(바로 옆에 붙어 나란히),
      // 비공유 구간(버가→앗달리아→안디옥)은 직선. 트윈이 이미 매끄러우므로 재스무딩 없음.
      // 단일 여행 보기에서는 대시가 진행 방향(더베→안디옥)으로 흐른다
      const retLine = L.polyline(offsetSharedLegs(retCoords, outKeys, RETURN_OFFSET_DEG, outSmooth), {
        color: RETURN_COLOR,
        weight: mode === "all" ? 2.2 : 3,
        opacity: mode === "all" ? 0.55 : 0.95,
        className: "route-line route-return" + (mode !== "all" ? " route-return--flow" : ""),
        dashArray: "10 9",
        lineCap: "round",
        smoothFactor: 0,
      });
      group.addLayer(retLine); // 점선 유지 위해 reveal 애니메이션은 걸지 않음
      legLines = { out: outLine, ret: retLine };
    } else {
      addSolid(smoothLatLngs(buildOffsetLatLngs(j.stops)), color);
    }

    // 같은 위치(좌표) 정차지를 하나로 병합, 들른 순서(1..N)로 번호 부여
    const nums = j.stops.map((s) => s.n);
    const firstN = Math.min.apply(null, nums);
    const lastN = Math.max.apply(null, nums);

    const groupsByKey = {};
    const ordered = [];
    j.stops.forEach((s) => {
      const k = locKey(s);
      if (!groupsByKey[k]) { groupsByKey[k] = { key: k, stops: [] }; ordered.push(groupsByKey[k]); }
      groupsByKey[k].stops.push(s);
    });

    const N = ordered.length;
    const markers = [];
    ordered.forEach((grp, i) => {
      grp.seq = i + 1;
      grp.isStart = grp.stops.some((s) => s.n === firstN);
      grp.isEnd = !grp.isStart && grp.stops.some((s) => s.n === lastN);
      const primary = grp.stops[0];
      const z = grp.isStart || grp.isEnd ? 1000 : (N - grp.seq) * 5;
      const m = L.marker([primary.lat, primary.lng], {
        icon: makeIcon(grp, color, mode),
        riseOnHover: true,
        zIndexOffset: z,
      });
      // 전체 보기: 점만 보이므로 호버 시 지명 툴팁 제공
      if (mode === "all") {
        m.bindTooltip(`<b>${escapeHtml(primary.ko)}</b>`, {
          direction: "top", offset: [0, -10], opacity: 0.97, className: "route-tip",
        });
      }
      m.on("click", () => {
        if (mode === "all") openDetailCombined(grp.key);
        else openDetail(j, grp.stops, 0, grp);
      });
      group.addLayer(m);
      m._baseZ = z;
      grp.marker = m;
      markers.push(m);
    });

    return { jid: j.id, group, lines, flowLines, legLines, markers, groupsByKey, orderedGroups: ordered };
  }

  /* ---------- 애니메이션 ---------- */
  // 경로 그리기(stroke reveal). 끝나면 dasharray를 해제해 실선으로 복원
  function drawLine(line, token) {
    const p = line && line._path;
    if (!p || !p.getTotalLength) return;
    try {
      const len = p.getTotalLength();
      p.style.transition = "none";
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
      p.getBoundingClientRect(); // reflow
      p.style.transition = "stroke-dashoffset 1.15s cubic-bezier(.4,0,.2,1)";
      p.style.strokeDashoffset = "0";

      const clearDash = function () {
        if (token != null && token !== renderToken) return;
        if (!line._map) return;
        p.style.transition = "none";
        p.style.strokeDasharray = "none";
        p.style.strokeDashoffset = "0";
      };
      p.addEventListener("transitionend", function te(ev) {
        if (ev.propertyName && ev.propertyName !== "stroke-dashoffset") return;
        p.removeEventListener("transitionend", te);
        clearDash();
      });
      setTimeout(clearDash, 1300);
    } catch (e) { /* noop */ }
  }

  function revealMarkers(markers) {
    markers.forEach((m) => {
      const el = m.getElement();
      if (!el) return;
      const r = el.querySelector(".pin-reveal");
      if (r) { r.classList.remove("pre"); r.classList.add("is-in"); }
    });
  }

  function setActiveMarkers(list) {
    document.querySelectorAll(".pin-reveal.is-active").forEach((e) => e.classList.remove("is-active"));
    activeMarkers.forEach((m) => { if (m && m.setZIndexOffset) m.setZIndexOffset(m._baseZ || 0); });
    activeMarkers = [];
    (list || []).forEach((m) => {
      if (!m) return;
      activeMarkers.push(m);
      if (m.setZIndexOffset) m.setZIndexOffset(100000);
      const el = m.getElement();
      if (el) { const r = el.querySelector(".pin-reveal"); if (r) r.classList.add("is-active"); }
    });
  }
  function setActiveMarker(grp) {
    setActiveMarkers(grp && grp.marker ? [grp.marker] : []);
  }

  /* ---------- 안전한 지도 이동 ---------- */
  function goToBounds(bounds, padding, onArrive, animate) {
    const pad = padding || [70, 70];
    let arrived = false;
    let tries = 0;
    function arrive() { if (arrived) return; arrived = true; if (onArrive) onArrive(); }

    function attempt() {
      const el = map.getContainer();
      const w = el.clientWidth, h = el.clientHeight;
      if (w > 40 && h > 40) {
        map.invalidateSize(false);
        if (animate) {
          try {
            map.flyToBounds(bounds, { padding: pad, duration: 0.85 });
            map.once("moveend", arrive);
            // 애니메이션이 중간에 끊긴 환경(저전력·rAF 정지 등) 대비:
            // 시간이 지나도 목표 영역이 화면에 없으면 fitBounds로 즉시 스냅
            setTimeout(function () {
              try {
                if (!map.getBounds().contains(bounds.getCenter())) {
                  map.fitBounds(bounds, { padding: pad });
                }
              } catch (e) { /* noop */ }
              arrive();
            }, 1300);
            return;
          } catch (e) { /* 폴백 */ }
        }
        try { map.fitBounds(bounds, { padding: pad }); } catch (e) { /* noop */ }
        arrive();
        return;
      }
      if (tries++ < 40) {
        setTimeout(attempt, 60);
      } else {
        map.invalidateSize(false);
        try { map.fitBounds(bounds, { padding: pad }); } catch (e) { /* noop */ }
        arrive();
      }
    }
    setTimeout(attempt, 30);
  }

  /* ---------- 레이어 정리 ---------- */
  function clearMap() {
    try { map.closePopup(); } catch (e) { /* noop */ }   // 여정을 바꾸면 위치 말풍선도 걷는다
    onMap.forEach((l) => map.removeLayer(l));
    onMap = [];
    current = null;
    allByKey = null;
  }

  /* ---------- 여행 선택 (단일) ----------
     skipFit: 지도를 여정 전체에 맞추는 단계를 건너뛴다. 검색 결과에서 한 지점으로
     바로 들어갈 때 쓰며, 늦게 도착한 전체 맞춤이 그 지점의 확대를 되돌리는 것을 막는다. */
  function selectJourney(jid, animate, skipFit) {
    renderToken += 1;
    const token = renderToken;
    activeJourney = jid;
    closeDetail();
    clearMap();

    const j = JOURNEYS[jid];
    if (!j) return;

    const built = buildJourneyLayer(j, "single");
    current = built;
    built.group.addTo(map);
    onMap.push(built.group);

    setActiveTab(jid);
    renderOverview(j, built.orderedGroups);

    function paint() {
      if (token !== renderToken) return;
      built.lines.forEach((l) => drawLine(l, token));
      setTimeout(() => { if (token === renderToken) revealMarkers(built.markers); }, 170);
      setTimeout(() => {
        if (token !== renderToken) return;
        built.flowLines.forEach((fl) => { fl.addTo(map); onMap.push(fl); });
      }, animate ? 900 : 500);
    }

    if (skipFit) { paint(); return; }

    const bounds = L.latLngBounds(j.stops.map((s) => [s.lat, s.lng]));
    goToBounds(bounds, [80, 80], paint, animate !== false);
  }

  /* ---------- 전체 보기 ---------- */
  function selectAll(animate) {
    renderToken += 1;
    const token = renderToken;
    activeJourney = "all";
    closeDetail();
    clearMap();

    const allPts = [];
    const builts = [];
    JOURNEY_ORDER.forEach((jid) => {
      const j = JOURNEYS[jid];
      const b = buildJourneyLayer(j, "all");
      builts.push(b);
      b.group.addTo(map);
      onMap.push(b.group);
      j.stops.forEach((s) => allPts.push([s.lat, s.lng]));
    });

    // 위치별로 모든 차수의 방문을 모은다(전체 보기 통합 패널용)
    allByKey = {};
    builts.forEach((b) => {
      const color = COLORS[b.jid];
      (b.orderedGroups || []).forEach((g) => {
        (allByKey[g.key] = allByKey[g.key] || []).push({
          jid: b.jid, color: color, stops: g.stops, marker: g.marker,
        });
      });
    });

    setActiveTab("all");
    renderAllOverview();

    if (allPts.length) {
      goToBounds(
        L.latLngBounds(allPts),
        [50, 50],
        function () {
          if (token !== renderToken) return;
          builts.forEach((b) => b.lines.forEach((l) => drawLine(l, token)));
          setTimeout(() => { if (token === renderToken) builts.forEach((b) => revealMarkers(b.markers)); }, 140);
        },
        animate !== false
      );
    }
  }

  function setActiveTab(key) {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      const on = b.dataset.j === key;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  /* ---------- 사이드바 ---------- */
  function replayEnter(el) {
    el.classList.remove("enter");
    void el.offsetWidth;
    el.classList.add("enter");
  }

  /* 전진/귀환 경로 강조 해제 — 두 선을 기본 스타일로 복원 */
  function resetLegEmphasis() {
    if (current && current.legLines) {
      if (current.legLines.out) current.legLines.out.setStyle({ opacity: 0.9, weight: 2.9 });
      if (current.legLines.ret) current.legLines.ret.setStyle({ opacity: 0.95, weight: 3 });
    }
    document.querySelectorAll(".leg-btn.active").forEach((b) => b.classList.remove("active"));
  }

  /* 전진/귀환 버튼 클릭 — 해당 구간으로 지도를 옮기고 그 선을 강조(다른 선은 흐리게).
     이미 활성인 버튼을 다시 누르면 강조를 해제한다(토글). */
  function focusLeg(leg) {
    const j = JOURNEYS[activeJourney];
    if (!j) return;
    const btn = document.querySelector(`.leg-btn[data-leg="${leg}"]`);
    if (btn && btn.classList.contains("active")) { resetLegEmphasis(); return; }

    // 해당 구간의 실제 도시 좌표로 지도 맞춤 (귀환은 시작점 더베 포함)
    const coords = j.stops.filter((s) => s.leg === leg).map((s) => [s.lat, s.lng]);
    if (leg === "return") {
      const outs = j.stops.filter((s) => s.leg === "out");
      if (outs.length) coords.unshift([outs[outs.length - 1].lat, outs[outs.length - 1].lng]);
    }
    if (coords.length > 1) {
      try { map.flyToBounds(L.latLngBounds(coords).pad(0.22), { duration: 0.7 }); } catch (e) { /* noop */ }
    }

    // 선 강조
    if (current && current.legLines) {
      const on = leg === "out" ? current.legLines.out : current.legLines.ret;
      const off = leg === "out" ? current.legLines.ret : current.legLines.out;
      if (on) on.setStyle({ opacity: 1, weight: leg === "out" ? 4.2 : 4 });
      if (off) off.setStyle({ opacity: 0.22 });
    }
    document.querySelectorAll(".leg-btn").forEach((b) => b.classList.toggle("active", b.dataset.leg === leg));
    try { map.closePopup(); } catch (e) { /* noop */ }
    closeDetail();
  }

  function renderOverview(j, groups) {
    emptyState.hidden = true;
    overview.hidden = false;
    const color = COLORS[j.id];

    const badge = $("ovBadge");
    badge.textContent = jLabels(j).chip;
    badge.style.background = color;
    $("ovTitle").textContent = j.title;
    $("ovPeriod").textContent = j.period || "—";
    $("ovScripture").textContent = j.scripture || "—";
    $("ovCompanions").textContent = (j.companions || []).join(", ") || "—";
    $("ovSummary").textContent = j.summary || "";
    $("ovStopCount").textContent = `· 총 ${groups.length}곳`;

    // 전진/귀환 경로 버튼 (leg 데이터가 있는 여정에서만) — 경로 영역 상단에 배치
    const head = document.querySelector(".stop-list-head");
    let legNav = document.getElementById("legNav");
    if (j.stops.some((s) => s.leg)) {
      if (!legNav) {
        legNav = document.createElement("div");
        legNav.id = "legNav";
        legNav.className = "leg-nav";
      }
      const outN = j.stops.filter((s) => s.leg === "out").length;          // 9
      const retN = j.stops.filter((s) => s.leg === "return").length + 1;   // 7 (더베 포함)
      legNav.innerHTML =
        `<button type="button" class="leg-btn leg-btn--out" data-leg="out" style="--lc:${color}">
           <span class="leg-line"></span>
           <span class="leg-body">
             <span class="leg-title">전진 경로 <span class="leg-tag">${outN}곳 · 실선</span></span>
             <span class="leg-desc">안디옥 → 구브로 → 더베. 복음을 전하며 나아간 길</span>
           </span>
         </button>` +
        `<button type="button" class="leg-btn leg-btn--return" data-leg="return" style="--lc:${RETURN_COLOR}">
           <span class="leg-line leg-line--dash"></span>
           <span class="leg-body">
             <span class="leg-title">귀환 경로 <span class="leg-tag">${retN}곳 · 점선</span></span>
             <span class="leg-desc">더베 → 앗달리아 → 안디옥. 왔던 길을 되짚어 교회를 굳게 하며 돌아온 길</span>
           </span>
         </button>`;
      if (head && legNav.parentNode !== head.parentNode) head.parentNode.insertBefore(legNav, head);
      legNav.querySelectorAll(".leg-btn").forEach((b) => {
        b.onclick = () => focusLeg(b.dataset.leg);
      });
    } else if (legNav) {
      legNav.remove();
    }

    stopListEl.innerHTML = "";

    if (j.stops.some((s) => s.leg)) {
      /* ── 전진/귀환 구분 목록 (1차 여정) ──
         전진: 여정색 번호 1..N, 귀환: 초록 번호 1..M(회정점 더베 포함).
         각 항목 클릭 시 해당 방문의 설명 카드에 포커스가 간다. */
      const outStops = j.stops.filter((s) => s.leg === "out");
      const retStops = j.stops.filter((s) => s.leg === "return");
      const turning = outStops[outStops.length - 1];               // 더베(회정점)
      const retList = turning ? [turning].concat(retStops) : retStops;

      $("ovStopCount").textContent = `· 전진 ${outStops.length}곳 · 귀환 ${retList.length}곳`;

      function addSection(label, lineColor, dashed) {
        const li = document.createElement("li");
        li.className = "stop-sec";
        li.innerHTML =
          `<span class="sec-line${dashed ? " sec-line--dash" : ""}" style="--sc:${lineColor}"></span>` +
          `<span>${label}</span>`;
        stopListEl.appendChild(li);
      }
      function addStopItem(s, num, numColor, delayIdx) {
        const grp = groups.find((g) => g.key === locKey(s)) || null;
        const stops = grp ? grp.stops : [s];
        const selIndex = Math.max(0, stops.indexOf(s));
        const place = placeOf(s);
        const li = document.createElement("li");
        li.className = "stop-item";
        li.dataset.key = locKey(s);
        li.style.animationDelay = (delayIdx * 0.03).toFixed(2) + "s";
        const nameKo = s.ko.replace(/\(재방문\)/, "").trim();
        li.innerHTML = `
          <span class="stop-num" style="background:${numColor}">${num}</span>
          <span class="stop-text">
            <span class="sname">${escapeHtml(nameKo)}</span><br/>
            <span class="sregion">${escapeHtml(place ? place.region : "")}${place && place.modern ? " · " + escapeHtml(place.modern) : ""}</span>
          </span>`;
        li.onclick = () => openDetail(j, stops, selIndex, grp);
        stopListEl.appendChild(li);
      }

      let d = 0;
      addSection(`전진 경로 · ${outStops.length}곳`, color, false);
      outStops.forEach((s, i) => addStopItem(s, i + 1, color, d++));
      addSection(`귀환 경로 · ${retList.length}곳`, RETURN_COLOR, true);
      retList.forEach((s, i) => addStopItem(s, i + 1, RETURN_COLOR, d++));
    } else {
      /* ── 기존 방식: 지도 마커와 동일한 위치 순서(1..N), 재방문은 한 항목 ── */
      groups.forEach((grp, i) => {
        const primary = grp.stops[0];
        const place = placeOf(primary);
        const sym = grp.isStart ? icon("markerStart") : grp.isEnd ? icon("markerEnd") : grp.seq;
        const revisit = grp.stops.length > 1 ? `<span class="stop-revisit">${grp.stops.length}회</span>` : "";
        const region = place ? place.region : "";
        const modern = place ? place.modern : "";
        const li = document.createElement("li");
        li.className = "stop-item";
        li.dataset.key = grp.key;
        li.style.animationDelay = (i * 0.03).toFixed(2) + "s";
        li.innerHTML = `
          <span class="stop-num" style="background:${color}">${sym}</span>
          <span class="stop-text">
            <span class="sname">${escapeHtml(primary.ko)}</span>${revisit}<br/>
            <span class="sregion">${escapeHtml(region)}${modern ? " · " + escapeHtml(modern) : ""}</span>
          </span>`;
        li.onclick = () => openDetail(j, grp.stops, 0, grp);
        stopListEl.appendChild(li);
      });
    }
    replayEnter(overview);
  }

  function renderAllOverview() {
    emptyState.hidden = true;
    overview.hidden = false;
    // 전진/귀환 버튼은 개별 여정에서만 — 전체 보기에서는 제거
    const legNav = document.getElementById("legNav");
    if (legNav) legNav.remove();
    $("ovBadge").textContent = "전체";
    $("ovBadge").style.background = "#7b83eb";
    $("ovTitle").textContent = "빌립과 바울의 전도 여정";
    $("ovPeriod").textContent = "약 A.D. 31 ~ 62년";
    $("ovScripture").textContent = "사도행전 8장 · 13 ~ 28장";
    $("ovCompanions").textContent = "베드로·바나바·실라·디모데·누가 등";
    $("ovSummary").textContent =
      "스데반의 순교 후 흩어진 이들 가운데 빌립이 사마리아와 해안의 여러 성에 복음을 전했고(초록), 이어 안디옥에서 파송된 바울을 통해 복음은 소아시아와 유럽을 거쳐 제국의 수도 로마까지 전해졌습니다. 빨강·파랑·보라는 1~3차 전도여행, 주황은 로마 압송 항해입니다. 위 버튼을 누르면 각 여정을 자세히 볼 수 있습니다.";
    $("ovStopCount").textContent = "";

    stopListEl.innerHTML = "";
    JOURNEY_ORDER.forEach((jid, i) => {
      const j = JOURNEYS[jid];
      const li = document.createElement("li");
      li.className = "stop-item";
      li.style.animationDelay = (i * 0.05).toFixed(2) + "s";
      // '곳' 수는 개별 보기와 동일하게 좌표 병합(도시) 기준으로 센다
      const placeCount = new Set(j.stops.map((s) => locKey(s))).size;
      li.innerHTML = `
        <span class="stop-num" style="background:${COLORS[jid]}">${jid === "j4" ? icon("anchor") : jid === "jp" ? "빌" : j.label.replace("차", "")}</span>
        <span class="stop-text">
          <span class="sname">${escapeHtml(j.title)}</span><br/>
          <span class="sregion">${escapeHtml(j.period)} · ${placeCount}곳 · ${escapeHtml(j.scripture)}</span>
        </span>`;
      li.onclick = () => selectJourney(jid, true);
      stopListEl.appendChild(li);
    });
    replayEnter(overview);
  }

  /* ---------- 지역 상세 패널 ---------- */
  function blockEl(label, valueHtml) {
    const d = document.createElement("div");
    d.className = "detail-block";
    d.innerHTML = `<div class="detail-label">${label}</div><div class="detail-value">${valueHtml}</div>`;
    return d;
  }
  function companionsHtml(s) {
    const c = s.companions || [];
    return c.length
      ? c.map((x) => `<button type="button" class="companion-chip" data-person="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join("")
      : '<span class="muted">단독 또는 기록 없음</span>';
  }
  function personCard(name) {
    const p = (window.PAUL_PEOPLE || {})[name];
    const card = document.createElement("div");
    card.className = "person-card";
    card.dataset.person = name;
    if (!p) {
      card.innerHTML =
        `<div class="person-head"><span class="person-name">${escapeHtml(name)}</span></div>` +
        `<div class="muted">약전 준비 중</div>`;
      return card;
    }
    card.innerHTML =
      `<div class="person-head"><span class="person-name">${escapeHtml(name)}</span>` +
      (p.nameEn ? `<span class="person-en">${escapeHtml(p.nameEn)}</span>` : "") +
      `</div>` +
      (p.role ? `<div class="person-role">${escapeHtml(p.role)}</div>` : "") +
      `<div class="person-bio">${escapeHtml(p.bio || "")}</div>` +
      (p.refs ? `<div class="person-refs">${escapeHtml(p.refs)}</div>` : "");
    return card;
  }
  function calloutEl(label, text) {
    const d = document.createElement("div");
    d.className = "detail-callout";
    d.innerHTML = `<div class="detail-label">${label}</div><div class="detail-value">${escapeHtml(text)}</div>`;
    return d;
  }
  // 지점 관련 서신 칩 블록 — 칩 클릭 시 요약 카드 토글
  // 매핑 항목은 { book, rel } (rel: "수신"=이 도시로 보낸 편지 · "기록"=이 도시에서 쓴 편지)
  function epistleBooksFor(jid, stops) {
    const bookMap = window.PAUL_EPISTLE_BOOKS || {};
    const out = [];
    stops.forEach((s) => (bookMap[jid + "-" + s.n] || []).forEach((e) => {
      const entry = typeof e === "string" ? { book: e, rel: "" } : e;
      if (!out.some((x) => x.book === entry.book && x.rel === entry.rel)) out.push(entry);
    }));
    return out;
  }
  function epistleChipsBlock(books) {
    const d = document.createElement("div");
    d.className = "detail-block";
    d.innerHTML =
      `<div class="detail-label">${iconLabel("epistle", "이 도시와 관련된 서신")}</div>` +
      `<div class="detail-value">` +
      books.map((e) =>
        `<button type="button" class="epistle-chip" data-book="${escapeHtml(e.book)}">${escapeHtml(e.book)}` +
        (e.rel ? `<i class="ep-rel${e.rel === "기록" ? " ep-rel--written" : ""}">${escapeHtml(e.rel)}</i>` : "") +
        `</button>`).join("") +
      `</div>`;
    return d;
  }
  function epistleCard(book) {
    const p = (window.PAUL_EPISTLES || {})[book];
    const card = document.createElement("div");
    card.className = "epistle-card";
    if (!p) {
      card.innerHTML = `<div class="ep-head"><span class="ep-name">${escapeHtml(book)}</span></div><div class="muted">요약 준비 중</div>`;
      return card;
    }
    card.innerHTML =
      `<div class="ep-head"><span class="ep-name">${escapeHtml(book)}</span>` +
      (p.nameEn ? `<span class="ep-en">${escapeHtml(p.nameEn)}</span>` : "") + `</div>` +
      ((p.written || p.recipient) ? `<div class="ep-meta">${escapeHtml([p.written, p.recipient].filter(Boolean).join(" · "))}</div>` : "") +
      (p.theme ? `<div class="ep-theme">${escapeHtml(p.theme)}</div>` : "") +
      `<div class="ep-summary">${escapeHtml(p.summary || "")}</div>` +
      (p.keyVerse ? `<div class="ep-verse">${escapeHtml(p.keyVerse)}</div>` : "");
    return card;
  }

  /* 한 번의 방문에 해당하는 본문 블록들을 target에 채운다 */
  function appendVisitBlocks(target, s, color, compact) {
    const story = s.story || s.event;
    if (story)
      target.appendChild(
        blockEl(iconLabel("event", compact ? "있었던 일" : "이곳에서 있었던 일"), `<span class="events">${escapeHtml(story)}</span>`)
      );
    if (s.theme && s.theme.title)
      target.appendChild(calloutEl(iconLabel("spirit", s.theme.title), s.theme.text || ""));
    target.appendChild(blockEl(iconLabel("companions", "동행자"), companionsHtml(s)));
    if (s.companionStory)
      target.appendChild(blockEl(iconLabel("coworker", "동역자 이야기"), escapeHtml(s.companionStory)));
  }

  /* 상세 패널이 열리면 가려지는 영역을 빼고 도시가 화면 중앙에 오도록 패닝.
     하드코딩된 브레이크포인트 대신, 패널의 실제 형태(하단 시트 vs 우측 시트)로 판단한다. */
  function recenterForPanel(latlng) {
    if (!latlng) return;
    try {
      const size = map.getSize();
      if (size.x < 40 || size.y < 40) return;
      const z = map.getZoom();
      const mp = map.project(latlng, z);
      const pr = detailPanel.getBoundingClientRect();
      // 패널이 화면 폭 대부분을 차지하면 하단 시트 → 위로, 아니면 우측 시트 → 왼쪽으로
      const isBottomSheet = pr.width >= window.innerWidth * 0.9;
      const shifted = isBottomSheet
        ? mp.add(L.point(0, (pr.height || size.y * 0.6) / 2))
        : mp.add(L.point((pr.width || 410) / 2, 0));
      map.panTo(map.unproject(shifted, z), { animate: true, duration: 0.55 });
    } catch (e) { /* noop */ }
  }

  function openDetail(j, stops, selIndex, grp, opts) {
    // 좀은 화면에서는 지점을 고르는 순간 지도 화면으로 넘어간다
    if (isNarrow()) showView("map");
    resetLegEmphasis(); // 도시를 선택하면 전진/귀환 강조는 해제
    const color = COLORS[j.id];
    const primary = stops[0];
    const place = placeOf(primary);

    const tag = $("dTag");
    tag.textContent = `${jLabels(j).chip} · ${(place && place.region) || "경유"}`;
    tag.style.background = color;
    $("dTitle").textContent = primary.ko;
    $("dSubtitle").textContent =
      (primary.en || "") + (stops.length > 1 ? ` · 이 여정에서 ${stops.length}회 방문` : "");

    const body = $("detailBody");
    body.innerHTML = "";

    // 위치 단위 정보: 현대 위치 · 도시 성격
    body.appendChild(blockEl(iconLabel("location", "현대 위치"), escapeHtml((place && place.modern) || "정보 없음")));
    if (place && place.character)
      body.appendChild(blockEl(iconLabel("city", "도시 성격"), escapeHtml(place.character)));

    if (stops.length === 1) {
      const s = stops[0];
      body.appendChild(
        blockEl(iconLabel("book", "성경 본문"), `<span class="scripture-chip" style="--pc:${color}" title="누르면 본문을 펼쳐 봅니다" role="button" tabindex="0">${escapeHtml(s.ref || "—")}</span>`)
      );
      appendVisitBlocks(body, s, color, false);
    } else {
      stops.forEach((s, i) => {
        // 귀환 방문은 지도 귀환선과 같은 초록으로 표시
        const vc = s.leg === "return" ? RETURN_COLOR : color;
        const card = document.createElement("div");
        card.className = "visit-card" + (i === selIndex ? " focus" : "");
        card.style.setProperty("--pc", vc);
        card.style.animationDelay = (0.1 + i * 0.07).toFixed(2) + "s";
        card.innerHTML =
          `<div class="visit-head">` +
          `<span class="visit-no" style="background:${vc}">${i + 1}</span>` +
          `<span class="visit-role">${escapeHtml(visitRole(s, i, stops.length))}</span>` +
          `<span class="visit-ref" style="color:${vc}" title="누르면 본문을 펼쳐 봅니다" role="button" tabindex="0">${escapeHtml(s.ref || "")}</span></div>`;
        appendVisitBlocks(card, s, vc, true);
        body.appendChild(card);
      });
    }

    // 도시 단위 정보: 관련 서신 (맨 아래)
    const books = epistleBooksFor(j.id, stops);
    if (books.length) body.appendChild(epistleChipsBlock(books));

    detailPanel.classList.add("open");
    detailPanel.setAttribute("aria-hidden", "false");
    const sc = detailPanel.querySelector(".detail-scroll");
    sc.scrollTop = 0;
    try { sc.focus({ preventScroll: true }); } catch (e) { /* noop */ }

    setActiveMarker(grp || (current && current.groupsByKey ? current.groupsByKey[locKey(primary)] : null));
    highlightSidebar(locKey(primary));
    // 말풍선을 함께 띄우는 경우에는 showStopPin이 자리를 잡으므로 여기서 또 밀지 않는다
    if (!(opts && opts.skipRecenter)) recenterForPanel(L.latLng(primary.lat, primary.lng));
  }

  /* 전체 보기: 한 도시를 여러 차수가 방문했을 때 차수별로 모두 표시 */
  function openDetailCombined(key) {
    const entries = allByKey ? allByKey[key] : null;
    if (!entries || !entries.length) return;
    const primary = entries[0].stops[0];
    const place = placeOf(primary);

    const tag = $("dTag");
    tag.textContent = `전체 · ${(place && place.region) || "경유"}`;
    tag.style.background = "#7b83eb";
    $("dTitle").textContent = primary.ko;
    const chips = entries.map((e) => jLabels(JOURNEYS[e.jid]).chip).join(" · ");
    $("dSubtitle").textContent =
      (primary.en || "") + (entries.length > 1 ? ` · ${chips} 방문` : "");

    const body = $("detailBody");
    body.innerHTML = "";
    body.appendChild(blockEl(iconLabel("location", "현대 위치"), escapeHtml((place && place.modern) || "정보 없음")));
    if (place && place.character)
      body.appendChild(blockEl(iconLabel("city", "도시 성격"), escapeHtml(place.character)));

    entries.forEach((e) => {
      const jr = JOURNEYS[e.jid];
      const color = e.color;
      const sec = document.createElement("div");
      sec.className = "journey-section";
      sec.innerHTML =
        `<span class="js-chip" style="background:${color}">${escapeHtml(jLabels(jr).chip)}</span>` +
        `<span class="js-title">${escapeHtml(jr.title)}</span>`;
      body.appendChild(sec);

      e.stops.forEach((s, i) => {
        // 귀환 방문은 지도 귀환선과 같은 초록으로 표시
        const vc = s.leg === "return" ? RETURN_COLOR : color;
        const card = document.createElement("div");
        card.className = "visit-card";
        card.style.setProperty("--pc", vc);
        card.innerHTML =
          `<div class="visit-head">` +
          `<span class="visit-no" style="background:${vc}">${i + 1}</span>` +
          `<span class="visit-role">${escapeHtml(visitRole(s, i, e.stops.length))}</span>` +
          `<span class="visit-ref" style="color:${vc}" title="누르면 본문을 펼쳐 봅니다" role="button" tabindex="0">${escapeHtml(s.ref || "")}</span></div>`;
        appendVisitBlocks(card, s, vc, true);
        const books = epistleBooksFor(e.jid, [s]);
        if (books.length) card.appendChild(epistleChipsBlock(books));
        body.appendChild(card);
      });
    });

    detailPanel.classList.add("open");
    detailPanel.setAttribute("aria-hidden", "false");
    const sc = detailPanel.querySelector(".detail-scroll");
    sc.scrollTop = 0;
    try { sc.focus({ preventScroll: true }); } catch (e) { /* noop */ }

    setActiveMarkers(entries.map((e) => e.marker).filter(Boolean));
    document.querySelectorAll(".stop-item.active").forEach((el) => el.classList.remove("active"));
    recenterForPanel(L.latLng(primary.lat, primary.lng));
  }

  function closeDetail() {
    detailPanel.classList.remove("open");
    detailPanel.setAttribute("aria-hidden", "true");
    // 위치 말풍선은 남겨 둔다 — 좁은 화면에서는 패널을 닫아야 지도가 보이므로,
    // 여기서 함께 닫으면 "지금 이 자리"를 확인할 기회가 사라진다.
    // 대신 그 지점이 화면 밖으로 밀려 있으면 한 번만 되돌려 준다.
    if (pendingRecenter) {
      const t = pendingRecenter;
      pendingRecenter = null;
      try {
        if (map.getCenter().distanceTo(t) > 1000) map.setView(t, map.getZoom(), { animate: false });
      } catch (e) { /* noop */ }
    }
    setActiveMarker(null);
    document.querySelectorAll(".stop-item.active").forEach((el) => el.classList.remove("active"));
  }

  function highlightSidebar(key) {
    document.querySelectorAll("#stopList .stop-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.key === key);
    });
  }

  /* ---------- 전체화면 ---------- */
  const fsBtn = $("fsBtn");
  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function toggleFullscreen() {
    const el = document.documentElement;
    if (!fsElement()) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { try { const pr = req.call(el); if (pr && pr.catch) pr.catch(() => {}); } catch (e) { /* noop */ } }
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { try { exit.call(document); } catch (e) { /* noop */ } }
    }
  }
  function onFsChange() {
    const fs = !!fsElement();
    if (fsBtn) {
      fsBtn.classList.toggle("is-fs", fs);
      fsBtn.title = fs ? "전체화면 종료" : "전체화면";
      fsBtn.innerHTML = icon(fs ? "fullscreenExit" : "fullscreen");
    }
    setTimeout(() => map.invalidateSize(false), 150);
  }
  if (fsBtn) fsBtn.onclick = toggleFullscreen;
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  /* ---------- 이벤트 바인딩 ---------- */
  // 동행자/서신 칩 클릭 → 약전·요약 카드를 해당 블록 바로 아래에 토글
  $("detailBody").addEventListener("click", function (e) {
    const chip = e.target.closest(".companion-chip, .epistle-chip");
    if (!chip) return;
    const isEpi = chip.classList.contains("epistle-chip");
    const key = (isEpi ? "e:" : "p:") + (isEpi ? chip.dataset.book : chip.dataset.person);
    const block = chip.closest(".detail-block");
    if (!block) return;
    block.querySelectorAll(".companion-chip.is-sel, .epistle-chip.is-sel").forEach((c) => c.classList.remove("is-sel"));
    const next = block.nextElementSibling;
    if (next && (next.classList.contains("person-card") || next.classList.contains("epistle-card"))) {
      const same = next.dataset.key === key;
      next.remove();
      if (same) return; // 같은 칩을 다시 누르면 닫기만
    }
    chip.classList.add("is-sel");
    const card = isEpi ? epistleCard(chip.dataset.book) : personCard(chip.dataset.person);
    card.dataset.key = key;
    block.after(card);
  });
  $("detailClose").onclick = closeDetail;
  $("helpBtn").onclick = () => ($("helpModal").hidden = false);
  $("helpClose").onclick = () => ($("helpModal").hidden = true);
  $("helpModal").onclick = (e) => { if (e.target.id === "helpModal") $("helpModal").hidden = true; };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeDetail(); $("helpModal").hidden = true; }
  });

  /* ---------- 인트로(랜딩) → 지도 진입 ---------- */
  function setupIntro() {
    const intro = $("intro");
    let started = false;

    function enterApp() {
      if (started) return;
      started = true;
      if (intro) {
        intro.classList.add("intro--hide");
        setTimeout(() => { if (intro.parentNode) intro.parentNode.removeChild(intro); }, 750);
      }
      map.invalidateSize(false);
      showView("list");  // 좁은 화면은 목록 화면부터 — 여정을 고르는 것이 첫 걸음
      selectAll(false);  // 진입 시 전체 보기를 먼저 표시(즉시 맞춤)
    }

    if (!intro) { enterApp(); return; }
    intro.addEventListener("click", enterApp);
    intro.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        enterApp();
      }
    });
  }

  /* ---------- 좁은 화면(≤960px): 목록 화면 ⇄ 지도 화면 ----------
     넓은 화면에서는 둘이 나란히 보이므로 이 전환은 동작하지 않는다. */
  const narrowMQ = window.matchMedia("(max-width: 960px)");
  const isNarrow = () => narrowMQ.matches;

  function showView(view) {
    if (!isNarrow()) { document.body.classList.remove("view-map"); return; }
    document.body.classList.toggle("view-map", view === "map");
    // 화면이 밀려 들어온 뒤 지도 크기를 다시 잡는다
    setTimeout(function () { map.invalidateSize(false); }, 360);
  }

  function setupViewSwitch() {
    const toMap = $("toMap");
    const toList = $("toList");
    if (toMap) toMap.onclick = function () { showView("map"); };
    if (toList) toList.onclick = function () { showView("list"); };
    // 넓은 화면으로 바뀌면 전환 상태를 풀어 둔다
    const onChange = function () {
      if (!isNarrow()) document.body.classList.remove("view-map");
      setTimeout(function () { map.invalidateSize(false); }, 60);
    };
    if (narrowMQ.addEventListener) narrowMQ.addEventListener("change", onChange);
    else if (narrowMQ.addListener) narrowMQ.addListener(onChange);
  }

  /* ---------- 검색 모듈 연동 API ----------
     js/search.js가 검색 결과에서 지도 위 한 정차지로 데려갈 때 사용한다.
     다른 여정에 속한 곳이면 그 여정을 먼저 켜고, 이어서 그 도시로 좁혀 들어간다. */
  /* 지도 위에 "지금 이 자리"를 찍는 말풍선 — 여정·지명·본문, 검색해 온 절이면 그 절까지 */
  function showStopPin(j, stop, verseHtml) {
    const color = COLORS[j.id];
    /* 말풍선이 잘 보이도록 지점을 한 번에 앉힌다.
       ① 지점을 화면 한가운데보다 조금 아래로 — 위로 펼쳐지는 말풍선이
          지도 위쪽의 종류 토글(현대/로마)에 가리지 않게.
       ② 상세 패널이 옆에 서는 넓은 화면에서는 지점을 왼쪽으로 — 말풍선이 패널에 물리지 않게.
          (좁은 화면의 하단 시트는 지도를 거의 덮으므로 가로 보정이 의미 없다.
           패널을 닫으면 closeDetail이 이 자리로 되돌린다.) */
    let popMaxW = 250;
    try {
      const z = map.getZoom();
      const size = map.getSize();
      const pr = detailPanel.getBoundingClientRect();
      const isBottomSheet = pr.width >= window.innerWidth * 0.9;
      const panelW = isBottomSheet ? 0 : (pr.width || 410);
      // 패널에 가리지 않는 지도 폭에 말풍선을 맞춘다(테두리·여백 몫 54px)
      const visibleW = Math.max(200, size.x - panelW);
      popMaxW = Math.min(250, Math.max(170, visibleW - 54));

      let dx = Math.round(panelW / 2);
      // 왼쪽으로 너무 밀어 말풍선이 지도 밖으로 나가지 않도록 한계를 둔다
      const half = popMaxW / 2 + 26;
      const maxDx = Math.max(0, Math.round(size.x / 2 - half - 8));
      if (dx > maxDx) dx = maxDx;

      const dy = -Math.round(size.y * 0.12);
      const pt = map.project([stop.lat, stop.lng], z).add(L.point(dx, dy));
      map.setView(map.unproject(pt, z), z, { animate: false });
    } catch (e) { /* noop */ }
    const html =
      '<div class="map-pin-card" style="--pc:' + color + '">' +
      '<div class="mp-line">' +
      '<span class="mp-badge" style="background:' + color + '">' + escapeHtml(jLabels(j).chip) + "</span>" +
      '<b class="mp-name">' + escapeHtml(stop.ko) + "</b></div>" +
      (stop.ref ? '<div class="mp-ref">' + escapeHtml(stop.ref) + "</div>" : "") +
      (verseHtml ? '<p class="mp-verse">' + verseHtml + "</p>" : "");
    try {
      const popup = L.popup({
        className: "map-pin-popup",
        closeButton: true,
        autoClose: true,
        autoPan: false,
        offset: L.point(0, -34),   // 마커와 지명 라벨을 덮지 않도록 넉넉히 띄운다
        maxWidth: popMaxW,
      })
        .setLatLng([stop.lat, stop.lng])
        .setContent(html + "</div>")
        .openOn(map);

      // 실제로 그려진 크기로 마지막 보정 — 지도가 낮은 기기(작은 폰·가로 모바일)에서는
      // 앞의 어림 배치만으로 말풍선 윗부분이 잘릴 수 있다.
      const el = popup.getElement();
      if (el) {
        const mr = map.getContainer().getBoundingClientRect();
        const pr = el.getBoundingClientRect();
        const pad = 10;
        let dx = 0, dy = 0;
        if (pr.top < mr.top + pad) dy = -((mr.top + pad) - pr.top);
        else if (pr.bottom > mr.bottom - pad) dy = pr.bottom - (mr.bottom - pad);
        if (pr.left < mr.left + pad) dx = -((mr.left + pad) - pr.left);
        else if (pr.right > mr.right - pad) dx = pr.right - (mr.right - pad);
        if (dx || dy) map.panBy([dx, dy], { animate: false });
      }
    } catch (e) { /* noop */ }
  }

  function focusStop(jid, n, opts) {
    const j = JOURNEYS[jid];
    if (!j) return;
    const stop = j.stops.filter(function (s) { return s.n === n; })[0];
    if (!stop) return;

    function openIt() {
      const grp = current && current.groupsByKey ? current.groupsByKey[locKey(stop)] : null;
      const stops = grp ? grp.stops : [stop];
      let idx = stops.indexOf(stop);
      if (idx < 0) idx = 0;
      const target = L.latLng(stop.lat, stop.lng);
      const z = Math.max(map.getZoom(), 7);
      // 애니메이션이 진행되지 않는 환경(저전력·백그라운드 탭·rAF 정지)에서도
      // 반드시 그 자리로 가야 하므로 이동은 즉시 확정한다.
      // 상세 패널에 가리지 않도록 하는 보정은 이어지는 openDetail이 부드럽게 처리한다.
      try { map.setView(target, z, { animate: false }); } catch (e) { /* noop */ }
      const pin = !!(opts && opts.pin);
      openDetail(j, stops, idx, grp, { skipRecenter: pin });
      if (pin) showStopPin(j, stop, opts.verseHtml);
      // 좁은 화면에서는 상세 패널(하단 시트)을 피하느라 지도가 크게 밀린다.
      // 패널을 닫았을 때 되돌아올 화면 위치(말풍선까지 보이는 자리)를 기억해 둔다.
      pendingRecenter = map.getCenter();
      // 상세 패널이 실제로 그려진 뒤에 할 일(본문 자동 펼침 등)
      if (opts && typeof opts.after === "function") opts.after(stop, j);
    }

    // 여정이 다르면 먼저 갈아 끼우되, 전체 맞춤은 건너뛰고 곧장 그 지점으로 들어간다
    if (activeJourney !== jid) selectJourney(jid, false, true);
    openIt();
  }

  window.ActsMap = {
    focusStop: focusStop,
    selectJourney: selectJourney,
    selectAll: selectAll,
    journeyChip: function (j) { return jLabels(j).chip; },
    getActive: function () { return activeJourney; },
    map: map,
  };

  /* ---------- 시작 ---------- */
  function init() {
    if (typeof JOURNEYS === "undefined" || typeof JOURNEY_ORDER === "undefined") {
      const banner = document.createElement("div");
      banner.className = "loading-banner";
      banner.innerHTML = `<span class="spinner"></span> 전도여행 데이터를 불러오는 중…`;
      document.querySelector(".map-wrap").appendChild(banner);
      return;
    }
    buildTabs();
    setupBaseToggle();
    setupViewSwitch();
    setupIntro();
  }

  try {
    init();
  } catch (e) {
    console.error("초기화 오류:", e && e.message, e && e.stack);
  }

  window.addEventListener("resize", function () { map.invalidateSize(false); });
  // window.resize가 오지 않는 컨테이너 크기 변화(임베드·분할 화면 등)도 감지
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(function () { map.invalidateSize(false); }).observe(document.getElementById("map"));
  }
})();
