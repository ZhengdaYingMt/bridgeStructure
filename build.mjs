import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./iso-kit.mjs";
import { kitScript } from "./inline-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DATA = JSON.parse(readFileSync(join(HERE, "sources.json"), "utf8"));
// 出处数据以 base64 内嵌进页面（引号、反斜杠都进不了 HTML 内联脚本）。
// 模板里只留 __SRC_B64__ 占位符，构建时从 sources.json 现烤——
// 面板数据与 sources.json 保持单一来源，改小程序 sources.js 后重跑
// dump-sources.js + 本脚本即可同步，不会再出现模板里烤着旧数据的事故。
const SRC_B64 = Buffer.from(JSON.stringify(SRC_DATA), "utf8").toString("base64");
const theme = process.argv.includes("--light") ? "light" : "dark";

// SCENE-BEGIN —— 场景模块：构建期与页面运行时共用（页面经 SCENE_SRC 注入）
const KX = typeof k !== "undefined" && k ? k : { iso, pathOf, segment, slabOf, planOutline, insetPlan, boxCorners, topMatrix, faceTextSvg, depthOf, solidSvg, lineSvg, fitProjection, cameraOf };
const WIDTH = 1180;
const HEIGHT = 620;
// 实测数据：赵县人民政府、中国数字科技馆公布
const TOTAL = 64.4;
const HALF = TOTAL / 2;
const SPAN = 37.02;
const RISE = 7.23;
const DECK_W = 4.5; // 桥面宽 9.0 m（半宽）
const FOOT_W = 4.8; // 拱脚处宽 9.6 m（半宽）
const RINGS = 28; // 28 道拱券纵向并列
const RING_T = 1.0; // 拱圈厚度，官方未公布，示意
const DECK_B = 8.85;
const DECK_T = 9.15;
const R_IN = (RISE * RISE + (SPAN / 2) ** 2) / (2 * RISE); // 27.31 m
const ZC = RISE - R_IN; // 拱心 z = -20.08 m
const R_OUT = R_IN + RING_T;
const R_FU = R_OUT + 0.45; // 伏石（缴背）层，厚度示意
const PHI = Math.atan2(-ZC, SPAN / 2); // 起拱角 47.33°
const RING_W = (DECK_W * 2) / RINGS;
const PULL_MAX = 6.5;
const WATER_Z = -2.2; // 常水位：起拱线下约 2.2 m，拱脚贴水，主拱洞下部通透
// 分解视图各层抬升高度
const LIFT = { fu: 2.1, wall: 3.8, deck: 6.5, rail: 9.5 };
// 敞肩小拱：靠桥堍净跨 3.81 m，近中央 2.85 m；拱脚坐在主拱拱背上
const SMALL = [
  { cx: -14.3, r: 3.81 / 2, base: 5.45 },
  { cx: -9.55, r: 2.85 / 2, base: 7.1 },
  { cx: 9.55, r: 2.85 / 2, base: 7.1 },
  { cx: 14.3, r: 3.81 / 2, base: 5.45 },
];
const smallInfo = (a) => (a.r > 1.6 ? "敞肩小拱（靠桥堍）|净跨 3.81 m，拱脚坐在主拱拱背上" : "敞肩小拱（近桥中央）|净跨 2.85 m，拱脚坐在主拱拱背上");

const FIT_PTS = [
  ...KX.boxCorners({ x: -41.5, y: -16, w: 83, d: 32 }, -3.4, 10.6),
  [-HALF, -FOOT_W, DECK_T + LIFT.rail + 1.2],
  [HALF, FOOT_W, DECK_T + LIFT.rail + 1.2],
  [-19.4, DECK_W + PULL_MAX + 0.6, 0],
  [19.4, DECK_W + PULL_MAX + 0.6, 8.4],
];
let P = KX.fitProjection(FIT_PTS, WIDTH, HEIGHT, { pad: 30, azimuth: 60, elevation: 30 });
// 阴影分档与视线由当前相机推导，轨道旋转时随 P 重算（口径同 lathe.mjs）
const LIGHT_UP = 1.2;
const SHADE_BANDS = [0, 0.2, 0.42, 0.62];
const unit3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
let V = [0, 0, 1], LT = [0, 0, 1];
function refreshLight() {
  const c = KX.cameraOf(P);
  V = [c.cosA * c.cosE, c.sinA * c.cosE, c.sinE];
  LT = unit3([-c.sinA, c.cosA, LIGHT_UP]);
}
refreshLight();

const at = (point) => KX.iso(point, P);
const S = (paths, style) => KX.solidSvg(paths, style);
const L = (d, style) => KX.lineSvg(d, style);
const depth = (point) => KX.depthOf(point, P);
const facing = (n) => dot3(n, V) > 1e-6;
const bucket = (n) => { const score = dot3(unit3(n), LT); let tone = 0; while (tone < SHADE_BANDS.length && score >= SHADE_BANDS[tone]) tone++; return tone; };
const qp = (points) => KX.pathOf(points.map(at), true);
const shadePath = (n, d) => `<path class="iso-shade" data-shade="${bucket(n)}" d="${d}"/>`;
const fillPath = (d, evenodd = false) => `<path class="iso-fill"${evenodd ? ' fill-rule="evenodd"' : ""} d="${d}"/>`;

const arcPt = (r, phi, y = 0) => [r * Math.cos(phi), y, ZC + r * Math.sin(phi)];
const ARC_STEPS = 48;

function arcPoints(r, y, steps = ARC_STEPS) {
  return Array.from({ length: steps + 1 }, (_, i) => arcPt(r, PHI + ((Math.PI - 2 * PHI) * i) / steps, y));
}

function crescentPts(y) {
  return [...arcPoints(R_IN, y), ...arcPoints(R_OUT, y).reverse()];
}

function smallArchHole({ cx, r, base }, y, steps = 20) {
  const pts = Array.from({ length: steps + 1 }, (_, i) => {
    const t = (i / steps) * Math.PI;
    return [cx - r * Math.cos(t), y, base + r * Math.sin(t)];
  });
  // 开口下缘贴主拱拱背（伏石外弧）向下开挖，取消水平槛；拱背高于原起拱处保持原底
  const zArc = (x) => ZC + Math.sqrt(Math.max(0, R_FU * R_FU - x * x));
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const x = cx + r - ((2 * r) * i) / N;
    pts.push([x, y, Math.min(zArc(x), base)]);
  }
  return pts;
}

function wallPts(y, r = R_FU) {
  const top = arcPt(r, PHI);
  return [...arcPoints(r, y).reverse(), [top[0], y, DECK_B], [-top[0], y, DECK_B]];
}

function terrainAndWater() {
  const items = [];
  items.push({ center: [0, 0, -3], svg: S(KX.slabOf({ x: -21, y: -16, w: 42, d: 32, r: 1 }, -3.4, 0.6, P, 6), { tone: "lo" }) });
  const wRect = qp([[-20.3, -15, WATER_Z], [20.3, -15, WATER_Z], [20.3, 15, WATER_Z], [-20.3, 15, WATER_Z]]);
  const wDark = qp([[-19.3, -DECK_W, WATER_Z], [19.3, -DECK_W, WATER_Z], [19.3, DECK_W, WATER_Z], [-19.3, DECK_W, WATER_Z]]);
  const water = [
    `<path class="iso-fill" d="${wRect}" style="fill:var(--anatomy-blue);opacity:.10"/>`,
    `<path class="iso-shade" data-shade="0" d="${wDark}" style="opacity:.5"/>`,
    L(wRect, { tone: "faint" }),
    L([-14, -7, 0, 7, 14].map((x) => KX.segment([x, -15, WATER_Z], [x, 15, WATER_Z], P)).join(""), { tone: "mid", flow: true }),
  ].join("");
  items.push({ center: [0, 0, WATER_Z], svg: `<g data-info="洨河|单孔长跨过河，河心不立桥墩">${water}</g>` });
  for (const sx of [-1, 1]) {
    const bank = { x: sx < 0 ? -40 : 20.5, y: -16, w: 19.5, d: 32, r: 1 };
    items.push({ center: [sx * 30, 0, -1], svg: S(KX.slabOf(bank, -3.4, 4.2, P, 6, 0.4), { tone: "lo" }) + L(KX.planOutline(KX.insetPlan(bank, 2), 0.8, P, 6), { tone: "faint" }) });
    const fill = { x: sx < 0 ? -41 : HALF, y: -6.8, w: 8.8, d: 13.6, r: 0.5 };
    items.push({ center: [sx * 36.5, 0, 3], svg: S(KX.slabOf(fill, -3.4, 12.25, P, 5, 0.3), { tone: "lo" }) });
    const road = { x: sx < 0 ? -41 : HALF, y: -DECK_W, w: 8.8, d: DECK_W * 2, r: 0.3 };
    const seams = [1, 2].map((i) => KX.segment([sx * (HALF + i * 2.9), -DECK_W, DECK_T], [sx * (HALF + i * 2.9), DECK_W, DECK_T], P)).join("");
    items.push({ center: [sx * 36.5, 0, DECK_T], svg: S(KX.slabOf(road, DECK_B, DECK_T - DECK_B, P, 4, 0.15), { tone: "mid" }) + L(seams, { tone: "faint" }) });
  }
  return items;
}

function abutments() {
  const items = [];
  for (const sx of [-1, 1]) {
    const body = { x: sx < 0 ? -HALF : 19.3, y: -FOOT_W, w: HALF - 19.3, d: FOOT_W * 2, r: 0 };
    const x0 = sx < 0 ? -HALF : 19.3;
    const x1 = sx < 0 ? -19.3 : HALF;
    const courseLines = [2, 4.6, 7].map((z) => KX.segment([x0, FOOT_W, z], [x1, FOOT_W, z], P)).join("");
    const endLines = sx > 0 ? [2, 4.6, 7].map((z) => KX.segment([HALF, -FOOT_W, z], [HALF, FOOT_W, z], P)).join("") : KX.segment([-19.3, FOOT_W, -3.2], [-19.3, FOOT_W, DECK_B], P);
    items.push({
      center: [sx * 25.7, 0, 4],
      svg: `<g data-info="桥台|拱脚处桥宽 9.6 m，大于桥面宽 9.0 m（收分）" data-foc="${(sx * 25.7).toFixed(1)},0,4" data-focr="9">${S(KX.slabOf(body, -3.2, DECK_B + 3.7, P, 5), { tone: "mid" }) + L(courseLines, { tone: "faint" }) + L(endLines, { tone: "faint" })}</g>`,
    });
    const seat = { x: sx < 0 ? -20.6 : 17.6, y: -FOOT_W, w: 3.0, d: FOOT_W * 2, r: 0.15 };
    items.push({ center: [sx * 19.1, 0, -0.25], svg: `<g data-info="拱座|主拱拱脚落脚处" data-foc="${(sx * 19.1).toFixed(1)},0,0" data-focr="4">${S(KX.slabOf(seat, -2.6, 3.1, P, 4, 0.1), { tone: "mid" })}</g>` });
  }
  return items;
}

// 透过拱口可见的远侧主拱圈面
function farBarrel() {
  const out = [];
  out.push(fillPath(qp(crescentPts(-DECK_W))));
  out.push(`<path class="iso-shade" data-shade="1" d="${qp(crescentPts(-DECK_W))}"/>`);
  out.push(L(KX.pathOf(arcPoints(R_IN, -DECK_W).map(at)), { tone: "lo" }));
  return `<g data-info="主拱圈（远侧）|圆弧坦拱：净跨 37.02 m，矢高 7.23 m，半径 27.31 m">${out.join("")}</g>`;
}

// 主拱洞内壁：透过拱口可见的拱腹暗面，可见段随视线方向实时推导（仰角低时近拱脚处可见）
function barrelInterior() {
  const y0 = -DECK_W, y1 = DECK_W, STEPS = 24;
  const out = [];
  for (let i = 0; i < STEPS; i++) {
    const p0 = PHI + ((Math.PI - 2 * PHI) * i) / STEPS;
    const p1 = PHI + ((Math.PI - 2 * PHI) * (i + 1)) / STEPS;
    const pm = (p0 + p1) / 2;
    if (!facing([-Math.cos(pm), 0, -Math.sin(pm)])) continue;
    const d = qp([arcPt(R_IN, p0, y0), arcPt(R_IN, p1, y0), arcPt(R_IN, p1, y1), arcPt(R_IN, p0, y1)]);
    out.push(`<path class="iso-shade" data-shade="0" d="${d}" style="opacity:.72"/>`);
  }
  const hit = qp([...arcPoints(R_IN, y1), [19.3, y1, WATER_Z], [-19.3, y1, WATER_Z]]);
  return `<g data-info="主拱洞 · 桥下净空|单孔过水，河心不立桥墩；洪水期主拱全断面泄流" data-foc="0,0,2.6" data-focr="11"><path d="${hit}" style="fill:transparent"/>${out.join("")}</g>`;
}

// 远侧拱上墙
function farWall() {
  const wallD = qp(wallPts(-DECK_W)) + SMALL.map((a) => qp(smallArchHole(a, -DECK_W))).join("");
  const out = [fillPath(wallD, true), `<path class="iso-shade" data-shade="2" fill-rule="evenodd" d="${wallD}"/>`];
  for (const a of SMALL) {
    out.push(L(KX.pathOf(smallArchHole(a, -DECK_W).slice(0, 21).map(at)), { tone: "faint" }));
  }
  return `<g data-info="拱上侧墙（远侧）|实肩改敞肩：省料、减重、利于泄洪">${out.join("")}</g>`;
}

// 小拱券洞：洞底填料面与洞内暗面
function tunnels() {
  return SMALL.map((a) =>
    `<g data-info="${smallInfo(a)}">` +
    `<path class="iso-shade" data-shade="0" d="${qp(smallArchHole(a, -DECK_W + 0.05))}" style="opacity:.85"/>` +
    `</g>`,
  ).join("");
}

// 主拱圈：28 道拱券逐道成形（第 1–27 道为固定切片，第 28 道可抽出），支持逐道砌筑动画
function barrelSlices() {
  const out = [];
  for (let i = 0; i < RINGS - 1; i++) {
    const y0 = -DECK_W + i * RING_W;
    const y1 = y0 + RING_W;
    const g = [];
    const BAND = 12;
    for (let s = 0; s < BAND; s++) {
      const p0 = PHI + ((Math.PI - 2 * PHI) * s) / BAND;
      const p1 = PHI + ((Math.PI - 2 * PHI) * (s + 1)) / BAND;
      const nrm = [Math.cos((p0 + p1) / 2), 0, Math.sin((p0 + p1) / 2)];
      if (!facing(nrm)) continue;
      g.push(shadePath(nrm, qp([arcPt(R_OUT, p0, y0), arcPt(R_OUT, p1, y0), arcPt(R_OUT, p1, y1), arcPt(R_OUT, p0, y1)])));
    }
    const face = qp(crescentPts(y1));
    g.push(fillPath(face), shadePath([0, 1, 0], face));
    const aIn = arcPt(R_IN, PHI);
    const aOut = arcPt(R_OUT, PHI);
    if (facing([1, 0, 0])) {
      g.push(shadePath([1, 0, 0], qp([[aIn[0], y0, aIn[2]], [aOut[0], y0, aOut[2]], [aOut[0], y1, aOut[2]], [aIn[0], y1, aIn[2]]])));
    }
    if (i > 0) g.push(L(KX.segment([aIn[0], y0, aIn[2]], [aOut[0], y0, aOut[2]], P), { tone: "faint" }));
    const rim = [
      KX.pathOf(arcPoints(R_IN, y1).map(at)),
      KX.pathOf(arcPoints(R_OUT, y1).map(at)),
      KX.segment(arcPt(R_IN, PHI, y1), arcPt(R_OUT, PHI, y1), P),
      KX.segment(arcPt(R_IN, Math.PI - PHI, y1), arcPt(R_OUT, Math.PI - PHI, y1), P),
    ];
    g.push(L(rim.join(""), { tone: "lo" }));
    out.push(`<g class="iso-solid" data-ring data-ring-i="${i + 1}" data-build="ring" data-foc="0,${((y0 + y1) / 2).toFixed(2)},4.6" data-focr="8.5" data-info="主拱圈 · 第 ${i + 1} 道|28 道拱券纵向并列砌筑 · 净跨 37.02 m · 矢高 7.23 m">${g.join("")}</g>`);
  }
  return out.join("");
}

// 近侧拱上墙面（含拱背分界线）
function nearWallFace() {
  const y = DECK_W;
  const face = qp(wallPts(y)) + SMALL.map((a) => qp(smallArchHole(a, y))).join("");
  const out = [fillPath(face, true), shadePath([0, 1, 0], face)];
  out.push(L(KX.pathOf(arcPoints(R_FU, y).map(at)), { tone: "mid" }));
  const top = arcPt(R_FU, PHI);
  out.push(
    L(
      [
        KX.segment([-top[0], y, DECK_B], [top[0], y, DECK_B], P),
        KX.segment([top[0], y, top[2]], [top[0], y, DECK_B], P),
        KX.segment([-top[0], y, top[2]], [-top[0], y, DECK_B], P),
      ].join(""),
      { tone: "lo" },
    ),
  );
  return `<g class="iso-solid" data-foc="0,${y},6.8" data-focr="13" data-info="拱上侧墙|实肩改敞肩：节省土石、减轻自重、泄洪、减小主拱变形">${out.join("")}</g>`;
}

// 四个小拱的券脸环带、灰缝与洞口轮廓
function smallArchFaces() {
  const y = DECK_W;
  return SMALL.map((a) => {
    const out = [];
    const band = KX.pathOf(smallArchHole({ ...a, r: a.r + 0.32 }, y).map(at), true) + KX.pathOf(smallArchHole(a, y).map(at), true);
    out.push(`<path class="iso-shade" data-shade="${Math.min(3, bucket([0, 1, 0]) + 1)}" fill-rule="evenodd" d="${band}"/>`);
    const seams = [];
    for (const t of [Math.PI / 6, Math.PI / 3, Math.PI / 2, (2 * Math.PI) / 3, (5 * Math.PI) / 6]) {
      seams.push(
        KX.segment(
          [a.cx - (a.r + 0.02) * Math.cos(t), y, a.base + (a.r + 0.02) * Math.sin(t)],
          [a.cx - (a.r + 0.3) * Math.cos(t), y, a.base + (a.r + 0.3) * Math.sin(t)],
          P,
        ),
      );
    }
    out.push(L(seams.join(""), { tone: "faint" }));
    out.push(L(KX.pathOf(smallArchHole(a, y).map(at), true), { tone: "mid" }));
    return `<g data-info="${smallInfo(a)}" data-foc="${a.cx},${y},${(a.base + a.r * 0.55).toFixed(2)}" data-focr="3.4">${out.join("")}</g>`;
  }).join("");
}

// 伏石（缴背）：主券背上伏石一层，联络 28 道单券成整体（梁思成《赵县大石桥即安济桥》，1934）
function fuStone() {
  const y = DECK_W;
  const band = qp([...arcPoints(R_FU, y), ...arcPoints(R_OUT, y).reverse()]);
  const out = [fillPath(band), shadePath([0, 1, 0], band)];
  const seams = [];
  for (let i = 1; i < 18; i++) {
    const phi = PHI + ((Math.PI - 2 * PHI) * i) / 18;
    seams.push(KX.segment(arcPt(R_OUT + 0.02, phi, y), arcPt(R_FU - 0.02, phi, y), P));
  }
  out.push(L(seams.join(""), { tone: "faint" }));
  out.push(L([KX.pathOf(arcPoints(R_OUT, y).map(at)), KX.pathOf(arcPoints(R_FU, y).map(at))].join(""), { tone: "lo" }));
  return `<g class="iso-solid" data-foc="0,${(y - 0.6).toFixed(2)},9.0" data-focr="6.5" data-info="伏石（缴背）|主券背上伏石一层，联络 28 道单券成整体">${out.join("")}</g>`;
}

function deck() {
  const deckPlan = { x: -HALF, y: -DECK_W, w: TOTAL, d: DECK_W * 2, r: 0.15 };
  const joints = [];
  for (let i = 1; i < 22; i++) {
    const x = -HALF + (TOTAL * i) / 22;
    joints.push(KX.segment([x, -DECK_W, DECK_T], [x, DECK_W, DECK_T], P));
  }
  for (const y of [-1.5, 1.5]) joints.push(KX.segment([-HALF, y, DECK_T], [HALF, y, DECK_T], P));
  const svg =
    S(KX.slabOf(deckPlan, DECK_B, DECK_T - DECK_B, P, 4, 0.1), { tone: "mid" }) +
    L(joints.join(""), { tone: "faint" }) +
    KX.faceTextSvg(KX.topMatrix([22, 0], DECK_T + 0.02, P, "x"), "安 济 桥", { size: 2.1, tone: "faint", anchor: "middle" });
  return `<g data-info="桥面|全长 64.4 m，宽 9.0 m，坦拱换来平缓桥面" data-foc="0,0,${DECK_T}" data-focr="13">${svg}</g>`;
}

// 栏板与望柱：全长 64.4 m，22 间
function parapet() {
  const items = [];
  for (const sy of [-1, 1]) {
    const py = sy * (DECK_W - 0.3);
    const plinth = { x: -HALF, y: py - 0.15, w: TOTAL, d: 0.3, r: 0.05 };
    items.push({ center: [0, py, 9.3], svg: S(KX.slabOf(plinth, DECK_T, 0.17, P, 3), { tone: "mid", crease: "none" }) });
    for (let i = 0; i <= 22; i++) {
      const x = -HALF + (TOTAL * i) / 22;
      const post = { x: x - 0.13, y: py - 0.13, w: 0.26, d: 0.26, r: 0.03 };
      items.push({ center: [x, py, 9.6], svg: S(KX.slabOf(post, DECK_T, 1.0, P, 2), { tone: "hi" }) });
      const cap = { x: x - 0.18, y: py - 0.18, w: 0.36, d: 0.36, r: 0.05 };
      items.push({ center: [x, py, 10.25], svg: S(KX.slabOf(cap, DECK_T + 1.0, 0.14, P, 2), { tone: "hi", crease: "none" }) });
    }
    for (let i = 0; i < 22; i++) {
      const x = -HALF + (TOTAL * i) / 22 + 0.2;
      const panel = { x, y: py - 0.07, w: TOTAL / 22 - 0.4, d: 0.14, r: 0.03 };
      items.push({ center: [x + TOTAL / 44, py, 9.7], svg: S(KX.slabOf(panel, DECK_T + 0.17, 0.72, P, 2), { tone: "mid", crease: "none" }) });
    }
  }
  return items.map((i) => i.svg).join("");
}

// 可抽出的第 28 道拱券（近侧临水一道）
function pulledRing() {
  const y0 = DECK_W - RING_W;
  const y1 = DECK_W;
  const cap = qp(crescentPts(y1));
  const stripPoly = [...arcPoints(R_OUT, y1), ...arcPoints(R_OUT, y0).reverse()];
  const out = [fillPath(cap + qp(stripPoly)), shadePath([0, 1, 0], cap)];
  for (let i = 0; i < ARC_STEPS; i++) {
    const phi0 = PHI + ((Math.PI - 2 * PHI) * i) / ARC_STEPS;
    const phi1 = PHI + ((Math.PI - 2 * PHI) * (i + 1)) / ARC_STEPS;
    const mid = (phi0 + phi1) / 2;
    const normal = [Math.cos(mid), 0, Math.sin(mid)];
    if (!facing(normal)) continue;
    out.push(shadePath(normal, qp([arcPt(R_OUT, phi0, y1), arcPt(R_OUT, phi1, y1), arcPt(R_OUT, phi1, y0), arcPt(R_OUT, phi0, y0)])));
  }
  const aIn = arcPt(R_IN, PHI);
  const aOut = arcPt(R_OUT, PHI);
  if (facing([1, 0, 0])) out.push(shadePath([1, 0, 0], qp([[aIn[0], y0, aIn[2]], [aOut[0], y0, aOut[2]], [aOut[0], y1, aOut[2]], [aIn[0], y1, aIn[2]]])));
  const seams = [];
  for (let i = 1; i < 25; i++) {
    const phi = PHI + ((Math.PI - 2 * PHI) * i) / 25;
    seams.push(KX.segment(arcPt(R_IN + 0.02, phi, y1), arcPt(R_OUT - 0.02, phi, y1), P));
  }
  // 券背上跨石缝的腰铁，每缝两组（唐·张嘉贞《安济桥铭》：“腰铁栓蹙”）
  const clamps = [];
  for (const phi of [PHI + 0.3, PHI + 0.66, Math.PI / 2, Math.PI - PHI - 0.66, Math.PI - PHI - 0.3]) {
    const dphi = 0.17 / R_OUT;
    for (const ym of [y0 + 0.09, y1 - 0.09]) {
      clamps.push(KX.segment(arcPt(R_OUT + 0.01, phi - dphi, ym), arcPt(R_OUT + 0.01, phi + dphi, ym), P));
    }
  }
  const outline = [
    KX.pathOf(arcPoints(R_IN, y1).map(at)),
    KX.pathOf(arcPoints(R_OUT, y1).map(at)),
    KX.pathOf(arcPoints(R_OUT, y0).map(at)),
    KX.segment(arcPt(R_IN, PHI, y1), arcPt(R_OUT, PHI, y1), P),
    KX.segment(arcPt(R_IN, Math.PI - PHI, y1), arcPt(R_OUT, Math.PI - PHI, y1), P),
    KX.segment(aOut, [aOut[0], y0, aOut[2]], P),
    KX.segment(arcPt(R_OUT, Math.PI - PHI, y1), arcPt(R_OUT, Math.PI - PHI, y0), P),
  ];
  return `<g class="iso-solid" data-part="ring" data-ring data-ring-i="28" data-build="ring" data-lit="" data-foc="0,10.8,3.6" data-focr="11" data-focaz="90" data-info="第 28 道拱券|券宽 9.0 m ÷ 28 ≈ 0.32 m · 券背腰铁栓蹙 · 点击抽出 / 收回">${out.join("")}${L(seams.join(""), { tone: "lo" })}${L(clamps.join(""), { tone: "hi" })}${L(outline.join(""), { tone: "hi" })}</g>`;
}

// 覆盖层辅助：屏幕空间箭头与标注文字
function arrowHead(a3, b3, s = 8) {
  const a = at(a3);
  const b = at(b3);
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const tip = `${b[0].toFixed(1)},${b[1].toFixed(1)}`;
  const w1 = `${(b[0] - s * Math.cos(ang - 0.42)).toFixed(1)},${(b[1] - s * Math.sin(ang - 0.42)).toFixed(1)}`;
  const w2 = `${(b[0] - s * Math.cos(ang + 0.42)).toFixed(1)},${(b[1] - s * Math.sin(ang + 0.42)).toFixed(1)}`;
  return `<path d="M${tip}L${w1}L${w2}Z" style="fill:var(--anatomy-strong)"/>`;
}
function lab(p3, text, dy = -8) {
  const p = at(p3);
  return `<text class="xb-lab" x="${p[0].toFixed(1)}" y="${(p[1] + dy).toFixed(1)}" text-anchor="middle">${text}</text>`;
}

// 受力演示：荷载沿拱圈以压力传至拱脚，水平推力由桥台与地基平衡
function forceOverlay() {
  const out = [];
  for (const x of [-9, 0, 9]) {
    out.push('<g data-loadx="' + x + '">' + L(KX.segment([x, 0, 11.2], [x, 0, 9.7], P), { tone: "hi", flow: true }) + arrowHead([x, 0, 11.2], [x, 0, 9.7]) + "</g>");
  }
  out.push(lab([0, 0, 11.9], "恒载与活载"));
  for (const dir of [1, -1]) {
    const phiTo = dir > 0 ? PHI : Math.PI - PHI;
    const pts = Array.from({ length: 17 }, (_, i) => arcPt(R_OUT + 0.7, Math.PI / 2 + ((phiTo - Math.PI / 2) * i) / 16, 0));
    out.push(L(KX.pathOf(pts.map(at)), { tone: "hi", flow: true }), arrowHead(pts[13], pts[16]));
    const sp = pts[16];
    out.push(
      L(KX.segment([sp[0], 0, sp[2]], [sp[0] + dir * 3.4, 0, sp[2]], P), { tone: "hi", flow: true }),
      arrowHead([sp[0], 0, sp[2]], [sp[0] + dir * 3.4, 0, sp[2]]),
    );
    out.push(L(KX.segment([dir * 25.5, 0, 8.0], [dir * 25.5, 0, -2.9], P), { tone: "hi", flow: true }), arrowHead([dir * 25.5, 0, 8.0], [dir * 25.5, 0, -2.9]));
  }
  out.push(lab([24.6, 0, 1.3], "水平推力", 18));
  out.push(lab([25.5, 0, -3.2], "传至桥台与地基", 18));
  return `<g data-mode="force" style="display:none">${out.join("")}</g>`;
}

// 泄洪演示：水位面与分洪流线由页面按水位实时生成（拖动滑杆），小拱净跨 3.81 / 2.85 m
function floodSlots() {
  return {
    far: `<g data-mode="flood" style="display:none" data-water-far></g>`,
    near: `<g data-mode="flood" style="display:none" data-water-near></g>`,
  };
}

// 测量覆盖层：净跨 / 矢高 / 全长三维尺寸线，端点落在真实轮廓上
function dimLine(a3, b3, text, dy = -9) {
  const mid = a3.map((v, i) => (v + b3[i]) / 2);
  return (
    L(KX.segment(a3, b3, P), { tone: "mid" }) +
    arrowHead(a3, b3) +
    arrowHead(b3, a3) +
    lab(mid, text, dy)
  );
}
function measureOverlay() {
  const yF = DECK_W + 3.6;
  const out = [];
  out.push(L(KX.segment([18.51, DECK_W, 0], [18.51, yF, 0.2], P) + KX.segment([-18.51, DECK_W, 0], [-18.51, yF, 0.2], P), { tone: "faint" }));
  out.push(dimLine([-18.51, yF, 0.2], [18.51, yF, 0.2], "净跨 37.02 m"));
  out.push(L(KX.segment([0, DECK_W, 7.23], [0, yF, 7.23], P), { tone: "faint" }));
  out.push(L(KX.segment([0, yF, 0.2], [0, yF, 7.23], P), { tone: "mid" }) + arrowHead([0, yF, 0.2], [0, yF, 7.23]) + arrowHead([0, yF, 7.23], [0, yF, 0.2]) + lab([-3.4, yF, 3.9], "矢高 7.23 m", -6));
  out.push(L(KX.segment([-HALF, DECK_W, DECK_T], [-HALF, DECK_W + 1.4, 12.7], P) + KX.segment([HALF, DECK_W, DECK_T], [HALF, DECK_W + 1.4, 12.7], P), { tone: "faint" }));
  out.push(dimLine([-HALF, DECK_W + 1.4, 12.7], [HALF, DECK_W + 1.4, 12.7], "全长 64.4 m（含桥堍）"));
  return `<g data-mode="dims" style="display:none">${out.join("")}</g>`;
}

// 对比覆盖层：同跨径半圆拱幽灵线，直观展示坦拱把矢高从 18.5 m 压到 7.23 m
function compareOverlay() {
  const r = SPAN / 2;
  const ghost = Array.from({ length: 41 }, (_, i) => {
    const t = (i / 40) * Math.PI;
    return [r * Math.cos(Math.PI - t), DECK_W, r * Math.sin(t)];
  });
  const out = [
    L(KX.pathOf(ghost.map(at)), { tone: "mid" }),
    dimLine([0, DECK_W, 7.23], [0, DECK_W, 18.51], "矢高多出 11.3 m"),
    lab([0, DECK_W, 19.6], "半圆拱对比 · 矢跨比 1:1", 0),
    lab([9.2, DECK_W, 5.0], "坦拱 · 矢跨比约 1:5 · 矢高 7.23 m", 0),
  ];
  return `<g data-mode="compare" style="display:none">${out.join("")}</g>`;
}

// 活载覆盖层：独轮车沿桥面往复，配合受力演示（图形随受力模式显隐，位置由页面驱动）
function cartGroup() {
  const r = 0.62;
  const cz = DECK_T + r;
  const rim = Array.from({ length: 37 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2;
    return [r * Math.cos(a), 0, cz + r * Math.sin(a)];
  });
  const hub = at([0, 0, cz]);
  const out = [];
  out.push(S(KX.slabOf({ x: -0.95, y: -0.5, w: 1.7, d: 1.0, r: 0.06 }, DECK_T + 1.15, 0.55, P, 3), { tone: "mid" }));
  out.push(L(KX.segment([-0.55, 0, DECK_T + 1.15], [-0.55, 0, DECK_T], P) + KX.segment([0.55, 0, DECK_T + 1.15], [0.55, 0, DECK_T], P), { tone: "faint" }));
  out.push(L(KX.segment([-0.5, 0, DECK_T + 1.2], [0, 0, cz], P), { tone: "mid" }));
  out.push(L(KX.pathOf(rim.map(at), true), { tone: "mid" }));
  out.push(L(KX.segment([-0.95, 0, DECK_T + 1.6], [-1.75, 0, DECK_T + 2.15], P), { tone: "mid" }));
  out.push(`<circle cx="${hub[0].toFixed(1)}" cy="${hub[1].toFixed(1)}" r="1.05" style="fill:var(--anatomy-strong)"/>`);
  const grip = at([-1.75, 0, DECK_T + 2.15]);
  out.push(`<circle cx="${grip[0].toFixed(1)}" cy="${grip[1].toFixed(1)}" r="0.8" style="fill:var(--anatomy-strong)"/>`);
  out.push(`<path data-spoke d="" style="stroke:var(--anatomy-mid);fill:none;stroke-width:.55"/>`);
  return `<g data-mode="force" style="display:none" data-part="cart" data-foc="0,0,${(DECK_T + 1.2).toFixed(2)}" data-focr="4" data-info="活载 · 独轮车|沿桥面往复 · 荷载经拱圈以压力传至两桥台">${out.join("")}</g>`;
}

function sceneBody() {
  const terrain = terrainAndWater().sort((a, b) => depth(a.center) - depth(b.center));
  const structure = abutments().sort((a, b) => depth(a.center) - depth(b.center));
  const flood = floodSlots();
  return [

    `<g data-info="河床与河岸|洨河河道，两端接桥头引道">${terrain.map((i) => i.svg).join("")}</g>`,
    flood.far,
    `<g data-layer="barrel" data-build="far">${farBarrel()}${barrelInterior()}</g>`,
    `<g data-layer="wall" data-build="far">${farWall()}${tunnels()}</g>`,
    `<g data-build="abut">${structure.map((i) => i.svg).join("")}</g>`,
    `<g data-layer="barrel">${barrelSlices()}</g>`,
    `<g data-layer="fu" data-build="fu">${fuStone()}</g>`,
    `<g data-layer="wall" data-build="wall">${nearWallFace()}${smallArchFaces()}</g>`,
    `<g data-layer="deck" data-build="deck">${deck()}</g>`,
    cartGroup(),
    `<g data-layer="rail" data-build="rail"><g data-info="栏板与望柱|全长 64.4 m 共分 22 间" data-foc="0,0,9.9" data-focr="14">${parapet()}</g></g>`,
    `<g data-part="ring-wrap">${pulledRing()}</g>`,
    forceOverlay(),
    measureOverlay(),
    compareOverlay(),
    flood.near,
  ];
}

// SCENE-END

const SCENE_FILE = readFileSync(fileURLToPath(import.meta.url), "utf8");
const SCENE_SRC = SCENE_FILE.slice(SCENE_FILE.indexOf("\n", SCENE_FILE.indexOf("// SCENE-BEGIN")) + 1, SCENE_FILE.indexOf("// SCENE-END"));

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label: "赵州桥结构剖析图：单孔坦弧敞肩石拱桥，主拱由 28 道拱券纵向并列砌筑，可抽出近侧一道观察，可分解为构造层。",
  body: sceneBody(),
});

const live = `
const stage = document.querySelector(".iso-stage");
const svg = stage.querySelector("svg");
let ringEl, readout, tip, waterSlider, cartEl, spokeEl, waterFar, waterNear;
const btns = {};
for (const b of stage.querySelectorAll(".xb-btns button")) btns[b.dataset.act] = b;
let modeEls = { force: [], flood: [], dims: [], compare: [] };
let layerGroups = {};
let buildEls = [], ringEls = [];
function queryRefs() {
  ringEl = svg.querySelector('[data-part="ring"]');
  readout = document.querySelector("[data-readout]");
  tip = stage.querySelector(".xb-tip");
  waterSlider = stage.querySelector(".xb-water");
  waterFar = svg.querySelector("[data-water-far]");
  waterNear = svg.querySelector("[data-water-near]");
  cartEl = svg.querySelector('[data-part="cart"]');
  spokeEl = svg.querySelector("[data-spoke]");
  modeEls = { force: [], flood: [], dims: [], compare: [] };
  for (const g of svg.querySelectorAll("[data-mode]")) modeEls[g.dataset.mode].push(g);
  layerGroups = {};
  for (const name of Object.keys(LIFT)) layerGroups[name] = [...svg.querySelectorAll('[data-layer="' + name + '"]')];
  buildEls = [...svg.querySelectorAll("[data-build]")];
  ringEls = buildEls.filter((g) => g.dataset.build === "ring").sort((a, b) => +a.dataset.ringI - +b.dataset.ringI);
}
queryRefs();
const still = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const REST = "28 道拱券纵向并列 · 净跨 37.02 m · 矢高 7.23 m";
const APART = "分解视图 · 栏板 → 桥面 → 拱上侧墙 → 伏石 → 主拱圈 → 桥台";
const FORCE = "受力演示 · 荷载沿拱圈以压力传至拱脚，水平推力由桥台与地基平衡";
const DIMS = "测量 · 净跨 37.02 m · 矢高 7.23 m · 全长 64.4 m（含桥堍）· 矢跨比约 1:5";
const COMPARE = "对比 · 同跨径半圆拱矢高将达 18.5 m，坦拱压到 7.23 m，桥面才得平缓";
const TOUR = [
  { text: "① 全桥 · 隋开皇至大业年间（595—605）匠师李春主持建成，是世界上现存最古老的敞肩石拱桥 · 拖拽可旋转，滚轮缩放，点击部位聚焦细看" },
  { text: "② 单孔坦拱 · 净跨 37.02 m，矢高 7.23 m，拱圈半径 27.31 m，矢跨比约 1:5", modes: { dims: true } },
  { text: "③ 坦拱之利 · 同样跨径改用半圆拱矢高将达 18.5 m，压到 7.23 m 桥面才平缓，车马上下省力", modes: { compare: true } },
  { text: "④ 敞肩小拱 ×4 · 靠拱脚净跨 3.81 m、靠桥中净跨 2.85 m，拱脚坐在主拱拱背上，为世界桥梁史首创", hl: '[data-info*="小拱"],[data-info*="敞肩"]' },
  { text: "⑤ 28 道拱券纵向并列 · 每道独立成形、可单独抽换，一道受损不致全桥倾覆（近侧一道可点击抽出）", hl: "[data-ring]", lock: true },
  { text: "⑥ 券背伏石联络 28 道单券 · 券石间腰铁栓蹙（唐·张嘉贞《安济桥铭》）", hl: '[data-info*="伏石"],[data-info*="拱券"]' },
  { text: "⑦ 受力路径 · 桥上荷载沿拱圈以压力传至拱脚，水平推力由两端桥台与地基平衡，河心不立桥墩", modes: { force: true } },
  { text: "⑧ 泄洪 · 洪水位时四个小拱辅助分洪，减冲减重（拖动右上滑杆改变水位试试）", modes: { flood: true }, water: 6.4 },
  { text: "⑨ 地位 · 1961 年列入第一批全国重点文物保护单位；1991 年被美国土木工程师学会选定为“国际土木工程历史古迹”（第 12 处）" },
];
// —— 3D 相机：方位角/仰角轨道 · 滚轮缩放 · 平移 · 部位聚焦（renderScene 随相机重建场景） ——
const CAM = { az: 60, el: 30, zoom: 1, panx: 0, pany: 0 };
const CAMT = { az: 60, el: 30, zoom: 1, panx: 0, pany: 0 };
const AZ0 = 60, EL0 = 30, AZ_MIN = 26, AZ_MAX = 94, EL_MIN = 15, EL_MAX = 56, ZOOM_MAX = 7.5;
let camDirty = false, focusPart = null, turning = false, turnClock = 0;
let dragMode = null, downMoved = 0, lastX = 0, lastY = 0, lastButton = 0, pinch0 = 0;
let curHl = null, buildOn = null, downPart = null, downRing = null, lastFocusAt = 0;
const pointers = new Map();
const buildKey = (g) => (g.dataset.ringI ? "ring" + g.dataset.ringI : g.dataset.build || "");
function computeP() {
  const base = fitProjection(FIT_PTS, WIDTH, HEIGHT, { pad: 30, azimuth: CAM.az, elevation: CAM.el });
  return { origin: [base.origin[0] + CAM.panx, base.origin[1] + CAM.pany], scale: base.scale * CAM.zoom, azimuth: CAM.az, elevation: CAM.el };
}
function applyVis() {
  for (const key of Object.keys(modeEls)) for (const g of modeEls[key]) g.style.display = mode[key] ? "" : "none";
  waterSlider.style.display = mode.flood ? "" : "none";
}
function applyClasses() {
  buildEls.forEach((g) => g.classList.toggle("off", !!(buildOn && !buildOn.has(buildKey(g)))));
  svg.querySelectorAll("[data-foc]").forEach((g) => g.classList.toggle("foc", !!focusPart && g.getAttribute("data-foc") === focusPart.foc));
  svg.classList.toggle("focusing", !!focusPart);
  svg.classList.remove("touring");
  if (curHl) { svg.classList.add("touring"); svg.querySelectorAll(curHl).forEach((g) => g.classList.add("hl")); }
  for (const key of ["force", "flood", "dims", "compare"]) btns[key].classList.toggle("on", mode[key]);
  btns.build.classList.toggle("on", building);
  btns.tour.classList.toggle("on", !!guided);
  btns.turn.classList.toggle("on", turning);
}
function renderScene() {
  P = computeP();
  refreshLight();
  svg.innerHTML = sceneBody().join("");
  queryRefs();
  applyVis();
  applyClasses();
  draw();
  fillWater();
  hideTip();
  camDirty = false;
}
function updateFocusTargets() {
  if (!focusPart) {
    CAMT.az = AZ0; CAMT.el = EL0; CAMT.zoom = 1; CAMT.panx = 0; CAMT.pany = 0;
    return;
  }
  const base = fitProjection(FIT_PTS, WIDTH, HEIGHT, { pad: 30, azimuth: CAMT.az, elevation: CAMT.el });
  const flat = iso(focusPart.c, { origin: [0, 0], scale: 1, azimuth: CAMT.az, elevation: CAMT.el });
  const zt = clamp((0.42 * Math.min(WIDTH, HEIGHT)) / (focusPart.rad * base.scale), 1.8, ZOOM_MAX);
  CAMT.zoom = zt;
  CAMT.panx = clamp(WIDTH / 2 - base.origin[0] - base.scale * zt * flat[0], -1400, 1400);
  CAMT.pany = clamp(HEIGHT / 2 - base.origin[1] - base.scale * zt * flat[1], -900, 900);
}
function focusOn(g) {
  if (!g) return;
  if (turning) toggleTurn();
  touring = false; clearTimeout(idleTimer);
  focusPart = { foc: g.getAttribute("data-foc"), rad: +(g.getAttribute("data-focr") || 6) };
  focusPart.c = focusPart.foc.split(",").map(Number);
  const focaz = g.getAttribute("data-focaz");
  if (focaz) CAMT.az = clamp(+focaz, AZ_MIN, AZ_MAX);
  lastFocusAt = performance.now();
  updateFocusTargets();
  applyClasses();
  run();
}
function unfocus() {
  if (!focusPart) return;
  focusPart = null;
  updateFocusTargets();
  applyClasses();
  clearTimeout(idleTimer); idleTimer = setTimeout(() => { touring = !still.matches && !locked && !guided && !building; clock = 0; run(); }, 2500);
  run();
}
function toggleTurn() {
  turning = !turning;
  if (turning) { endTour(true); cancelBuild(true); touring = false; }
  btns.turn.classList.toggle("on", turning);
  run();
}
function showTip(hit, event) {
  const parts = hit.getAttribute("data-info").split("|");
  tip.innerHTML = "<b></b><span></span>";
  tip.querySelector("b").textContent = parts[0];
  tip.querySelector("span").textContent = parts[1] || "";
  const stageBox = stage.getBoundingClientRect();
  tip.style.left = event.clientX - stageBox.left + "px";
  tip.style.top = event.clientY - stageBox.top + "px";
  tip.classList.add("on");
  hit.classList.add("hot");
  if (stage._hot && stage._hot !== hit) stage._hot.classList.remove("hot");
  stage._hot = hit;
}
function hideTip() {
  tip.classList.remove("on");
  if (stage._hot) { stage._hot.classList.remove("hot"); stage._hot = null; }
}

let pull = 0, target = 0, ex = 0, exTarget = 0, locked = false, frame = 0, last = 0, clock = 0, touring = true;
let visible = false, idleTimer = 0, mode = { force: false, flood: false, dims: false, compare: false };
let water = 4.2, waterClock = 0, building = false, buildLabel = "", buildTimers = [];
let guided = 0, guidedAuto = false, guidedTimer = 0, cartX = 0, cartDir = 1, spokeA = 0;
function setModes(next) {
  for (const key of Object.keys(mode)) mode[key] = !!(next && next[key]);
  applyVis();
  for (const key of ["force", "flood", "dims", "compare"]) btns[key].classList.toggle("on", mode[key]);
  if (mode.flood) fillWater();
}
const W_X = 20.3, W_Y0 = -15, W_MID = 4.4, W_Y1 = 15;
function waterPath(y0, y1, z) {
  return pathOf([[-W_X, y0, z], [W_X, y0, z], [W_X, y1, z], [-W_X, y1, z]].map((p) => iso(p, P)), true);
}
function labSvg(p3, text, dy) {
  const p = iso(p3, P);
  return '<text class="xb-lab" x="' + p[0].toFixed(1) + '" y="' + (p[1] + (dy || -8)).toFixed(1) + '" text-anchor="middle">' + text + "</text>";
}
function flowSvg(from, to, opacity, dash) {
  const a = iso(from, P), b = iso(to, P);
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const s = 6;
  const head = "M" + b[0].toFixed(1) + " " + b[1].toFixed(1) + "L" + (b[0] - s * Math.cos(ang - 0.42)).toFixed(1) + " " + (b[1] - s * Math.sin(ang - 0.42)).toFixed(1) + "L" + (b[0] - s * Math.cos(ang + 0.42)).toFixed(1) + " " + (b[1] - s * Math.sin(ang + 0.42)).toFixed(1) + "Z";
  const dashStyle = dash != null ? "stroke-dasharray:5 4;stroke-dashoffset:" + dash.toFixed(2) + ";" : "";
  return '<path class="iso-line" data-tone="hi" data-flow="" d="' + segment(from, to, P) + '" style="' + dashStyle + 'opacity:' + opacity.toFixed(2) + '"/>' +
    '<path d="' + head + '" style="fill:var(--anatomy-strong);opacity:' + opacity.toFixed(2) + '"/>';
}
function floodStage(z) {
  if (z > 8.9) return 4;
  if (z > 7.25) return 3;
  if (z > 5.6) return 2;
  if (z > 1.0) return 1;
  return 0;
}
function waveSvg(y0, z, opacity, t, amp, speed) {
  const pts = [];
  const ph = (t || 0) * (speed || 0), a = amp || 0.5;
  for (let i = 0; i <= 26; i++) {
    const x = -W_X + (2 * W_X * i) / 26;
    pts.push([x, y0 + a * Math.sin((x / W_X) * Math.PI * 2.4 - ph), z]);
  }
  return '<path class="iso-line" data-tone="hi" data-flow="" d="' + pathOf(pts.map((p) => iso(p, P))) + '" style="opacity:' + opacity.toFixed(2) + '"/>';
}
function rippleSvg(cx, y0, z, t, speed, opacity) {
  let out = "";
  for (let k = 0; k < 3; k++) {
    const r = 0.35 + (((t || 0) * (speed || 0.5) + k / 3) % 1) * 2.6;
    const fade = Math.max(0, opacity * (1 - r / 3.1));
    const pts = [];
    for (let i = 0; i <= 20; i++) {
      const an = (i / 20) * Math.PI * 2;
      pts.push([cx + r * Math.cos(an), y0 + r * Math.sin(an) * 0.85, z]);
    }
    out += '<path class="iso-line" data-tone="hi" d="' + pathOf(pts.map((p) => iso(p, P)), true) + '" style="opacity:' + fade.toFixed(2) + '"/>';
  }
  return out;
}
function fillWater() {
  const z = water, st = floodStage(z), tt = waterClock;
  const alpha = [0.10, 0.15, 0.19, 0.23, 0.28][st];
  waterFar.innerHTML = '<path class="iso-fill" d="' + waterPath(W_Y0, W_MID, z) + '" style="fill:var(--anatomy-blue);opacity:' + alpha.toFixed(2) + '"/>' +
    waveSvg(-9.2, z, 0.08 + st * 0.03, tt, 0.22 + st * 0.16, 0.7 + st * 0.5) +
    (st >= 2 ? waveSvg(-6.4, z, 0.10 + st * 0.03, tt + 1.7, 0.24 + st * 0.14, 0.8 + st * 0.5) : "");
  let flows = "";
  if (st >= 1) {
    const f = Math.min(0.9, 0.3 + (z - 1) / 4), fz = st >= 4 ? Math.min(z - 0.35, 4.4) : Math.min(z - 0.35, 2.6);
    const xs = st >= 4 ? [-11, -5.5, 0, 5.5, 11] : st >= 2 ? [-8, 0, 8] : [0];
    const off = -(tt * (1.2 + st * 0.55 + (z - 1) * 0.09) * 9) % 9;
    for (const fx of xs) flows += flowSvg([fx, -13, fz], [fx, 13, fz], f, off);
    if (st >= 2) for (const rx of [-11, 11]) flows += rippleSvg(rx, -4.6, z, tt, 0.5 + st * 0.1, 0.30) + rippleSvg(rx, 4.6, z, tt + 0.9, 0.5 + st * 0.1, 0.30);
  }
  for (const a of SMALL) {
    if (z > a.base + 0.15) {
      const f = Math.min(1, (z - a.base) / 1.5);
      flows += flowSvg([a.cx, -13, a.base + a.r * 0.45], [a.cx, 13, a.base + a.r * 0.45], f, -(tt * (1.0 + (z - a.base) * 0.4) * 9) % 9);
      const rs = 0.5 + (z - a.base) * 0.12;
      flows += rippleSvg(a.cx, -4.6, z, tt + 0.8, rs, 0.40 * f) + rippleSvg(a.cx, 4.6, z, tt + 0.3, rs, 0.40 * f);
    }
  }
  if (st >= 4) flows += rippleSvg(-19.3, 0, z, tt, 0.45, 0.34) + rippleSvg(19.3, 0, z, tt + 0.5, 0.45, 0.34);
  let waves = "";
  const nearYs = [[6.8, 10.4], [6.5, 9.8, 12.4], [6.3, 9.4, 12.0], [6.0, 9.0, 11.6, 13.8], [5.7, 8.4, 10.8, 12.8, 14.2]][st];
  nearYs.forEach((wy, i) => { waves += waveSvg(wy, z, 0.12 + st * 0.045, tt + i * 1.13, 0.30 + st * 0.13, 0.9 + st * 0.45); });
  const stageText = ["", "主拱过流 · 河心不立桥墩", "边缘小拱开始分洪", "四小拱全部分洪 · 减轻洪水侧压", "特大洪水 · 逼近平桥面"][st];
  waterNear.innerHTML =
    '<path class="iso-fill" d="' + waterPath(W_MID, W_Y1, z) + '" style="fill:var(--anatomy-blue);opacity:' + alpha.toFixed(2) + '"/>' +
    '<path d="' + waterPath(W_Y0, -4.5, z) + waterPath(4.5, W_Y1, z) + '" style="fill:none;stroke:var(--anatomy-mid);opacity:.5"/>' +
    waves + flows +
    labSvg([15.5, 12.5, z], "水位 +" + z.toFixed(1) + " m") +
    (st >= 1 ? labSvg([-13.8, 8.2, Math.min(z + 1.4, 8.4)], stageText) : "");
}
function floodLabel() {
  const s = "水位 +" + water.toFixed(1) + " m";
  if (water > 8.9) return s + " · 特大洪水逼近平桥面，全桥过流";
  if (water > 7.25) return s + " · 四小拱全部分洪";
  if (water > 5.6) return s + " · 边缘两小拱开始分洪";
  if (water > 1.0) return s + " · 主拱过流";
  return s + " · 枯水";
}
function cancelBuild(silent) {
  building = false; buildLabel = "";
  buildTimers.forEach(clearTimeout); buildTimers = [];
  buildOn = null;
  btns.build.classList.remove("on");
  buildEls.forEach((g) => g.classList.remove("off"));
  if (!silent) { draw(); run(); }
}
function startBuild() {
  if (building) { cancelBuild(); return; }
  endTour(true); cancelBuild(true);
  turning = false; btns.turn.classList.remove("on");
  building = true; buildOn = new Set(); btns.build.classList.add("on");
  locked = false; target = 0; exTarget = 0; touring = false;
  setModes({});
  buildEls.forEach((g) => g.classList.add("off"));
  draw();
  const stages = [
    ["abut", 780, "① 砌筑桥台与拱座 —— 拱脚坐于其上，水平推力由桥台与地基平衡"],
    ["fu", 430, "③ 券背伏石（缴背）一层 —— 联络 28 道单券成整体"],
    ["wall", 540, "④ 砌拱上侧墙，两肩各开两小拱（净跨 3.81 m / 2.85 m）"],
    ["deck", 470, "⑤ 铺筑桥面 —— 坦弧拱换来近乎平缓的路面"],
    ["rail", 470, "⑥ 安装栏板望柱 —— 全长 64.4 m，共分 22 间"],
  ];
  if (still.matches) {
    buildOn = null;
    buildEls.forEach((g) => g.classList.remove("off"));
    buildLabel = "建成 · 28 道拱券纵向并列砌筑";
    draw(); return;
  }
  let t = 420;
  buildTimers.push(setTimeout(() => {
    buildLabel = "② 纵向并列砌筑 28 道拱券 —— 每道宽约 0.32 m，自两拱脚向拱顶合龙";
    buildEls.forEach((g) => { if (g.dataset.build === "far") { g.classList.remove("off"); if (buildOn) buildOn.add("far"); } });
    draw();
  }, t));
  t += 360;
  ringEls.forEach((g, i) => { buildTimers.push(setTimeout(() => { g.classList.remove("off"); if (buildOn) buildOn.add(buildKey(g)); }, t + i * 95)); });
  t += ringEls.length * 95 + 320;
  for (const item of stages) {
    buildTimers.push(setTimeout(() => {
      buildLabel = item[2];
      buildEls.forEach((g) => { if (g.dataset.build === item[0]) { g.classList.remove("off"); if (buildOn) buildOn.add(buildKey(g)); } });
      draw();
    }, t));
    t += item[1];
  }
  buildTimers.push(setTimeout(() => { cancelBuild(true); draw(); }, t + 420));
}
function highlight(sel) {
  curHl = sel || null;
  svg.querySelectorAll(".hl").forEach((g) => g.classList.remove("hl"));
  if (!sel) { svg.classList.remove("touring"); return; }
  svg.classList.add("touring");
  svg.querySelectorAll(sel).forEach((g) => g.classList.add("hl"));
}
function endTour(quiet) {
  if (!guided) return;
  guided = 0; clearTimeout(guidedTimer);
  btns.tour.classList.remove("on");
  highlight(null);
  if (!quiet) { setModes({}); exTarget = 0; locked = false; target = 0; draw(); run(); }
}
function guidedStep() {
  if (guided >= TOUR.length) { endTour(); return; }
  guided += 1;
  cancelBuild(true);
  btns.tour.classList.add("on");
  const cfg = TOUR[guided - 1];
  setModes(cfg.modes || {});
  if (cfg.water != null) { water = cfg.water; waterSlider.value = String(Math.round(((water + 2.2) / 11.2) * 100)); }
  if (cfg.lock) { locked = true; target = PULL_MAX; } else { locked = false; target = 0; }
  exTarget = 0;
  highlight(cfg.hl || null);
  draw(); run();
  clearTimeout(guidedTimer);
  if (guidedAuto) guidedTimer = setTimeout(guidedStep, 7200);
}
function draw() {
  ringEl.setAttribute("transform", translateAlong(P, [0, pull, 0]));
  for (const name of Object.keys(layerGroups)) {
    const h = LIFT[name] * ex;
    for (const g of layerGroups[name]) g.setAttribute("transform", translateAlong(P, [0, 0, h]));
  }
  cartEl.setAttribute("transform", translateAlong(P, [cartX, 0, 0]));
  const r = 0.62, cz = DECK_T + r;
  const sp = (a) => iso([r * Math.cos(a), 0, cz + r * Math.sin(a)], P);
  const s1 = sp(spokeA), s2 = sp(spokeA + Math.PI), s3 = sp(spokeA + Math.PI / 2), s4 = sp(spokeA + 3 * Math.PI / 2);
  spokeEl.setAttribute("d", pathOf([s1, s2]) + pathOf([s3, s4]));
  let label;
  if (building) label = buildLabel;
  else if (guided) label = TOUR[guided - 1].text;
  else if (mode.force) label = FORCE;
  else if (mode.flood) label = floodLabel();
  else if (mode.dims) label = DIMS;
  else if (mode.compare) label = COMPARE;
  else if (ex > 0.02) label = APART;
  else if (locked) label = "第 28 道拱券 · 已抽出锁定（点击拱圈收回）";
  else if (pull >= 0.05) label = "抽出第 28 道拱券（券宽约 0.32 m）· " + pull.toFixed(1) + " m";
  else label = REST;
  if (readout.textContent !== label) readout.textContent = label;
  stage.setAttribute("aria-valuenow", String(Math.round((pull / PULL_MAX) * 100)));
  stage.setAttribute("aria-valuetext", label);
}
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  if (turning) {
    turnClock += dt;
    CAMT.az = AZ0 + 30 * Math.sin(turnClock * 0.1);
    CAMT.el = EL0 + 5 * Math.sin(turnClock * 0.061 + 1.3);
  }
  if (focusPart) updateFocusTargets();
  let camMoving = false;
  const camEase = 1 - Math.exp(-dt / 0.14);
  for (const key of ["az", "el", "zoom", "panx", "pany"]) {
    const eps = key === "zoom" ? 0.0015 : key === "panx" || key === "pany" ? 0.25 : 0.008;
    const gap = CAMT[key] - CAM[key];
    if (Math.abs(gap) > eps) { CAM[key] += gap * camEase; camMoving = true; }
    else if (CAM[key] !== CAMT[key]) { CAM[key] = CAMT[key]; camMoving = true; }
  }
  if (camMoving || camDirty) renderScene();
  if (touring && !guided && !building) {
    clock += dt;
    const wave = 0.5 + 0.5 * Math.sin(clock * 0.45 - Math.PI / 2);
    target = PULL_MAX * wave * wave * (3 - 2 * wave);
  }
  if (mode.force && !still.matches && !building) {
    cartX += cartDir * dt * 3.2;
    if (cartX > 27) { cartX = 27; cartDir = -1; }
    if (cartX < -27) { cartX = -27; cartDir = 1; }
    spokeA -= (cartDir * dt * 3.2) / 0.62;
    for (const g of svg.querySelectorAll("[data-loadx]")) {
      const lx = +g.dataset.loadx;
      const a = Math.exp(-((cartX - lx) ** 2) / 40);
      g.style.opacity = (0.15 + 0.85 * a).toFixed(3);
    }
  }
  if (mode.flood && !still.matches && !building) { waterClock += dt; fillWater(waterClock); }
  if (still.matches) { pull = target; ex = exTarget; }
  else {
    pull += (target - pull) * (1 - Math.exp(-dt / 0.45));
    ex += (exTarget - ex) * (1 - Math.exp(-dt / 0.6));
  }
  if (Math.abs(target - pull) < 0.004) pull = target;
  if (Math.abs(exTarget - ex) < 0.002) ex = exTarget;
  draw();
  const settled = !touring && pull === target && ex === exTarget && (!mode.force || still.matches) && (!mode.flood || still.matches) && !camMoving && !camDirty;
  frame = visible && !settled ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
const steer = (next) => {
  if (locked || guided || building) return;
  touring = false; target = clamp(next, 0, PULL_MAX);
  clearTimeout(idleTimer); idleTimer = setTimeout(() => { touring = !still.matches && !locked && !guided && !building; clock = 0; run(); }, 5000); run();
};
const toggleLock = () => {
  locked = !locked;
  if (locked) { touring = false; target = PULL_MAX; }
  else { target = 0; clearTimeout(idleTimer); idleTimer = setTimeout(() => { touring = !still.matches; clock = 0; run(); }, 2500); }
  run();
};
const toggleExplode = () => { exTarget = exTarget > 0.5 ? 0 : 1; btns.explode.textContent = exTarget ? "合拢" : "分解"; btns.explode.classList.toggle("on", !!exTarget); run(); };
const toggleMode = (key) => {
  cancelBuild(); endTour();
  const next = {}; for (const k of Object.keys(mode)) next[k] = mode[k];
  next[key] = !next[key];
  setModes(next); draw(); run();
};
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
if (still.matches) touring = false;
stage.addEventListener("contextmenu", (event) => event.preventDefault());
stage.addEventListener("pointerdown", (event) => {
  guidedAuto = false; clearTimeout(guidedTimer);
  if (event.target.closest && event.target.closest(".xb-btn,.xb-water")) return;
  pointers.set(event.pointerId, [event.clientX, event.clientY]);
  if (pointers.size === 2) {
    const pts = [...pointers.values()];
    pinch0 = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
    dragMode = "pinch";
    return;
  }
  dragMode = "pending"; downMoved = 0;
  lastX = event.clientX; lastY = event.clientY; lastButton = event.button;
  downPart = event.target.closest ? event.target.closest("[data-info][data-foc]") : null;
  downRing = event.target.closest ? event.target.closest("[data-ring]") : null;
  try { stage.setPointerCapture(event.pointerId); } catch (err) {}
});
stage.addEventListener("pointermove", (event) => {
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, [event.clientX, event.clientY]);
  if (dragMode === "pinch") {
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      if (pinch0 > 0 && dist > 0) { CAMT.zoom = clamp(CAMT.zoom * (dist / pinch0), 1, ZOOM_MAX); run(); }
      pinch0 = dist;
    }
    return;
  }
  if (dragMode) {
    const dx = event.clientX - lastX, dy = event.clientY - lastY;
    lastX = event.clientX; lastY = event.clientY;
    downMoved += Math.abs(dx) + Math.abs(dy);
    if (dragMode === "pending") {
      if (downMoved <= 6) return;
      dragMode = lastButton === 2 || lastButton === 1 || event.shiftKey ? "pan" : "orbit";
      hideTip();
    }
    if (dragMode === "orbit") {
      CAMT.az = clamp(CAMT.az - dx * 0.28, AZ_MIN, AZ_MAX);
      CAMT.el = clamp(CAMT.el - dy * 0.22, EL_MIN, EL_MAX);
      if (focusPart) updateFocusTargets();
    } else if (dragMode === "pan") {
      if (focusPart) { focusPart = null; applyClasses(); }
      CAMT.panx = clamp(CAMT.panx + dx * 1.4, -1400, 1400);
      CAMT.pany = clamp(CAMT.pany + dy * 1.4, -900, 900);
    }
    camDirty = true;
    run();
    return;
  }
  const hit = event.target.closest ? event.target.closest("[data-info]") : null;
  if (hit) showTip(hit, event); else hideTip();
  if (focusPart || turning || guided || building) return;
  const box = svg.getBoundingClientRect();
  steer(clamp((event.clientX - box.left) / box.width, 0, 1) * PULL_MAX);
});
function endPointer(event) {
  if (event.target.closest && event.target.closest(".xb-btn,.xb-water")) return;
  pointers.delete(event.pointerId);
  if (dragMode === "pinch") { if (pointers.size < 2) { dragMode = null; pinch0 = 0; } return; }
  const wasDrag = !!dragMode && dragMode !== "pending";
  dragMode = null;
  if (wasDrag) return;
  const ringHit = downRing, partHit = downPart;
  downRing = null; downPart = null;
  if (guided || building) return;
  if (ringHit) {
    const wasFocused = !!focusPart && focusPart.foc === ringHit.getAttribute("data-foc");
    toggleLock();
    if (wasFocused) unfocus(); else focusOn(ringHit);
    return;
  }
  if (partHit) {
    if (focusPart && focusPart.foc === partHit.getAttribute("data-foc")) unfocus();
    else focusOn(partHit);
    return;
  }
  if (focusPart) unfocus();
}
stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);
stage.addEventListener("pointerleave", () => { if (!dragMode) hideTip(); });
stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  const z0 = CAMT.zoom;
  const z1 = clamp(z0 * Math.exp(-event.deltaY * 0.0016), 1, ZOOM_MAX);
  if (z1 === z0) return;
  if (focusPart) {
    CAMT.zoom = z1;
  } else {
    const box = svg.getBoundingClientRect();
    const px = box.width ? WIDTH / box.width : 1;
    const vx = (event.clientX - box.left) * px, vy = (event.clientY - box.top) * px;
    CAMT.zoom = z1;
    CAMT.panx = clamp(CAMT.panx + (1 - z1 / z0) * (vx - (WIDTH / 2 + CAMT.panx)), -1400, 1400);
    CAMT.pany = clamp(CAMT.pany + (1 - z1 / z0) * (vy - (HEIGHT / 2 + CAMT.pany)), -900, 900);
  }
  run();
}, { passive: false });
stage.addEventListener("dblclick", (event) => {
  event.preventDefault();
  if (performance.now() - lastFocusAt < 400) return;
  if (guided || building) return;
  focusPart = null; updateFocusTargets(); applyClasses();
  turning = false; btns.turn.classList.remove("on");
  run();
});
btns.tour.addEventListener("click", (event) => { event.stopPropagation(); if (guided) guidedStep(); else { guidedAuto = !still.matches; guidedStep(); } });
btns.explode.addEventListener("click", (event) => { event.stopPropagation(); cancelBuild(); endTour(); toggleExplode(); });
for (const key of ["force", "flood", "dims", "compare"]) {
  btns[key].addEventListener("click", (event) => { event.stopPropagation(); toggleMode(key); });
}
btns.build.addEventListener("click", (event) => { event.stopPropagation(); endTour(true); startBuild(); });
btns.turn.addEventListener("click", (event) => { event.stopPropagation(); toggleTurn(); });
waterSlider.addEventListener("input", () => { water = -2.2 + (+waterSlider.value / 100) * 11.2; if (mode.flood) fillWater(); draw(); run(); });
stage.addEventListener("keydown", (event) => {
  guidedAuto = false; clearTimeout(guidedTimer);
  if (event.key === "x" || event.key === "e") { event.preventDefault(); cancelBuild(); endTour(); toggleExplode(); return; }
  if (event.key === "f") { event.preventDefault(); toggleMode("force"); return; }
  if (event.key === "w") { event.preventDefault(); toggleMode("flood"); return; }
  if (event.key === "m") { event.preventDefault(); toggleMode("dims"); return; }
  if (event.key === "c") { event.preventDefault(); toggleMode("compare"); return; }
  if (event.key === "b") { event.preventDefault(); endTour(true); startBuild(); return; }
  if (event.key === "t") { event.preventDefault(); if (guided) guidedStep(); else { guidedAuto = false; guidedStep(); } return; }
  if (event.key === "r" || event.key === "R") { event.preventDefault(); toggleTurn(); return; }
  if (event.key === "k") { event.preventDefault(); togglePresent(); return; }
  if (event.key === "q") { event.preventDefault(); toggleQuiz(); return; }
  if (event.key === "s") { event.preventDefault(); toggleSrc(); return; }
  if (event.key === "Escape" && srcPanel.classList.contains("on")) { event.preventDefault(); closeSrc(); return; }
  if (event.key === "Escape") {
    event.preventDefault(); endTour(); cancelBuild();
    locked = false; touring = false; target = 0; if (exTarget) toggleExplode(); setModes({});
    turning = false; btns.turn.classList.remove("on");
    focusPart = null; updateFocusTargets(); applyClasses();
    clearTimeout(idleTimer); idleTimer = setTimeout(() => { touring = !still.matches && !locked && !guided && !building; clock = 0; run(); }, 2500);
    run(); return;
  }
  let next = null;
  if (event.key === "ArrowRight" || event.key === "ArrowUp") next = target + 0.65;
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = target - 0.65;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = PULL_MAX;
  if (next === null) return;
  event.preventDefault(); steer(next);
});

/* ---- 出处面板 ---- */
const srcPanel = stage.querySelector('.xb-src');
const srcTabsEl = srcPanel.querySelector('.xb-src-tabs');
const srcBodyEl = srcPanel.querySelector('.xb-src-body');
const SRC = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('__SRC_B64__'), c => c.charCodeAt(0))));
let srcTab = 0;
function srcRender() {
  srcTabsEl.innerHTML = '';
  SRC.TABS.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'xb-src-tab' + (i === srcTab ? ' on' : '');
    b.textContent = t; b.type = 'button';
    b.addEventListener('click', (ev) => { ev.stopPropagation(); srcTab = i; srcRender(); });
    srcTabsEl.appendChild(b);
  });
  srcBodyEl.innerHTML = '';
  if (srcTab < 4) {
    SRC.GROUPS.filter((g) => g.tab === SRC.TABS[srcTab]).forEach((g) => {
      const div = document.createElement('div'); div.className = 'xb-src-grp';
      const h = document.createElement('h4'); h.textContent = g.g;
      const f = document.createElement('p'); f.className = 'from'; f.textContent = g.from;
      div.append(h, f);
      const rows = document.createElement('div'); rows.className = 'xb-src-rows';
      g.rows.forEach((r) => { const n = document.createElement('span'); n.className = 'n'; n.textContent = r.n; const v = document.createElement('span'); v.className = 'v'; v.textContent = r.v; rows.append(n, v); });
      div.appendChild(rows); srcBodyEl.appendChild(div);
    });
  } else {
    const ul = document.createElement('ul'); ul.className = 'xb-src-annals';
    SRC.ANNALS.forEach((a) => { const li = document.createElement('li'); const y = document.createElement('span'); y.className = 'y'; y.textContent = a.y; const t = document.createElement('span'); t.className = 't'; t.textContent = a.t; const s = document.createElement('span'); s.className = 's'; s.textContent = a.s; li.append(y, t, s); ul.appendChild(li); });
    srcBodyEl.appendChild(ul);
  }
}
function openSrc() { srcPanel.classList.add('on'); btns.src.classList.add('on'); srcRender(); }
function closeSrc() { srcPanel.classList.remove('on'); btns.src.classList.remove('on'); }
function toggleSrc() { srcPanel.classList.contains('on') ? closeSrc() : openSrc(); }
btns.src.addEventListener('click', (event) => { event.stopPropagation(); toggleSrc(); });
srcPanel.addEventListener('click', (event) => { if (event.target.closest('.xb-src-close')) { event.stopPropagation(); closeSrc(); } });

const QUIZ_DATA = [
  {q:'为什么四个小拱开在拱肩而不是拱顶？',opts:['拱顶受力最大，不能开洞','拱肩挖空省料、分洪，拱顶开洞会削弱主拱','为了好看，对称美观'],a:1,why:'拱肩是压力最低的区域，挖去石料既减轻自重又增加过水断面；拱顶是拱轴的关键截面，开洞会破坏力线。'},
  {q:'洪水上涨时，水最先从哪对小拱漫过？',opts:['靠拱脚的外侧小拱','靠拱顶的内侧小拱','四孔同时'],a:0,why:'外侧小拱券脚落在主拱背上较低处（3.91 m），内侧较高（6.05 m）。水位先过外侧券脚，所以外侧先过水。'},
  {q:'拱桥的水平推力最后由谁顶住？',opts:['拱顶的伏石','两岸的桥台和地基','腰铁和铁梁'],a:1,why:'拱把竖向荷载转为沿拱轴的压力，传到拱脚后由桥台承担，再由砂土地基平衡。赵州桥桥台直接砌在粗砂上，千年不倒。'}
];
const quizPanel = stage.querySelector('.xb-quiz');
let quizIdx = 0, quizPick = null;
function quizRender() {
  const item = QUIZ_DATA[quizIdx];
  quizPanel.querySelector('.q').textContent = item.q;
  const optsEl = quizPanel.querySelector('.opts');
  optsEl.innerHTML = '';
  item.opts.forEach((o, i) => {
    const b = document.createElement('button'); b.className = 'opt'; b.type = 'button'; b.textContent = o;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); quizPick = i; quizRender(); });
    optsEl.appendChild(b);
  });
  [...optsEl.children].forEach((b, i) => {
    if (quizPick === null) return;
    if (i === item.a) b.classList.add('right');
    else if (i === quizPick) b.classList.add('wrong');
  });
  const whyEl = quizPanel.querySelector('.why');
  const nextEl = quizPanel.querySelector('.next');
  const doneEl = quizPanel.querySelector('.done');
  if (quizPick !== null) { whyEl.hidden = false; whyEl.textContent = item.why; nextEl.hidden = false; nextEl.textContent = quizIdx + 1 < QUIZ_DATA.length ? '下一题' : '完成'; }
  else { whyEl.hidden = true; nextEl.hidden = true; }
  doneEl.hidden = true;
}
function openQuiz() { quizPanel.classList.add('on'); btns.quiz.classList.add('on'); quizIdx = 0; quizPick = null; quizRender(); }
function closeQuiz() { quizPanel.classList.remove('on'); btns.quiz.classList.remove('on'); }
function toggleQuiz() { quizPanel.classList.contains('on') ? closeQuiz() : openQuiz(); }
quizPanel.querySelector('.next').addEventListener('click', (ev) => { ev.stopPropagation(); if (quizIdx + 1 < QUIZ_DATA.length) { quizIdx++; quizPick = null; quizRender(); } else { const d = quizPanel.querySelector('.done'); d.hidden = false; d.textContent = '三题完成！回到场景里再看看：拱肩的小拱为什么比拱顶的开口大，洪水先从哪孔漫过，水平推力往哪里走。'; quizPanel.querySelector('.why').hidden = true; quizPanel.querySelector('.next').hidden = true; } });
btns.quiz.addEventListener('click', (event) => { event.stopPropagation(); toggleQuiz(); });

/* ---- 放映模式 ---- */
let presenting = false;
function togglePresent() {
  presenting = !presenting;
  stage.classList.toggle('presenting', presenting);
  btns.present.classList.toggle('on', presenting);
  btns.present.textContent = presenting ? '退出放映' : '放映';
  if (presenting) {
    document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
  } else if (document.fullscreenElement) {
    document.exitFullscreen && document.exitFullscreen().catch(() => {});
  }
}
btns.present.addEventListener('click', (event) => { event.stopPropagation(); togglePresent(); });

setModes({});
fillWater();
draw();
`;

const extraCss = `
.iso-stage{position:relative;outline-offset:4px}
.xb-btns{position:absolute;top:10px;right:10px;z-index:2;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;max-width:min(92vw,540px)}
.xb-btn{font:11px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;color:var(--anatomy-muted);background:var(--anatomy-card);border:1px solid var(--anatomy-faint);border-radius:4px;padding:8px 12px;cursor:pointer}
.xb-btn:hover{color:var(--anatomy-strong);border-color:var(--anatomy-mid)}
.xb-btn:active{transform:translateY(1px)}
.xb-btn:focus-visible{outline:2px solid var(--anatomy-blue);outline-offset:1px}
.xb-btn.on{color:var(--anatomy-strong);border-color:var(--anatomy-lit)}
.xb-water{position:absolute;top:46px;right:10px;z-index:2;width:172px;accent-color:var(--anatomy-lit);display:none}
.xb-lab{font:10.5px/1.4 ui-monospace,Menlo,monospace;fill:var(--anatomy-strong);paint-order:stroke;stroke:var(--anatomy-card);stroke-width:3px;letter-spacing:.04em}
.xb-tip{position:absolute;z-index:2;pointer-events:none;transform:translate(14px,-130%);font:11px/1.6 ui-monospace,Menlo,monospace;color:var(--anatomy-text);background:var(--anatomy-card);border:1px solid var(--anatomy-faint);border-radius:4px;padding:5px 9px;white-space:nowrap;opacity:0;transition:opacity .15s}
.xb-tip.on{opacity:1}
.xb-tip b{display:block;color:var(--anatomy-strong);font-weight:600}
.xb-tip span{color:var(--anatomy-muted)}
[data-ring]{cursor:pointer}
[data-info].hot .iso-edge{stroke:var(--anatomy-lit)}
[data-info].hl .iso-edge{stroke:var(--anatomy-lit)}
svg.touring [data-info]:not(.hl){opacity:.3}
[data-build]{transition:opacity .38s ease}
[data-build].off{opacity:0}
.iso-stage{touch-action:none;cursor:grab}
.iso-stage:active{cursor:grabbing}
[data-info]{transition:opacity .3s}
svg.focusing [data-info]:not(.foc){opacity:.55}
[data-info].foc .iso-top,[data-info].foc .iso-edge,[data-info].foc .iso-line{stroke:var(--anatomy-lit)}



/* 放映模式：全屏放大、隐藏角落说明、按钮自动淡出 */
.iso-stage.presenting{outline-offset:0}
.iso-stage.presenting .iso-plate-corner[data-corner="fig"],.iso-stage.presenting .iso-plate-corner[data-corner="title"],.iso-stage.presenting .iso-plate-corner[data-corner="hint"],.iso-stage.presenting .iso-plate-corner[data-corner="readout"]{opacity:0;pointer-events:none;transition:opacity .4s}
.iso-stage.presenting .iso-legend{opacity:0;pointer-events:none;transition:opacity .4s}
.iso-stage.presenting .xb-btns{opacity:0;pointer-events:none;transition:opacity .4s}
.iso-stage.presenting .xb-btns:hover,.iso-stage.presenting .xb-btns:focus-within{opacity:1;pointer-events:auto}
.iso-stage.presenting svg{transform:scale(1.12);transform-origin:center center;transition:transform .5s ease}
/* 考考你 */
.xb-quiz{position:absolute;z-index:3;top:8px;left:8px;max-width:min(94vw,420px);margin:0 auto;background:var(--anatomy-card);border:1px solid var(--anatomy-faint);border-radius:6px;font:11px/1.7 ui-monospace,Menlo,monospace;color:var(--anatomy-text);box-shadow:0 4px 18px rgba(0,0,0,.12);display:none;padding:10px 14px}
.xb-quiz.on{display:block}
.xb-quiz .q{color:var(--anatomy-strong);font-weight:600;margin-bottom:6px}
.xb-quiz .opt{display:block;width:100%;text-align:left;padding:5px 8px;margin:2px 0;background:none;border:1px solid var(--anatomy-faint);border-radius:4px;color:var(--anatomy-muted);font:11px/1.6 ui-monospace,Menlo,monospace;cursor:pointer}
.xb-quiz .opt:hover{color:var(--anatomy-strong);border-color:var(--anatomy-mid)}
.xb-quiz .opt.right{color:#6c6;border-color:#4a4;background:rgba(68,170,68,.08)}
.xb-quiz .opt.wrong{color:#c66;border-color:#a44;background:rgba(170,68,68,.08)}
.xb-quiz .why{margin-top:6px;padding:6px 8px;background:rgba(255,255,255,.04);border-radius:4px;color:var(--anatomy-muted);font-size:10.5px;line-height:1.65}
.xb-quiz .done{margin-top:6px;color:var(--anatomy-muted);line-height:1.65}
.xb-quiz .next{margin-top:8px;text-align:center;padding:6px;border:1px solid var(--anatomy-faint);border-radius:4px;color:var(--anatomy-strong);cursor:pointer}
.xb-quiz .next:hover{border-color:var(--anatomy-mid)}
/* 数据出处面板：底部抽屉，五栏标签切换 */
.xb-src{position:absolute;z-index:3;bottom:8px;left:8px;right:8px;max-width:min(94vw,680px);margin:0 auto;background:var(--anatomy-card);border:1px solid var(--anatomy-faint);border-radius:6px;font:11px/1.7 ui-monospace,Menlo,monospace;color:var(--anatomy-text);box-shadow:0 4px 18px rgba(0,0,0,.12);display:none;flex-direction:column;max-height:72vh;overflow:hidden}
.xb-src.on{display:flex}
.xb-src-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px 6px;border-bottom:1px solid var(--anatomy-faint);flex-shrink:0}
.xb-src-head b{color:var(--anatomy-strong);font-weight:600;letter-spacing:.06em}
.xb-src-close{background:none;border:none;color:var(--anatomy-muted);font-size:16px;cursor:pointer;padding:0 4px;line-height:1}
.xb-src-close:hover{color:var(--anatomy-strong)}
.xb-src-tabs{display:flex;flex-wrap:wrap;gap:0;padding:0 8px;border-bottom:1px solid var(--anatomy-faint);flex-shrink:0}
.xb-src-tab{font:10.5px/1 ui-monospace,Menlo,monospace;letter-spacing:.05em;color:var(--anatomy-muted);background:none;border:none;border-bottom:2px solid transparent;padding:7px 10px 6px;cursor:pointer}
.xb-src-tab:hover{color:var(--anatomy-strong)}
.xb-src-tab.on{color:var(--anatomy-strong);border-bottom-color:var(--anatomy-lit)}
.xb-src-body{overflow-y:auto;padding:8px 12px 10px;flex:1;min-height:0}
.xb-src-grp{margin-bottom:8px}
.xb-src-grp:last-child{margin-bottom:0}
.xb-src-grp h4{margin:0 0 3px;font-size:11px;font-weight:600;color:var(--anatomy-strong);letter-spacing:.04em}
.xb-src-grp .from{margin:0 0 5px;font-size:10px;line-height:1.65;color:var(--anatomy-muted)}
.xb-src-rows{display:grid;grid-template-columns:88px 1fr;gap:1px 10px;font-size:10.5px;line-height:1.7}
.xb-src-rows .n{color:var(--anatomy-muted);text-align:right;white-space:nowrap}
.xb-src-rows .v{color:var(--anatomy-text)}
.xb-src-annals{list-style:none;margin:0;padding:0;font-size:10.5px;line-height:1.75}
.xb-src-annals li{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid var(--anatomy-faint)}
.xb-src-annals li:last-child{border-bottom:none}
.xb-src-annals .y{flex-shrink:0;width:76px;text-align:right;color:var(--anatomy-strong);font-weight:600}
.xb-src-annals .t{flex:1;color:var(--anatomy-text)}
.xb-src-annals .s{flex-shrink:0;width:170px;color:var(--anatomy-muted);font-size:9.5px;padding-top:2px}
/* 底部角落分层：快捷键两行在上，动态读数独占底行，避免长文案互压 */
.iso-plate{padding-bottom:118px}
.iso-plate-corner[data-corner="hint"]{white-space:pre-line;line-height:1.9;bottom:50px;max-width:100%}
.iso-plate-corner[data-corner="readout"]{bottom:12px;left:0;right:0;text-align:right;white-space:normal;line-height:1.6}
.iso-legend{gap:10px}
.iso-keys{gap:8px 26px}
@media (max-width:560px){.iso-plate{padding-bottom:148px}.iso-plate-corners{display:flex;flex-direction:column;justify-content:flex-end;gap:10px}.iso-plate-corner[data-corner="fig"],.iso-plate-corner[data-corner="title"]{position:absolute}.iso-plate-corner[data-corner="hint"],.iso-plate-corner[data-corner="readout"]{position:static;white-space:normal;line-height:1.6;text-align:left}}
`;

const body = k.plateHtml({
  fig: "Fig 1",
  title: "赵州桥 · 结构剖析",
  hint: "拖拽旋转 · 滚轮缩放 · 双指缩放 · 点击部位聚焦 · 悬停注解 · 点券抽出\nT 导览 · X 分解 · F 受力 · W 泄洪 · M 测量 · C 对比 · B 建造 · R 旋转 · S 出处 · Q 考考你 · K 放映",
  readout: "28 道拱券纵向并列 · 净跨 37.02 m · 矢高 7.23 m",
  keys: [
    { mark: "lit", label: "第 28 道拱券：9.0 m 桥面宽分作 28 道（每道约 0.32 m），券石间腰铁栓蹙" },
    { mark: "mid", label: "敞肩小拱 ×4：靠拱脚净跨 3.81 m，靠桥中净跨 2.85 m，世界桥梁史首创" },
    { mark: "raised", label: "伏石（缴背）：券背上伏石一层，联络 28 道单券成整体" },
    { mark: "flat", label: "桥面宽 9.0 m，至两侧拱脚处加宽到 9.6 m（收分）" },
  ],
  caption:
    "隋开皇至大业年间（公元 595—605 年），匠师李春在洨河上建成安济桥（赵州桥）：单孔坦弧敞肩石拱桥，全长 64.4 m（含桥堍，桥身 50.82 m），净跨 37.02 m，矢高 7.23 m（矢跨比约 1:5，拱圈半径 27.31 m），河心不立桥墩。主拱 28 道拱券纵向并列砌筑，两肩各开两小拱（靠拱脚净跨 3.81 m、靠桥中 2.85 m），洪水时辅助分洪。券石间腰铁栓蹙（唐·张嘉贞《安济桥铭》），券背上施伏石联络各道单券（梁思成《赵县大石桥即安济桥》，1934）。1961 年列入国务院公布的第一批全国重点文物保护单位；1991 年被美国土木工程师学会（ASCE）选定为“国际土木工程历史古迹”（第 12 处）。尺寸据赵县人民政府、石家庄市人民政府、中国数字科技馆公布数据及茅以升《中国石拱桥》；拱圈厚度、小拱矢高、砌缝分块与洪水位为示意。",
  body: `<div class="iso-stage" tabindex="0" role="slider" aria-label="赵州桥拱券抽出程度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><style>${extraCss}</style><div class="xb-btns"><button class="xb-btn" type="button" data-act="tour">导览</button><button class="xb-btn" type="button" data-act="explode">分解</button><button class="xb-btn" type="button" data-act="force">受力</button><button class="xb-btn" type="button" data-act="flood">泄洪</button><button class="xb-btn" type="button" data-act="dims">测量</button><button class="xb-btn" type="button" data-act="compare">对比</button><button class="xb-btn" type="button" data-act="build">建造</button><button class="xb-btn" type="button" data-act="turn">旋转</button><button class="xb-btn" type="button" data-act="src">出处</button><button class="xb-btn" type="button" data-act="quiz">考考你</button><button class="xb-btn" type="button" data-act="present">放映</button></div><input class="xb-water" type="range" min="0" max="100" value="57" aria-label="洪水水位"><div class="xb-tip"><b></b><span></span></div><div class="xb-src" role="dialog" aria-label="数据出处"><div class="xb-src-head"><b>数据出处</b><button class="xb-src-close" type="button" aria-label="关闭">×</button></div><div class="xb-src-tabs"></div><div class="xb-src-body"></div></div><div class="xb-quiz" role="dialog" aria-label="考考你"><div class="q"></div><div class="opts"></div><div class="why" hidden></div><div class="next" hidden></div><div class="done" hidden></div></div>${svg}</div>`,
});

writeFileSync(join(HERE, theme === "light" ? "zhaozhou-bridge-light.html" : "zhaozhou-bridge.html"), k.pageHtml({ title: "赵州桥 · 结构剖析", theme, body, script: (kitScript() + SCENE_SRC + live).replace("__SRC_B64__", SRC_B64), width: 1180 }));
console.log("wrote", theme === "light" ? "zhaozhou-bridge-light.html" : "zhaozhou-bridge.html");

