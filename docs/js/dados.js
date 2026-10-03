const TIPOS = { u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, f32: Float32Array };
const cache = new Map();

async function bytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (!url.endsWith(".gz")) return r.arrayBuffer();
  const fluxo = r.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(fluxo).arrayBuffer();
}

function decodifica(buf) {
  const tam = new DataView(buf).getUint32(0, true);
  const cab = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, tam)));
  const base = 4 + tam;
  const n = cab.n;
  const cols = {};
  for (const c of cab.cols) {
    if (!c.p) { cols[c.k] = new TIPOS[c.t](buf, base + c.o, n); continue; }
    const b = new Uint8Array(buf, base + c.o, n * 4);
    const out = new TIPOS[c.t](n);
    for (let i = 0; i < n; i++) out[i] = (b[i] | (b[n + i] << 8) | (b[2 * n + i] << 16) | (b[3 * n + i] << 24)) >>> 0;
    cols[c.k] = out;
  }
  if (cols.rem_m) {
    const rem_n = new Uint32Array(n), rem_s = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      rem_n[i] = cols.ativos[i] - cols.rem_f[i];
      rem_s[i] = cols.rem_m[i] * rem_n[i];
    }
    Object.assign(cols, { rem_n, rem_s });
    delete cols.rem_m;
    delete cols.rem_f;
  }
  return { n, cols };
}

function memo(chave, fn) {
  if (!cache.has(chave)) cache.set(chave, fn().catch((e) => { cache.delete(chave); throw e; }));
  return cache.get(chave);
}

export const cubo = (nome, ano) =>
  memo(`${nome}/${ano}`, async () => decodifica(await bytes(`data/${nome}/${ano}.bin.gz`)));

export const cuboUnico = (nome) => memo(nome, async () => decodifica(await bytes(`data/${nome}.bin.gz`)));

export const json = (arquivo) =>
  memo(arquivo, async () => JSON.parse(new TextDecoder().decode(await bytes(`data/${arquivo}`))));

export function derivaColuna(c, nome, fonte, fn, Tipo = Uint8Array) {
  if (c.cols[nome]) return;
  const src = c.cols[fonte];
  const out = new Tipo(c.n);
  for (let i = 0; i < c.n; i++) out[i] = fn(src[i]);
  c.cols[nome] = out;
}

export const MEDIDAS = ["ativos", "adm", "desl", "rem_s", "rem_n"];
const NM = MEDIDAS.length;

function permitidos(c, filtros) {
  const dims = [], masks = [], ignorados = [];
  for (const [d, valores] of Object.entries(filtros)) {
    if (!valores || !valores.size) continue;
    if (!c.cols[d]) { ignorados.push(d); continue; }
    const mask = new Uint8Array(65536);
    for (const v of valores) mask[v] = 1;
    dims.push(c.cols[d]);
    masks.push(mask);
  }
  return { dims, masks, ignorados };
}

const medidasDe = (c) => MEDIDAS.map((m) => c.cols[m]);

// Crossfilter: cada faceta recebe as linhas que passam em todos os filtros menos o dela.
export function facetas(c, facetDims, filtros) {
  const nomes = facetDims.filter((d) => c.cols[d]);
  const cols = nomes.map((d) => c.cols[d]);
  const masks = nomes.map((d) => {
    const v = filtros[d];
    if (!v || !v.size) return null;
    const m = new Uint8Array(256);
    for (const x of v) m[x] = 1;
    return m;
  });
  const extra = permitidos(c, Object.fromEntries(Object.entries(filtros).filter(([d]) => !nomes.includes(d))));
  const acc = nomes.map(() => new Float64Array(256 * NM));
  const total = new Float64Array(NM);
  const med = medidasDe(c);
  const D = nomes.length, E = extra.dims.length;
  linhas: for (let i = 0; i < c.n; i++) {
    for (let e = 0; e < E; e++) if (!extra.masks[e][extra.dims[e][i]]) continue linhas;
    let falhas = 0, qual = -1;
    for (let d = 0; d < D; d++) {
      const m = masks[d];
      if (m && !m[cols[d][i]]) { if (++falhas > 1) continue linhas; qual = d; }
    }
    if (falhas === 0) {
      for (let k = 0; k < NM; k++) total[k] += med[k][i];
      for (let d = 0; d < D; d++) {
        const o = cols[d][i] * NM;
        for (let k = 0; k < NM; k++) acc[d][o + k] += med[k][i];
      }
    } else {
      const o = cols[qual][i] * NM;
      for (let k = 0; k < NM; k++) acc[qual][o + k] += med[k][i];
    }
  }
  const res = { total: pacote(total, 0), facetas: {}, ignorados: extra.ignorados };
  nomes.forEach((d, j) => {
    const mapa = new Map();
    for (let v = 0; v < 256; v++) {
      const o = v * NM;
      if (acc[j][o] || acc[j][o + 1] || acc[j][o + 2]) mapa.set(v, pacote(acc[j], o));
    }
    res.facetas[d] = mapa;
  });
  return res;
}

// Agrega por uma ou duas colunas, aplicando os filtros (exceto os listados em `ignorar`).
export function agrega(c, filtros, por, { ignorar = [], tamanho = 65536 } = {}) {
  const f = Object.fromEntries(Object.entries(filtros).filter(([d]) => !ignorar.includes(d)));
  const { dims, masks, ignorados } = permitidos(c, f);
  const [a, b] = Array.isArray(por) ? por : [por];
  const ca = a ? c.cols[a] : null, cb = b ? c.cols[b] : null;
  const larg = cb ? 256 : 1;
  const acc = new Float64Array((ca ? tamanho : 1) * larg * NM);
  const med = medidasDe(c);
  const E = dims.length;
  linhas: for (let i = 0; i < c.n; i++) {
    for (let e = 0; e < E; e++) if (!masks[e][dims[e][i]]) continue linhas;
    const o = ((ca ? ca[i] : 0) * larg + (cb ? cb[i] : 0)) * NM;
    for (let k = 0; k < NM; k++) acc[o + k] += med[k][i];
  }
  const mapa = new Map();
  for (let o = 0; o < acc.length; o += NM) {
    if (acc[o] || acc[o + 1] || acc[o + 2]) {
      const chave = o / NM;
      mapa.set(cb ? `${Math.floor(chave / 256)}|${chave % 256}` : chave, pacote(acc, o));
    }
  }
  return { mapa, ignorados };
}

function pacote(arr, o) {
  return { ativos: arr[o], adm: arr[o + 1], desl: arr[o + 2], rem_s: arr[o + 3], rem_n: arr[o + 4] };
}
