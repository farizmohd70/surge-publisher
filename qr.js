/* Tiny QR code generator: byte mode, error correction level M, versions 1-10 (up to 213 bytes). */
(function (root) {
  'use strict';

  // ---- Galois field GF(256) ----
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsGenerator(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }
  function rsEncode(data, n) {
    const gen = rsGenerator(n);
    const res = data.concat(new Array(n).fill(0));
    for (let i = 0; i < data.length; i++) {
      const c = res[i];
      if (c) for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], c);
    }
    return res.slice(data.length);
  }

  // ---- version tables, level M: [ecCodewordsPerBlock, [[blocks, dataPerBlock], ...]] ----
  const TABLE = {
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
    6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]],
    10: [26, [[4, 43], [1, 44]]],
  };
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
  const dataCapacity = (v) => TABLE[v][1].reduce((s, [n, d]) => s + n * d, 0);

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    return Array.from(Buffer.from(str, 'utf8'));
  }

  function encodeData(bytes, version) {
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    const cap = dataCapacity(version) * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k]; out.push(v); }
    for (let pad = 0xec; out.length < dataCapacity(version); pad = pad === 0xec ? 0x11 : 0xec) out.push(pad);
    return out;
  }

  function interleave(data, version) {
    const [ecLen, groups] = TABLE[version];
    const blocks = [];
    let pos = 0;
    for (const [count, size] of groups) {
      for (let i = 0; i < count; i++) { blocks.push(data.slice(pos, pos + size)); pos += size; }
    }
    const ecs = blocks.map((b) => rsEncode(b, ecLen));
    const out = [];
    const maxData = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxData; i++) blocks.forEach((b) => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < ecLen; i++) ecs.forEach((e) => out.push(e[i]));
    return out;
  }

  // ---- matrix construction ----
  const MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
  ];

  const bchDigit = (d) => { let n = 0; while (d !== 0) { n++; d >>>= 1; } return n; };
  function bchFormat(data) {
    let d = data << 10;
    while (bchDigit(d) - bchDigit(0x537) >= 0) d ^= 0x537 << (bchDigit(d) - bchDigit(0x537));
    return ((data << 10) | d) ^ 0x5412;
  }
  function bchVersion(data) {
    let d = data << 12;
    while (bchDigit(d) - bchDigit(0x1f25) >= 0) d ^= 0x1f25 << (bchDigit(d) - bchDigit(0x1f25));
    return (data << 12) | d;
  }

  function build(codewords, version, mask) {
    const n = 17 + 4 * version;
    const m = Array.from({ length: n }, () => new Array(n).fill(null));

    const finder = (r, c) => {
      for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        m[rr][cc] = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
          (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      }
    };
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);

    const pos = ALIGN[version];
    for (const r of pos) for (const c of pos) {
      if (m[r][c] !== null) continue;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        m[r + i][c + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1;
      }
    }
    for (let i = 8; i < n - 8; i++) {
      if (m[i][6] === null) m[i][6] = i % 2 === 0;
      if (m[6][i] === null) m[6][i] = i % 2 === 0;
    }

    const typeInfo = (test) => {
      const bits = bchFormat(mask); // error correction level M = 0b00
      for (let i = 0; i < 15; i++) {
        const dark = !test && ((bits >> i) & 1) === 1;
        if (i < 6) m[i][8] = dark; else if (i < 8) m[i + 1][8] = dark; else m[n - 15 + i][8] = dark;
        if (i < 8) m[8][n - i - 1] = dark; else if (i < 9) m[8][15 - i - 1 + 1] = dark; else m[8][15 - i - 1] = dark;
      }
      m[n - 8][8] = !test;
    };
    typeInfo(true);

    if (version >= 7) {
      const bits = bchVersion(version);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >> i) & 1) === 1;
        m[Math.floor(i / 3)][(i % 3) + n - 11] = dark;
        m[(i % 3) + n - 11][Math.floor(i / 3)] = dark;
      }
    }

    // place data
    let inc = -1, row = n - 1, bit = 7, byte = 0;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (let c = 0; c < 2; c++) {
          if (m[row][col - c] === null) {
            let dark = false;
            if (byte < codewords.length) dark = ((codewords[byte] >>> bit) & 1) === 1;
            if (MASKS[mask](row, col - c)) dark = !dark;
            m[row][col - c] = dark;
            if (--bit === -1) { byte++; bit = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= n) { row -= inc; inc = -inc; break; }
      }
    }
    typeInfo(false);
    return m;
  }

  function penalty(m) {
    const n = m.length;
    let score = 0;
    // N1: runs of 5+ same-colour modules
    for (let a = 0; a < n; a++) {
      for (const horizontal of [true, false]) {
        let run = 1;
        for (let b = 1; b < n; b++) {
          const cur = horizontal ? m[a][b] : m[b][a], prev = horizontal ? m[a][b - 1] : m[b - 1][a];
          if (cur === prev) run++; else { if (run >= 5) score += 3 + (run - 5); run = 1; }
        }
        if (run >= 5) score += 3 + (run - 5);
      }
    }
    // N2: 2x2 blocks
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
    // N3: finder-like patterns
    const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let a = 0; a < n; a++) for (let b = 0; b <= n - 11; b++) {
      for (const horizontal of [true, false]) {
        let h1 = true, h2 = true;
        for (let k = 0; k < 11; k++) {
          const v = (horizontal ? m[a][b + k] : m[b + k][a]) ? 1 : 0;
          if (v !== p1[k]) h1 = false;
          if (v !== p2[k]) h2 = false;
        }
        if (h1) score += 40;
        if (h2) score += 40;
      }
    }
    // N4: dark/light balance
    let dark = 0;
    for (const r of m) for (const v of r) if (v) dark++;
    score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
    return score;
  }

  function make(text) {
    const bytes = utf8(String(text));
    let version = 0;
    for (let v = 1; v <= 10; v++) {
      const cc = v < 10 ? 8 : 16;
      if (4 + cc + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
    }
    if (!version) throw new Error('Text is too long for the QR generator.');
    const cw = interleave(encodeData(bytes, version), version);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = build(cw, version, mask);
      const s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return { size: best.length, version, modules: best };
  }

  function draw(canvas, text, scale = 6, margin = 4, dark = '#000', light = '#fff') {
    const q = make(text);
    const px = (q.size + margin * 2) * scale;
    canvas.width = px; canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = dark;
    for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) {
      if (q.modules[r][c]) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
    return q;
  }

  const api = { make, draw, _rsEncode: rsEncode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof window !== 'undefined' ? window : globalThis);
