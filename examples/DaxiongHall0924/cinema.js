// DaxiongHall0924 cinema layer: camera presets, a choreographed tour, time-of-day presets, hide-UI,
// fullscreen and screenshots. The camera is driven only through the scene's declared properties
// (camX/camY/camZ/camHeading/camPitch/camFov bound to the CameraView), so the engine and the SSDL
// stay the single source of truth; the page never touches native camera state directly.
(() => {
  "use strict";
  const SHOTS = window.CINEMA_SHOTS || {};
  const ANCHOR = { lon: 121.55, lat: 29.87, h: 10 };
  const M_LAT = 111320;
  const M_LON = 111320 * Math.cos(ANCHOR.lat * Math.PI / 180);
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const wrap180 = (d) => ((d + 540) % 360) - 180;

  function lookAt(p, target) {
    const dx = target[0] - p[0], dy = target[1] - p[1], dz = target[2] - p[2];
    return { heading: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, pitch: Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI };
  }

  // ---------------------------------------------------------------- camera I/O
  let lastWritten = null;
  function livePose() {
    try {
      const camera = window.GlobalViewer?.scene?.mainCamera;
      if (!camera) return lastWritten;
      const controller = camera.cameraController();
      const carto = controller.positionCartographic;
      const deg = carto && typeof carto.toDegrees === "function" ? carto.toDegrees() : null;
      const lon = deg?.longitude ?? deg?.lon, lat = deg?.latitude ?? deg?.lat, h = deg?.height ?? carto?.height;
      const pose = {
        x: (lon - ANCHOR.lon) * M_LON, y: (lat - ANCHOR.lat) * M_LAT, z: h - ANCHOR.h,
        heading: ((controller.heading * 180 / Math.PI) % 360 + 360) % 360,
        pitch: wrap180(controller.pitch * 180 / Math.PI), fov: camera.fieldOfView,
      };
      for (const handle of [deg, carto]) if (handle && typeof handle.delete === "function") handle.delete();
      return [pose.x, pose.y, pose.z, pose.heading, pose.pitch, pose.fov].every(Number.isFinite) ? pose : lastWritten;
    } catch (_) { return lastWritten; }
  }
  function writePose(p) {
    lastWritten = p;
    const logic = window.SSWorld?.logical;
    if (!logic) return;
    try {
      logic.writeBatch({ camX: +p.x.toFixed(3), camY: +p.y.toFixed(3), camZ: +p.z.toFixed(3),
        camHeading: +(((p.heading % 360) + 360) % 360).toFixed(3), camPitch: +p.pitch.toFixed(3), camFov: +p.fov.toFixed(2) });
    } catch (_) { /* a hot reload is swapping the generation; the next frame writes again */ }
  }
  const shotPose = (s) => ({ x: s.pos[0], y: s.pos[1], z: s.pos[2], heading: s.heading, pitch: s.pitch, fov: s.fov });

  // ---------------------------------------------------------------- flights between presets
  let motion = null;   // { kind: "flight" | "tour", ... }
  function stopMotion() {
    if (!motion) return;
    const wasTour = motion.kind === "tour";
    motion = null;
    if (wasTour) endTour();
  }
  function flyTo(target, ms) {
    const from = livePose();
    if (!from) { writePose(target); return; }
    const dist = Math.hypot(target.x - from.x, target.y - from.y, target.z - from.z);
    const dur = ms ?? clamp(1500 + dist * 18, 1600, 4200);
    const dh = wrap180(target.heading - from.heading);
    const lift = Math.min(dist * 0.12, 18);
    stopMotion();
    motion = {
      kind: "flight", start: performance.now(), dur,
      step(t) {
        const k = ease(t);
        writePose({
          x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k,
          z: from.z + (target.z - from.z) * k + lift * Math.sin(Math.PI * k),
          heading: from.heading + dh * k, pitch: from.pitch + (target.pitch - from.pitch) * k,
          fov: from.fov + (target.fov - from.fov) * k,
        });
      },
    };
  }

  // ---------------------------------------------------------------- the tour
  // Keyframes in scene metres: position, aim point, horizontal fov, and optionally the clock (minutes).
  const TOUR = [
    { t: 0, p: [-160, -175, 95], a: [0, 40, 8], f: 48, tod: 570, cap: "宁波 · 群山之间", sub: "A DOUBLE-EAVE BUDDHA HALL IN THE HILLS OF NINGBO" },
    { t: 9, p: [-82, -112, 52], a: [0, 36, 8], f: 50 },
    { t: 17, p: [-4, -66, 7], a: [0, 30, 9], f: 54, cap: "中轴 · 神道", sub: "THE AXIS: PLAZA, STAIRS, CENSER, HALL" },
    { t: 24, p: [0, -30, 2.0], a: [0, 30, 9.5], f: 58 },
    { t: 30, p: [-12.6, -10.2, 1.5], a: [-9.8, -4.6, 1.1], f: 46, cap: "汉白玉栏 · 抱鼓石", sub: "CARVED MARBLE BALUSTRADES AND DRUM STONES" },
    { t: 37, p: [-6.5, 1.5, 3.3], a: [0, 7.5, 3.0], f: 50, cap: "香火", sub: "INCENSE RISING FROM THE BRONZE CENSER" },
    { t: 44, p: [-9.5, 16.5, 3.4], a: [0, 27, 6.8], f: 56, cap: "斗拱 · 彩画 · 格扇", sub: "BRACKET SETS, PAINTED BEAMS, LATTICE DOORS" },
    { t: 51, p: [5, 18.5, 4.2], a: [0, 28.2, 12.4], f: 46, tod: 600, cap: "大雄宝殿", sub: "HALL OF THE GREAT HERO" },
    { t: 58, p: [7, 17.5, 10.2], a: [14.5, 27, 12.6], f: 56, tod: 900, cap: "重檐庑殿 · 飞檐翘角", sub: "TWO EAVES, FOUR SWEEPING CORNERS" },
    { t: 66, p: [42, -12, 30], a: [0, 34, 9], f: 55, tod: 990 },
    { t: 75, p: [64, -62, 44], a: [0, 36, 7], f: 50, tod: 1040, cap: "暮色四合", sub: "DUSK SETTLES OVER THE MONASTERY" },
    { t: 82, p: [24, -30, 14], a: [0, 22, 6], f: 54, tod: 1080 },
    { t: 90, p: [6, 13.5, 3.6], a: [-2, 26, 5.4], f: 52, tod: 1170, cap: "灯火", sub: "LANTERNS AT NIGHT" },
    { t: 99, p: [0, -24, 1.8], a: [0, 30, 9], f: 62 },
  ].map((k) => ({ ...k, ...lookAt(k.p, k.a) }));
  for (let i = 1; i < TOUR.length; i++) TOUR[i].heading = TOUR[i - 1].heading + wrap180(TOUR[i].heading - TOUR[i - 1].heading);
  const TOUR_LEN = TOUR[TOUR.length - 1].t;

  function cr(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  function tourPose(sec) {
    let i = 0;
    while (i < TOUR.length - 2 && TOUR[i + 1].t <= sec) i++;
    const k0 = TOUR[Math.max(0, i - 1)], k1 = TOUR[i], k2 = TOUR[i + 1], k3 = TOUR[Math.min(TOUR.length - 1, i + 2)];
    const u = clamp((sec - k1.t) / (k2.t - k1.t), 0, 1);
    const s = u * u * (3 - 2 * u) * 0.35 + u * 0.65;   // a touch of ease at each key, never a stop
    const c = (f) => cr(f(k0), f(k1), f(k2), f(k3), s);
    return { x: c((k) => k.p[0]), y: c((k) => k.p[1]), z: Math.max(0.8, c((k) => k.p[2])), heading: c((k) => k.heading),
      pitch: c((k) => k.pitch), fov: c((k) => k.f) };
  }
  function tourClock(sec) {
    const keys = TOUR.filter((k) => k.tod !== undefined);
    if (sec <= keys[0].t) return keys[0].tod;
    for (let i = 0; i < keys.length - 1; i++) {
      if (sec <= keys[i + 1].t) { const u = (sec - keys[i].t) / (keys[i + 1].t - keys[i].t); return keys[i].tod + (keys[i + 1].tod - keys[i].tod) * u; }
    }
    return keys[keys.length - 1].tod;
  }

  let savedClock = null;
  function startTour() {
    stopMotion();
    savedClock = Number($("time-slider")?.value ?? 570);
    document.body.classList.add("cine-touring");
    let lastCap = -1, lastClock = -1;
    motion = {
      kind: "tour", start: performance.now(), dur: TOUR_LEN * 1000,
      step(t) {
        const sec = t * TOUR_LEN;
        writePose(tourPose(sec));
        const clock = Math.round(tourClock(sec));
        if (Math.abs(clock - lastClock) >= 2) { lastClock = clock; setClock(clock, false); }
        let ci = -1;
        TOUR.forEach((k, idx) => { if (k.cap && k.t <= sec) ci = idx; });
        if (ci !== lastCap) { lastCap = ci; showCaption(ci >= 0 && sec - TOUR[ci].t < 6.5 ? TOUR[ci] : null); }
        else if (ci >= 0 && sec - TOUR[ci].t > 6.5) showCaption(null);
        $("cine-progress-bar").style.transform = `scaleX(${t})`;
      },
      done() { stopMotion(); },
    };
  }
  function endTour() {
    document.body.classList.remove("cine-touring");
    showCaption(null);
    if (savedClock !== null) { setClock(savedClock, true); savedClock = null; }
  }
  let captionShown = null;
  function showCaption(k) {
    if (k === captionShown) return;
    captionShown = k;
    const box = $("cine-caption");
    box.classList.remove("show");
    if (!k) return;
    setTimeout(() => {
      if (captionShown !== k) return;
      $("cine-caption-title").textContent = k.cap;
      $("cine-caption-sub").textContent = k.sub || "";
      box.classList.add("show");
    }, 380);
  }

  function frame(now) {
    if (motion) {
      const t = clamp((now - motion.start) / motion.dur, 0, 1);
      motion.step(t);
      if (t >= 1) { if (motion.done) motion.done(); else motion = null; }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- time of day
  // The page's own slider owns the clock; presets move it and let its handlers write the scene.
  function setClock(minutes, commit) {
    const slider = $("time-slider");
    if (!slider || slider.disabled) return;
    slider.value = String(Math.round(clamp(minutes, 0, 1440)));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    if (commit) slider.dispatchEvent(new Event("change", { bubbles: true }));
    markClock();
  }
  const CLOCKS = [["清晨", 410], ["上午", 570], ["正午", 740], ["黄昏", 1045], ["夜晚", 1170]];
  function markClock() {
    const v = Number($("time-slider")?.value);
    document.querySelectorAll("[data-clock]").forEach((b) => b.classList.toggle("on", Math.abs(Number(b.dataset.clock) - v) < 3));
    const label = $("cine-clock");
    if (label && Number.isFinite(v)) label.textContent = `${String(Math.floor(v / 60) % 24).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
  }

  // ---------------------------------------------------------------- screenshot
  async function screenshot() {
    const S = window.SSWorldEngine;
    const box = $("screen")?.getBoundingClientRect();
    if (!S?.saveImage2Base64 || !S?.ByteArray?.fromPtr || !window.GlobalViewer || !box?.width) return toast("引擎尚未就绪");
    const dpr = window.devicePixelRatio || 1;
    const w = Math.min(3840, Math.round(box.width * dpr)), h = Math.min(2160, Math.round(box.height * dpr));
    toast("正在截图…");
    const text = await new Promise((resolve) => {
      let done = false;
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, 15000);
      try {
        S.saveImage2Base64(w, h, "PNG").then((ptr) => {
          if (done) return;
          done = true;
          try {
            const addr = typeof ptr === "bigint" ? Number(ptr) : ptr;
            const arr = S.ByteArray.fromPtr(addr);
            const data = arr && typeof arr.data === "function" ? arr.data() : null;
            resolve(data && data.length ? new TextDecoder().decode(new Uint8Array(data)) : null);
          } catch (_) { resolve(null); }
        });
      } catch (_) { done = true; resolve(null); }
    });
    if (!text || !text.startsWith("iVBOR")) return toast("截图失败，请保持页面可见后重试");
    const a = document.createElement("a");
    a.href = `data:image/png;base64,${text}`;
    a.download = `大雄宝殿-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    a.click();
    toast("截图已保存");
  }

  // ---------------------------------------------------------------- UI plumbing
  let toastTimer = 0;
  function toast(text) {
    const el = $("cine-toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }
  function toggleHidden(force) {
    const hide = force ?? !document.body.classList.contains("cine-hidden");
    document.body.classList.toggle("cine-hidden", hide);
    if (hide) toast("按 H 显示界面");
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast("浏览器拒绝了全屏"));
  }

  function build() {
    const shots = $("cine-shots");
    Object.entries(SHOTS).forEach(([key, s], i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cine-chip";
      b.dataset.shot = key;
      b.innerHTML = `<kbd>${i + 1}</kbd>${s.label}`;
      b.addEventListener("click", () => { flyTo(shotPose(s)); markShot(key); });
      shots.appendChild(b);
    });
    const clocks = $("cine-clocks");
    CLOCKS.forEach(([label, m]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cine-clock-btn";
      b.dataset.clock = String(m);
      b.textContent = label;
      b.addEventListener("click", () => setClock(m, true));
      clocks.appendChild(b);
    });
    $("cine-tour").addEventListener("click", () => (motion?.kind === "tour" ? stopMotion() : startTour()));
    $("cine-stop").addEventListener("click", stopMotion);
    $("cine-hide").addEventListener("click", () => toggleHidden(true));
    $("cine-show").addEventListener("click", () => toggleHidden(false));
    $("cine-full").addEventListener("click", toggleFullscreen);
    $("cine-shot").addEventListener("click", screenshot);
    $("time-slider")?.addEventListener("input", markClock);
    // A drag or wheel on the scene hands the camera back to the viewer at once.
    const screen = $("screen");
    ["pointerdown", "wheel"].forEach((ev) => screen.addEventListener(ev, () => { if (motion) stopMotion(); markShot(null); }, { passive: true }));
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      const keys = Object.keys(SHOTS);
      if (/^[1-9]$/.test(e.key) && keys[Number(e.key) - 1]) { const k = keys[Number(e.key) - 1]; flyTo(shotPose(SHOTS[k])); markShot(k); }
      else if (e.key === "t" || e.key === "T") (motion?.kind === "tour" ? stopMotion() : startTour());
      else if (e.key === "h" || e.key === "H") toggleHidden();
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if (e.key === "p" || e.key === "P") screenshot();
      else if (e.key === "Escape") { stopMotion(); toggleHidden(false); }
      else return;
      e.preventDefault();
    });
    setInterval(markClock, 1000);
  }
  function markShot(key) {
    document.querySelectorAll("[data-shot]").forEach((b) => b.classList.toggle("on", b.dataset.shot === key));
  }
  window.SSWorldCinema = { flyTo: (k) => flyTo(shotPose(SHOTS[k])), startTour, stopMotion, setClock, screenshot, tourPose };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
