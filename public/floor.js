/* The 3D warehouse floor. Rebuilds itself from the warehouse layout; knows nothing about the API. */
const FLOOR = (() => {
  const G = { ok: false, mode: 'over', az: 2.25, phi: 0.98, r: 31, yaw: Math.PI / 2, pitch: 0, keys: {}, slots: {}, stacks: {}, outl: {}, lay: null, onPick: () => {} };
  const BW = 1.7, LH = 1.7, GAP = 5.2;
  const PALETTE = [0xc9a26b, 0x4f9d8f, 0xb5483a, 0x7d6bb0, 0x4a4f57, 0x5b8fc7, 0xa3a84a, 0xc77aa0];
  const code = (a, b, l) => String.fromCharCode(64 + a) + '-' + String(b).padStart(2, '0') + '-' + l;
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function geo() {
    const l = G.lay, L = l.bays * BW, n = l.aisles;
    return { L, n, X0: -L / 2 - 3, rowZ: i => (i - (n - 1) / 2) * GAP, H: l.levels * LH + 0.25, dockX: L / 2 + 13, halfZ: Math.max(n * GAP / 2 + 4, 9) };
  }
  function binPos(c) { const [a, b, l] = c.split('-'), g = geo(); return { x: g.X0 + (+b - 0.5) * BW, y: (+l - 1) * LH, z: g.rowZ(a.charCodeAt(0) - 65) }; }

  function init(canvas, opts) {
    G.onPick = opts.onPick; G.hintEl = opts.hintEl; G.dpad = opts.dpad;
    if (typeof THREE === 'undefined') return false;
    let R; try { R = new THREE.WebGLRenderer({ canvas, antialias: true }); } catch (e) { return false; }
    R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(52, 1, 0.1, 400); cam.rotation.order = 'YXZ';
    scene.add(new THREE.HemisphereLight(0xffffff, 0x70767e, 0.62));
    const sun = new THREE.DirectionalLight(0xffffff, 0.42); sun.position.set(-12, 30, 14); scene.add(sun);
    const M = c => new THREE.MeshLambertMaterial({ color: c });
    Object.assign(G, { R, scene, cam, canvas, ray: new THREE.Raycaster(), unit: new THREE.BoxGeometry(1, 1, 1),
      mat: { floor: M(0xb4bcc4), blue: M(0x1f56a8), orange: M(0xe2661a), wood: M(0xa9825a), yellow: M(0xf2c318), wall: M(0x8c959e), door: M(0xd9dee3), dark: M(0x23282e), white: M(0xf2f4f5), fork: M(0xe8a90a),
        ghost: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), sel: new THREE.LineBasicMaterial({ color: 0xffffff }), hint: new THREE.LineBasicMaterial({ color: 0xffd21f }) },
      cat: PALETTE.map(M) });
    G.edges = new THREE.EdgesGeometry(G.unit);
    const theme = () => { const sky = new THREE.Color(css('--scene-sky') || '#dfe5ea'); scene.background = sky; scene.fog = new THREE.Fog(sky, 90, 260); G.mat.floor.color.set(css('--scene-floor') || '#b4bcc4'); };
    theme(); matchMedia('(prefers-color-scheme:dark)').addEventListener('change', theme);
    const size = () => { const f = canvas.parentElement, w = f.clientWidth, h = f.clientHeight; if (!w || !h) return; R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); };
    size(); new ResizeObserver(size).observe(canvas.parentElement);

    let down = null;
    canvas.addEventListener('pointerdown', e => { down = { px: e.clientX, py: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; });
    canvas.addEventListener('pointermove', e => {
      if (!down) return; const dx = e.clientX - down.px, dy = e.clientY - down.py; down.px = e.clientX; down.py = e.clientY; down.moved += Math.abs(dx) + Math.abs(dy);
      if (G.mode === 'over') { G.az += dx * 0.006; G.phi = Math.max(0.25, Math.min(1.45, G.phi - dy * 0.005)); } else { G.yaw += dx * 0.004; G.pitch = Math.max(-1.1, Math.min(1.1, G.pitch + dy * 0.004)); }
    });
    const up = e => {
      if (!down) return; const d = down; down = null; canvas.style.cursor = 'grab';
      if (d.moved < 7 && e.type === 'pointerup') {
        const r = canvas.getBoundingClientRect();
        G.ray.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1, y: -((e.clientY - r.top) / r.height * 2 - 1) }, cam);
        const hit = G.ray.intersectObjects(Object.values(G.slots))[0]; if (hit) G.onPick(hit.object.userData.bin);
      }
    };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', e => { if (G.mode !== 'over') return; e.preventDefault(); G.r = Math.max(10, Math.min(G.rMax || 60, G.r + e.deltaY * 0.03)); }, { passive: false });
    const typing = () => /INPUT|SELECT|TEXTAREA/.test((document.activeElement || {}).tagName || '');
    const kmap = { w: 'w', a: 'a', s: 's', d: 'd', arrowup: 'w', arrowleft: 'a', arrowdown: 's', arrowright: 'd' };
    addEventListener('keydown', e => { const k = kmap[e.key.toLowerCase()]; if (k && G.mode === 'walk' && !typing() && !canvas.closest('[hidden]')) { G.keys[k] = 1; if (e.key.startsWith('Arrow')) e.preventDefault(); } });
    addEventListener('keyup', e => { const k = kmap[e.key.toLowerCase()]; if (k) G.keys[k] = 0; });
    G.dpad.querySelectorAll('button').forEach(b => { const k = b.dataset.k; b.addEventListener('pointerdown', e => { e.preventDefault(); G.keys[k] = 1; }); for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => G.keys[k] = 0); });

    const still = matchMedia('(prefers-reduced-motion:reduce)').matches; let last = performance.now();
    (function loop(now) {
      requestAnimationFrame(loop); const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!G.lay || canvas.closest('[hidden]')) return;
      const g = G.g;
      if (G.mode === 'over') { const r = G.r * Math.max(1, 1.25 / cam.aspect), sp = Math.sin(G.phi); cam.position.set(G.cx + r * sp * Math.cos(G.az), 1.5 + r * Math.cos(G.phi), r * sp * Math.sin(G.az)); cam.lookAt(G.cx, 1.5, 0); }
      else {
        const f = (G.keys.w || 0) - (G.keys.s || 0), s = (G.keys.d || 0) - (G.keys.a || 0), v = 5.5 * dt, p = cam.position;
        const dx = (-Math.sin(G.yaw) * f + Math.cos(G.yaw) * s) * v, dz = (-Math.cos(G.yaw) * f - Math.sin(G.yaw) * s) * v;
        if (!blocked(p.x + dx, p.z)) p.x += dx; if (!blocked(p.x, p.z + dz)) p.z += dz; p.y = 1.7; cam.rotation.set(-G.pitch, G.yaw, 0);
      }
      if (!still && G.fk) { const t = now / 1000 * 0.22, a = g.X0 + 1, b = g.dockX - 4; G.fk.position.x = (a + b) / 2 + (b - a) / 2 * Math.sin(t); G.fk.rotation.y = Math.cos(t) > 0 ? 0 : Math.PI; }
      R.render(scene, cam);
    })(last);
    G.ok = true; setMode('over'); return true;
  }
  function blocked(x, z) {
    const g = G.g; if (x < g.X0 - 4.4 || x > g.dockX - 0.9 || Math.abs(z) > g.halfZ - 0.5) return true;
    for (let i = 0; i < g.n; i++) if (x > g.X0 - 0.4 && x < g.X0 + g.L + 0.4 && Math.abs(z - g.rowZ(i)) < 1) return true;
    return false;
  }

  /** Rebuild racks, floor and dock for a layout {aisles, bays, levels}. */
  function setLayout(lay) {
    if (!G.ok) return;
    const key = [lay.aisles, lay.bays, lay.levels].join('x'); if (G.key === key) return; G.key = key; G.lay = lay;
    if (G.world) G.scene.remove(G.world);
    const world = G.world = new THREE.Group(); G.scene.add(world);
    const g = G.g = geo(), m = G.mat;
    const box = (w, h, d, mat, x, y, z, par) => { const o = new THREE.Mesh(G.unit, mat); o.scale.set(w, h, d); o.position.set(x, y, z); (par || world).add(o); return o; };
    const fx0 = g.X0 - 5, fx1 = g.dockX; G.cx = (fx0 + fx1) / 2;
    box(fx1 - fx0, 0.2, g.halfZ * 2, m.floor, G.cx, -0.1, 0);
    G.slots = {}; G.stacks = {}; G.outl = {};
    for (let a = 1; a <= lay.aisles; a++) {
      const z = g.rowZ(a - 1);
      for (let k = 0; k <= lay.bays; k++) for (const s of [-0.58, 0.58]) box(0.09, g.H, 0.09, m.blue, g.X0 + k * BW, g.H / 2, z + s);
      for (let l = 1; l <= lay.levels; l++) for (const s of [-0.58, 0.58]) box(g.L, 0.12, 0.07, m.orange, g.X0 + g.L / 2, l * LH - 0.06, z + s);
      const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
      c.fillStyle = '#1f56a8'; c.fillRect(0, 0, 128, 128); c.fillStyle = '#fff'; c.font = '700 92px "Barlow Condensed",Arial,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String.fromCharCode(64 + a), 64, 70);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv) })); sp.scale.set(1.5, 1.5, 1); sp.position.set(g.X0 - 1, g.H + 1, z); world.add(sp);
      for (let b = 1; b <= lay.bays; b++) for (let l = 1; l <= lay.levels; l++) {
        const id = code(a, b, l), p = binPos(id);
        const s = box(BW - 0.14, LH - 0.22, 1.2, m.ghost, p.x, p.y + (LH - 0.22) / 2, p.z); s.userData.bin = id; G.slots[id] = s;
        const o = new THREE.LineSegments(G.edges, m.hint); o.scale.set(BW - 0.1, LH - 0.2, 1.26); o.position.copy(s.position); o.visible = false; world.add(o); G.outl[id] = o;
        const grp = new THREE.Group(); grp.position.set(p.x, p.y, p.z); box(1.2, 0.14, 1.0, m.wood, 0, 0.07, 0, grp); grp.userData.load = box(1.1, 1, 0.94, G.cat[0], 0, 0.64, 0, grp); grp.visible = false; world.add(grp); G.stacks[id] = grp;
      }
    }
    box(0.3, 5.4, g.halfZ * 2, m.wall, g.dockX + 0.15, 2.7, 0);
    for (const k of [-0.6, 0, 0.6]) box(0.34, 3.7, 3.4, m.door, g.dockX + 0.15, 1.85, k * g.halfZ);
    const sx0 = g.X0 + g.L + 4, sx1 = g.dockX - 3, sz = Math.min(6.5, g.halfZ - 2);
    for (const z of [-sz, sz]) box(sx1 - sx0, 0.02, 0.12, m.yellow, (sx0 + sx1) / 2, 0.01, z);
    for (const x of [sx0, sx1]) box(0.12, 0.02, sz * 2, m.yellow, x, 0.01, 0);
    const tx = g.dockX + 5; box(8.5, 2.9, 2.6, m.white, tx, 2.6, 0); box(2, 2.4, 2.5, m.blue, tx + 5.4, 1.6, 0);
    for (const x of [tx - 2.7, tx + 2.3, tx + 5.4]) for (const z of [-1.2, 1.2]) box(1, 1, 0.4, m.dark, x, 0.5, z);
    const fk = G.fk = new THREE.Group(); box(1.5, 0.8, 1.05, m.fork, 0, 0.65, 0, fk); box(0.9, 0.08, 1, m.dark, -0.1, 2.05, 0, fk);
    for (const x of [-0.5, 0.3]) for (const z of [-0.46, 0.46]) box(0.06, 1, 0.06, m.dark, x, 1.55, z, fk);
    box(0.12, 2.5, 0.9, m.dark, 0.85, 1.3, 0, fk); for (const z of [-0.28, 0.28]) box(1.1, 0.06, 0.12, m.dark, 1.45, 0.12, z, fk);
    for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) box(0.5, 0.5, 0.2, m.dark, x, 0.25, z, fk);
    box(1.0, 0.14, 0.9, m.wood, 1.45, 0.22, 0, fk); box(0.95, 0.7, 0.85, G.cat[0], 1.45, 0.64, 0, fk);
    fk.position.set(0, 0, g.rowZ(0) + GAP / 2); world.add(fk);
    G.r = Math.max(g.L + 20, g.n * GAP + 16) * 0.85; G.rMax = G.r * 1.8;
    G.walkStart = new THREE.Vector3(g.dockX - 6, 1.7, g.n > 1 ? g.rowZ(0) + GAP / 2 : g.rowZ(0) + 2.6);
    if (G.mode === 'walk') { G.cam.position.copy(G.walkStart); G.yaw = Math.PI / 2; G.pitch = 0; }
  }

  /** bins: Map code -> {fill 0..1, cat index} for occupied bins. hints: Set of codes. sel: code or null. */
  function update(bins, hints, sel) {
    if (!G.ok || !G.lay) return;
    for (const id in G.stacks) {
      const b = bins.get(id), g = G.stacks[id]; g.visible = !!b;
      if (b) { const h = 0.25 + 1.05 * Math.min(1, b.fill), ld = g.userData.load; ld.scale.y = h; ld.position.y = 0.14 + h / 2; ld.material = G.cat[b.cat % G.cat.length]; }
      const o = G.outl[id]; o.visible = id === sel || hints.has(id); o.material = id === sel ? G.mat.sel : G.mat.hint;
    }
  }
  function setMode(m) {
    if (m === 'walk' && G.mode !== 'walk' && G.walkStart) { G.cam.position.copy(G.walkStart); G.yaw = Math.PI / 2; G.pitch = 0; }
    G.mode = m; G.dpad.hidden = m !== 'walk';
    G.hintEl.textContent = m === 'over' ? 'Drag to turn the view · scroll to zoom · click a pallet position' : 'W A S D or the arrow pad to move · drag to look · click a pallet position';
  }
  function flyTo(id) { if (!G.ok || G.mode !== 'walk' || !G.slots[id]) return; const p = binPos(id); G.cam.position.set(p.x, 1.7, p.z + 2.5); G.yaw = 0; G.pitch = -Math.atan2(p.y + 0.7 - 1.7, 2.5); }
  return { init, setLayout, update, setMode, flyTo };
})();
