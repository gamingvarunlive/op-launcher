/* Skin3D - tiny WebGL Minecraft skin viewer (no dependencies).
 *
 *   const v = new Skin3D(canvas);
 *   await v.setSkin(dataUrl);     // 64x64 or legacy 64x32 PNG, classic or slim arms
 *   v.setPaused(true/false);      // stop rendering when the view is hidden
 *   v.setPerf(true/false);        // performance mode: no idle animation / auto rotate
 *
 * Drag with the mouse to rotate. Rotates slowly by itself when idle.
 */
(function () {
  'use strict';

  // ---------------- small matrix helpers (column-major) ----------------
  const M = {
    ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          let s = 0;
          for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
          o[c * 4 + r] = s;
        }
      }
      return o;
    },
    trans(x, y, z) { const m = M.ident(); m[12] = x; m[13] = y; m[14] = z; return m; },
    rotX(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); },
    rotY(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); },
    rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    persp(fov, aspect, n, f) {
      const t = 1 / Math.tan(fov / 2);
      return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]);
    }
  };

  // ---------------- shaders ----------------
  const VS = [
    'attribute vec3 aPos; attribute vec3 aNormal; attribute vec2 aUv;',
    'uniform mat4 uProj; uniform mat4 uView; uniform mat4 uPart; uniform mat4 uRot;',
    'varying vec2 vUv; varying float vLight;',
    'void main(){',
    '  gl_Position = uProj * uView * uPart * vec4(aPos, 1.0);',
    '  vec3 n = normalize((uRot * uPart * vec4(aNormal, 0.0)).xyz);',
    '  vec3 L = normalize(vec3(0.35, 0.75, 0.65));',
    '  vLight = 0.58 + 0.42 * max(dot(n, L), 0.0);',
    '  vUv = aUv;',
    '}'
  ].join('\n');

  const FS = [
    'precision mediump float;',
    'uniform sampler2D uTex; uniform float uBase;',
    'varying vec2 vUv; varying float vLight;',
    'void main(){',
    '  vec4 c = texture2D(uTex, vUv);',
    '  if (uBase < 0.5 && c.a < 0.5) discard;',
    '  gl_FragColor = vec4(c.rgb * vLight, 1.0);',
    '}'
  ].join('\n');

  // ---------------- box geometry ----------------
  // Each face: normal, 4 corners (TL, TR, BR, BL) as sign triples, and which skin region it samples.
  const FACES = [
    { n: [0, 0, 1],  c: [[-1, 1, 1], [1, 1, 1], [1, -1, 1], [-1, -1, 1]],       uv: 'front' },
    { n: [0, 0, -1], c: [[1, 1, -1], [-1, 1, -1], [-1, -1, -1], [1, -1, -1]],   uv: 'back' },
    { n: [-1, 0, 0], c: [[-1, 1, -1], [-1, 1, 1], [-1, -1, 1], [-1, -1, -1]],   uv: 'right' },
    { n: [1, 0, 0],  c: [[1, 1, 1], [1, 1, -1], [1, -1, -1], [1, -1, 1]],       uv: 'left' },
    { n: [0, 1, 0],  c: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],       uv: 'top' },
    { n: [0, -1, 0], c: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]],   uv: 'bottom' }
  ];

  function faceRect(face, ox, oy, w, h, d) {
    switch (face) {
      case 'top': return [ox + d, oy, w, d];
      case 'bottom': return [ox + d + w, oy, w, d];
      case 'right': return [ox, oy + d, d, h];
      case 'front': return [ox + d, oy + d, w, h];
      case 'left': return [ox + d + w, oy + d, d, h];
      default: return [ox + 2 * d + w, oy + d, w, h]; // back
    }
  }

  // Appends 36 vertices (8 floats each: pos, normal, uv) for one box.
  function pushBox(out, cx, cy, cz, w, h, d, ox, oy, grow) {
    const hx = w / 2 + grow, hy = h / 2 + grow, hz = d / 2 + grow;
    const EPS = 0.02;
    for (const f of FACES) {
      const [rx, ry, rw, rh] = faceRect(f.uv, ox, oy, w, h, d);
      const u0 = (rx + EPS) / 64, u1 = (rx + rw - EPS) / 64;
      const v0 = (ry + EPS) / 64, v1 = (ry + rh - EPS) / 64;
      const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      const verts = f.c.map((s, i) => [cx + s[0] * hx, cy + s[1] * hy, cz + s[2] * hz, f.n[0], f.n[1], f.n[2], uvs[i][0], uvs[i][1]]);
      for (const i of [0, 1, 2, 0, 2, 3]) out.push(...verts[i]);
    }
  }

  // Build all parts. Returns { data: Float32Array, draws: [{first, count, part, base}] }
  function buildModel(slim) {
    const aw = slim ? 3 : 4;
    const ax = 4 + aw / 2; // arm centre distance from the middle
    const parts = [
      { id: 'head',  pivot: [0, 24, 0],     boxes: [{ c: [0, 28, 0],  s: [8, 8, 8],   uv: [0, 0],   g: 0,    base: true }, { c: [0, 28, 0],  s: [8, 8, 8],   uv: [32, 0],  g: 0.5,  base: false }] },
      { id: 'body',  pivot: [0, 18, 0],     boxes: [{ c: [0, 18, 0],  s: [8, 12, 4],  uv: [16, 16], g: 0,    base: true }, { c: [0, 18, 0],  s: [8, 12, 4],  uv: [16, 32], g: 0.25, base: false }] },
      { id: 'armR',  pivot: [-ax, 22, 0],   boxes: [{ c: [-ax, 18, 0], s: [aw, 12, 4], uv: [40, 16], g: 0,    base: true }, { c: [-ax, 18, 0], s: [aw, 12, 4], uv: [40, 32], g: 0.25, base: false }] },
      { id: 'armL',  pivot: [ax, 22, 0],    boxes: [{ c: [ax, 18, 0],  s: [aw, 12, 4], uv: [32, 48], g: 0,    base: true }, { c: [ax, 18, 0],  s: [aw, 12, 4], uv: [48, 48], g: 0.25, base: false }] },
      { id: 'legR',  pivot: [-2, 12, 0],    boxes: [{ c: [-2, 6, 0],   s: [4, 12, 4],  uv: [0, 16],  g: 0,    base: true }, { c: [-2, 6, 0],   s: [4, 12, 4],  uv: [0, 32],  g: 0.25, base: false }] },
      { id: 'legL',  pivot: [2, 12, 0],     boxes: [{ c: [2, 6, 0],    s: [4, 12, 4],  uv: [16, 48], g: 0,    base: true }, { c: [2, 6, 0],    s: [4, 12, 4],  uv: [0, 48],  g: 0.25, base: false }] }
    ];
    const floats = [];
    const draws = [];
    parts.forEach((p, pi) => {
      for (const b of p.boxes) {
        const first = floats.length / 8;
        pushBox(floats, b.c[0], b.c[1], b.c[2], b.s[0], b.s[1], b.s[2], b.uv[0], b.uv[1], b.g);
        draws.push({ first, count: floats.length / 8 - first, part: pi, base: b.base });
      }
    });
    return { data: new Float32Array(floats), draws, parts };
  }

  // ---------------- skin texture helpers ----------------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('skin image failed to load'));
      img.src = src;
    });
  }

  function flipCopy(ctx, x, y, w, h, dx, dy) {
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const t = tmp.getContext('2d');
    t.imageSmoothingEnabled = false;
    t.translate(w, 0); t.scale(-1, 1);
    t.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
    ctx.drawImage(tmp, dx, dy);
  }

  // Old 64x32 skins have no left arm / left leg: mirror them from the right ones.
  function convertLegacy(ctx) {
    const legs = [[4, 16, 4, 4, 20, 48], [8, 16, 4, 4, 24, 48], [0, 20, 4, 12, 24, 52], [4, 20, 4, 12, 20, 52], [8, 20, 4, 12, 16, 52], [12, 20, 4, 12, 28, 52]];
    const arms = [[44, 16, 4, 4, 36, 48], [48, 16, 4, 4, 40, 48], [40, 20, 4, 12, 40, 52], [44, 20, 4, 12, 36, 52], [48, 20, 4, 12, 32, 52], [52, 20, 4, 12, 44, 52]];
    for (const a of legs.concat(arms)) flipCopy(ctx, a[0], a[1], a[2], a[3], a[4], a[5]);
  }

  function blank(ctx, x, y, w, h) {
    const d = ctx.getImageData(x, y, w, h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  }

  async function prepareSkin(src) {
    const img = await loadImage(src);
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    let slim = false;
    if (img.height <= 32) convertLegacy(ctx);
    else slim = blank(ctx, 50, 16, 2, 4) && blank(ctx, 54, 20, 2, 12) && blank(ctx, 42, 48, 2, 4) && blank(ctx, 46, 52, 2, 12);
    return { canvas: c, slim };
  }

  // ---------------- viewer ----------------
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  class Skin3D {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.inputEl = (opts && opts.inputEl) || canvas;   // element that receives drag-to-rotate
      this.vel = 0;                                       // yaw inertia (rad / ms)
      this.yaw = 0.5;
      this.pitch = 0.12;
      this.paused = false;
      this.perf = false;
      this.dirty = true;
      this.model = null;
      this.tex = null;
      this.dragging = false;
      this.lastTouch = 0;
      this.ok = false;

      let gl = null;
      try {
        gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' });
      } catch (_) { gl = null; }
      if (!gl) return;
      this.gl = gl;

      try {
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        this.prog = prog;
      } catch (err) {
        console.error('Skin3D shader error:', err);
        return;
      }

      const g = gl, p = this.prog;
      this.loc = {
        aPos: g.getAttribLocation(p, 'aPos'), aNormal: g.getAttribLocation(p, 'aNormal'), aUv: g.getAttribLocation(p, 'aUv'),
        uProj: g.getUniformLocation(p, 'uProj'), uView: g.getUniformLocation(p, 'uView'),
        uPart: g.getUniformLocation(p, 'uPart'), uRot: g.getUniformLocation(p, 'uRot'),
        uTex: g.getUniformLocation(p, 'uTex'), uBase: g.getUniformLocation(p, 'uBase')
      };
      this.vbo = g.createBuffer();
      this.ok = true;

      this._bindInput();
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
      this._resize();
      this.t0 = performance.now();
      this.last = this.t0;
      this._tick = this._tick.bind(this);
      this.raf = requestAnimationFrame(this._tick);
    }

    async setSkin(src) {
      if (!this.ok) return;
      const { canvas, slim } = await prepareSkin(src);
      const gl = this.gl;
      this.model = buildModel(slim);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.model.data, gl.STATIC_DRAW);
      if (this.tex) gl.deleteTexture(this.tex);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.dirty = true;
    }

    setPaused(p) { this.paused = !!p; this.dirty = true; }
    setPerf(p) { this.perf = !!p; this._resize(); this.dirty = true; }

    _resize() {
      if (!this.ok) return;
      const dpr = this.perf ? 1 : Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
      }
      this.dirty = true;
    }

    _bindInput() {
      const el = this.inputEl;
      let lx = 0, lt = 0;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        this.dragging = true; lx = e.clientX; lt = performance.now(); this.vel = 0;
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        el.classList.add('dragging');
      });
      el.addEventListener('pointermove', (e) => {
        if (!this.dragging) return;
        const now = performance.now();
        const dx = e.clientX - lx;
        this.yaw += dx * 0.011;                       // horizontal drag only: spins like a turntable
        const dtm = Math.max(1, now - lt);
        this.vel = this.vel * 0.6 + (dx * 0.011 / dtm) * 0.4;
        lx = e.clientX; lt = now;
        this.lastTouch = now;
        this.dirty = true;
      });
      const end = (e) => {
        if (!this.dragging) return;
        this.dragging = false;
        this.lastTouch = performance.now();
        if (performance.now() - lt > 90) this.vel = 0;  // paused before release: no fling
        this.vel = Math.max(-0.02, Math.min(0.02, this.vel));
        el.classList.remove('dragging');
        try { el.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }

    _partMatrix(part, t) {
      const id = part.id;
      let ax = 0, ay = 0, az = 0;
      if (!this.perf) {
        if (id === 'head') { ay = Math.sin(t * 0.6) * 0.14; ax = Math.sin(t * 0.9) * 0.04; }
        else if (id === 'armR') { ax = Math.sin(t * 1.4) * 0.05; az = -(0.06 + Math.sin(t * 1.1) * 0.025); }
        else if (id === 'armL') { ax = -Math.sin(t * 1.4) * 0.05; az = 0.06 + Math.sin(t * 1.1) * 0.025; }
      } else if (id === 'armR') { az = -0.06; }
      else if (id === 'armL') { az = 0.06; }
      if (!ax && !ay && !az) return M.ident();
      const [px, py, pz] = part.pivot;
      let m = M.mul(M.rotZ(az), M.mul(M.rotX(ax), M.rotY(ay)));
      m = M.mul(M.trans(px, py, pz), M.mul(m, M.trans(-px, -py, -pz)));
      return m;
    }

    _tick(ts) {
      this.raf = requestAnimationFrame(this._tick);
      if (this.paused || !this.model || !this.tex) return;
      if (this.perf && !this.dirty) return;

      const dt = Math.min(64, ts - this.last);
      this.last = ts;
      if (!this.dragging && Math.abs(this.vel) > 0.00004) {
        this.yaw += this.vel * dt;                    // glide after a fling
        this.vel *= Math.pow(0.92, dt / 16);
        this.dirty = true;
      } else if (!this.perf && !this.dragging && ts - this.lastTouch > 2000) {
        this.yaw += dt * 0.0006;                      // gentle idle spin
      }
      this._draw((ts - this.t0) / 1000);
      this.dirty = false;
    }

    _draw(t) {
      const gl = this.gl, L = this.loc;
      const w = this.canvas.width, h = this.canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.prog);

      const fov = 30 * Math.PI / 180;
      const dist = 19.5 / Math.tan(fov / 2);     // fits ~39 units of height
      const rot = M.mul(M.rotX(this.pitch), M.rotY(this.yaw));
      const view = M.mul(M.trans(0, 0, -dist), M.mul(rot, M.trans(0, -16, 0)));
      gl.uniformMatrix4fv(L.uProj, false, M.persp(fov, w / h, 10, 300));
      gl.uniformMatrix4fv(L.uView, false, view);
      gl.uniformMatrix4fv(L.uRot, false, rot);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      const stride = 8 * 4;
      gl.enableVertexAttribArray(L.aPos); gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(L.aNormal); gl.vertexAttribPointer(L.aNormal, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(L.aUv); gl.vertexAttribPointer(L.aUv, 2, gl.FLOAT, false, stride, 24);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(L.uTex, 0);

      const mats = this.model.parts.map((p) => this._partMatrix(p, t));
      for (const d of this.model.draws) {
        gl.uniformMatrix4fv(L.uPart, false, mats[d.part]);
        gl.uniform1f(L.uBase, d.base ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, d.first, d.count);
      }
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      if (this._ro) this._ro.disconnect();
    }
  }

  window.Skin3D = Skin3D;
})();
