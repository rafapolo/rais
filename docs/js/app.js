import { cubo, cuboUnico, json, derivaColuna, facetas, agrega } from "./dados.js";

const DIMS = ["uf", "setor", "secao", "gg", "sexo", "raca", "idade", "esc"];
const TITULOS = {
  uf: "Estado", setor: "Setor", secao: "Atividade econômica (CNAE)", gg: "Grupo ocupacional (CBO)",
  sexo: "Sexo", raca: "Raça/cor", idade: "Faixa etária", esc: "Escolaridade",
};
const ORDENA_POR_VALOR = new Set(["secao", "gg"]);
const REGIOES = ["Norte", "Nordeste", "Sudeste", "Sul", "Centro-Oeste"];

const nf = new Intl.NumberFormat("pt-BR");
const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const reais = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const compacto = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${nf1.format(v / 1e9)} bi`;
  if (a >= 1e6) return `${nf1.format(v / 1e6)} mi`;
  if (a >= 1e4) return `${nf1.format(v / 1e3)} mil`;
  return nf.format(Math.round(v));
};
const pct = (v) => `${nf1.format(v * 100)}%`;
const reaisCurto = (v) => (Math.abs(v) >= 1e4 ? `R$ ${compacto(v)}` : reais.format(v));

const METRICAS = {
  ativos: { rotulo: "Vínculos", titulo: "Vínculos ativos em 31/12", valor: (p) => p.ativos, fmt: compacto, fmtLongo: (v) => nf.format(Math.round(v)) },
  rem: { rotulo: "Remuneração", titulo: "Remuneração média (dezembro)", valor: (p, def) => (p.rem_n > 0 ? (p.rem_s / p.rem_n) * def : null), fmt: (v) => reais.format(v), fmtCurto: reaisCurto, fmtLongo: (v) => reais.format(v), media: true },
  adm: { rotulo: "Admissões", titulo: "Admissões no ano", valor: (p) => p.adm, fmt: compacto, fmtLongo: (v) => nf.format(Math.round(v)) },
  desl: { rotulo: "Desligamentos", titulo: "Desligamentos no ano", valor: (p) => p.desl, fmt: compacto, fmtLongo: (v) => nf.format(Math.round(v)) },
  rot: { rotulo: "Rotatividade", titulo: "Desligamentos por 100 vínculos ativos", valor: (p) => (p.ativos > 0 ? (p.desl / p.ativos) * 100 : null), fmt: (v) => nf1.format(v), fmtLongo: (v) => nf1.format(v), media: true },
};

const estado = {
  ano: 2024,
  metrica: "ativos",
  preco: "real",
  mapa: "mun",
  div: "nenhum",
  gap: "raca",
  filtros: Object.fromEntries(DIMS.map((d) => [d, new Set()])),
};

let meta, municipios, topo, dados = {};
const $ = (s) => document.querySelector(s);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const deflator = (ano) => (estado.preco === "real" ? meta.deflator[ano] ?? 1 : 1);
const rotulo = (d, v) => meta.dims[d]?.[v] ?? String(v);
const metrica = () => METRICAS[estado.metrica];
const valorDe = (p, ano = estado.ano) => (p ? metrica().valor(p, deflator(ano)) : null);
const filtrosAtivos = () => DIMS.filter((d) => estado.filtros[d].size);
const nomeFiltro = (d) => TITULOS[d].replace(/ \(.*\)/, "").toLowerCase();

// ── estado na URL ────────────────────────────────────────────────────────────
function leHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has("ano")) estado.ano = +p.get("ano");
  for (const k of ["metrica", "preco", "mapa", "div", "gap"]) if (p.has(k)) estado[k] = p.get(k);
  for (const d of DIMS) estado.filtros[d] = new Set((p.get(d) || "").split(",").filter(Boolean).map(Number));
}

function gravaHash() {
  const p = new URLSearchParams();
  p.set("ano", estado.ano);
  for (const k of ["metrica", "preco", "mapa", "div", "gap"]) p.set(k, estado[k]);
  for (const d of DIMS) if (estado.filtros[d].size) p.set(d, [...estado.filtros[d]].join(","));
  history.replaceState(null, "", `#${p}`);
}

// ── dica (tooltip) ───────────────────────────────────────────────────────────
const dica = $("#dica");
function mostraDica(ev, titulo, linhas) {
  dica.replaceChildren();
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = titulo;
  dica.append(t);
  for (const [nome, valor, cor] of linhas) {
    const l = document.createElement("div");
    l.className = "l";
    const esq = document.createElement("span");
    if (cor) {
      const i = document.createElement("i");
      i.style.background = cor;
      esq.append(i, " ");
    }
    esq.append(nome);
    const v = document.createElement("strong");
    v.textContent = valor;
    l.append(esq, v);
    dica.append(l);
  }
  const { innerWidth: W, innerHeight: H } = window;
  const r = dica.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > W - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > H - 8) y = ev.clientY - r.height - 14;
  dica.style.left = `${Math.max(8, x)}px`;
  dica.style.top = `${Math.max(8, y)}px`;
  dica.classList.add("visivel");
}
const escondeDica = () => dica.classList.remove("visivel");

// ── carga ────────────────────────────────────────────────────────────────────
async function carregaAno(ano) {
  const anoEmp = Math.min(Math.max(ano, meta.anos.empresas[0]), meta.anos.empresas.at(-1));
  const [c, m, o, e] = await Promise.all([
    cubo("cubo", ano), cubo("mun", ano), cubo("ocup", ano), json(`empresas/${anoEmp}.json.gz`),
  ]);
  derivaColuna(m, "uf", "mi", (i) => municipios.uf[i]);
  derivaColuna(o, "gg", "fam", (f) => Math.floor(f / 1000));
  dados = { ...dados, cubo: c, mun: m, ocup: o, emp: e, anoEmp };
}

async function atualiza({ recarrega = false } = {}) {
  gravaHash();
  if (recarrega) {
    $("#principal").classList.add("carregando");
    try {
      await carregaAno(estado.ano);
    } finally {
      $("#principal").classList.remove("carregando");
    }
  }
  const res = facetas(dados.cubo, DIMS, estado.filtros);
  desenhaContexto(res);
  desenhaKpis(res);
  desenhaFacetas(res);
  desenhaMapa(res);
  desenhaSerie();
  desenhaGap();
  desenhaOcupacoes();
  desenhaEmpresas();
}

function alternaFiltro(d, v) {
  const s = estado.filtros[d];
  s.has(v) ? s.delete(v) : s.add(v);
  atualiza();
}

// ── contexto e KPIs ──────────────────────────────────────────────────────────
function desenhaContexto(res) {
  const ativos = filtrosAtivos();
  const r = $("#resumo");
  r.replaceChildren();
  const b = document.createElement("strong");
  b.textContent = nf.format(Math.round(res.total.ativos));
  r.append(b, ` vínculos formais ativos em 31/12/${estado.ano}`);
  if (!ativos.length) r.append(" no Brasil");

  const chips = $("#chips");
  chips.replaceChildren();
  for (const d of ativos) {
    for (const v of estado.filtros[d]) {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "chip";
      const k = document.createElement("b");
      k.textContent = nomeFiltro(d);
      const x = document.createElement("span");
      x.setAttribute("aria-hidden", "true");
      x.textContent = "×";
      c.append(k, " ", rotulo(d, v), x);
      c.title = "Remover filtro";
      c.onclick = () => alternaFiltro(d, v);
      chips.append(c);
    }
  }
  const n = ativos.reduce((s, d) => s + estado.filtros[d].size, 0);
  $("#n-filtros").textContent = n ? `(${n})` : "";
}

function desenhaKpis(res) {
  const def = deflator(estado.ano);
  const t = res.total;
  const sexo = res.facetas.sexo, raca = res.facetas.raca;
  const media = (p) => (p && p.rem_n ? (p.rem_s / p.rem_n) * def : null);
  const h = sexo.get(1), m = sexo.get(2);
  const totSexo = (h?.ativos || 0) + (m?.ativos || 0);
  const totRaca = [...raca.values()].reduce((s, p) => s + p.ativos, 0);
  const negros = (raca.get(3)?.ativos || 0) + (raca.get(5)?.ativos || 0);
  const gap = media(h) && media(m) ? 1 - media(m) / media(h) : null;
  const filtroSexo = estado.filtros.sexo.size > 0, filtroRaca = estado.filtros.raca.size > 0;

  const itens = [
    ["Vínculos ativos", nf.format(Math.round(t.ativos)), `em 31/12/${estado.ano}`],
    ["Remuneração média", t.rem_n ? reais.format((t.rem_s / t.rem_n) * def) : "—", estado.preco === "real" ? `dezembro, R$ de ${meta.base_preco}` : "dezembro, R$ nominais"],
    ["Admissões", compacto(t.adm), `${compacto(t.desl)} desligamentos`],
    ["Rotatividade", t.ativos ? nf1.format((t.desl / t.ativos) * 100) : "—", "desligamentos por 100 vínculos"],
    ["Mulheres", totSexo ? pct((m?.ativos || 0) / totSexo) : "—", filtroSexo ? "ignora o filtro de sexo" : "dos vínculos ativos"],
    ["Diferença salarial", gap == null ? "—" : pct(gap), gap == null ? "" : gap >= 0 ? "mulheres recebem a menos" : "mulheres recebem a mais"],
    ["Pretos e pardos", totRaca ? pct(negros / totRaca) : "—", filtroRaca ? "ignora o filtro de raça" : "dos vínculos ativos"],
  ];
  const box = $("#kpis");
  box.replaceChildren();
  for (const [r, v, s] of itens) {
    const el = document.createElement("div");
    el.className = "kpi";
    for (const [cls, txt] of [["rotulo", r], ["valor", v], ["sub", s]]) {
      const x = document.createElement("div");
      x.className = cls;
      x.textContent = txt;
      el.append(x);
    }
    box.append(el);
  }
}

// ── painel de facetas ────────────────────────────────────────────────────────
function linhaFaceta(d, v, p, max, curto) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "linha";
  btn.setAttribute("aria-pressed", estado.filtros[d].has(v));
  const val = valorDe(p);
  const nome = curto ?? rotulo(d, v);
  const r = document.createElement("span");
  r.className = "r";
  r.textContent = nome;
  const vv = document.createElement("span");
  vv.className = "v";
  vv.textContent = val == null ? "—" : metrica().fmt(val);
  const b = document.createElement("span");
  b.className = "b";
  const i = document.createElement("i");
  i.style.width = `${val && max ? (val / max) * 100 : 0}%`;
  b.append(i);
  if (curto) btn.append(r, b);
  else btn.append(r, vv, b);
  const completo = d === "uf" ? meta.uf_nome[v] : rotulo(d, v);
  btn.onclick = () => alternaFiltro(d, v);
  btn.onpointermove = (ev) =>
    mostraDica(ev, completo, [
      [metrica().titulo, val == null ? "—" : metrica().fmtLongo(val)],
      ...(estado.metrica !== "ativos" && p ? [["Vínculos ativos", nf.format(Math.round(p.ativos))]] : []),
    ]);
  btn.onpointerleave = escondeDica;
  return btn;
}

function desenhaFacetas(res) {
  const box = $("#facetas");
  box.replaceChildren();
  for (const d of DIMS) {
    const mapa = res.facetas[d];
    const codigos = Object.keys(meta.dims[d]).map(Number);
    for (const v of mapa.keys()) if (!codigos.includes(v)) codigos.push(v);
    const visiveis = codigos.filter((v) => mapa.has(v) || estado.filtros[d].has(v));
    if (ORDENA_POR_VALOR.has(d)) visiveis.sort((a, b) => (valorDe(mapa.get(b)) ?? -1) - (valorDe(mapa.get(a)) ?? -1));
    const max = Math.max(0, ...visiveis.map((v) => valorDe(mapa.get(v)) ?? 0));

    const sec = document.createElement("section");
    sec.className = `faceta${estado.filtros[d].size ? " ativa" : ""}`;
    const h = document.createElement("header");
    const t = document.createElement("h3");
    t.textContent = TITULOS[d];
    h.append(t);
    if (estado.filtros[d].size) {
      const l = document.createElement("button");
      l.type = "button";
      l.className = "link";
      l.textContent = "limpar";
      l.onclick = () => { estado.filtros[d].clear(); atualiza(); };
      h.append(l);
    }
    sec.append(h);

    if (d === "uf") {
      for (const reg of REGIOES) {
        const ufs = visiveis.filter((v) => meta.uf_regiao[v] === reg).sort((a, b) => (valorDe(mapa.get(b)) ?? -1) - (valorDe(mapa.get(a)) ?? -1));
        if (!ufs.length) continue;
        const rt = document.createElement("div");
        rt.className = "regiao";
        rt.textContent = reg;
        const g = document.createElement("div");
        g.className = "uf-grade";
        for (const v of ufs) g.append(linhaFaceta(d, v, mapa.get(v), max, meta.dims.uf[v]));
        sec.append(rt, g);
      }
    } else {
      for (const v of visiveis) sec.append(linhaFaceta(d, v, mapa.get(v), max));
    }
    box.append(sec);
  }
}

// ── mapa ─────────────────────────────────────────────────────────────────────
const mapaEl = $("#mapa");
const canvas = mapaEl.querySelector("canvas");
let geo = null;

function preparaGeo() {
  const w = mapaEl.clientWidth, h = mapaEl.clientHeight;
  if (geo && geo.w === w && geo.h === h) return geo;
  const mun = topojson.feature(topo, topo.objects.mun).features;
  const ufs = topojson.feature(topo, topo.objects.uf).features;
  const proj = d3.geoMercator().fitExtent([[8, 8], [w - 8, h - 8]], { type: "FeatureCollection", features: ufs });
  const path = d3.geoPath(proj);
  const forma = (f) => ({ id: +f.properties.id || +f.properties.uf, uf: +f.properties.uf, p: new Path2D(path(f)), bb: path.bounds(f) });
  geo = {
    w, h,
    mun: mun.map(forma),
    ufs: ufs.map(forma),
    divisas: new Path2D(path(topojson.mesh(topo, topo.objects.uf, (a, b) => a !== b))),
    contorno: new Path2D(path(topojson.mesh(topo, topo.objects.uf, (a, b) => a === b))),
  };
  return geo;
}

let mapaAtual = null;

function desenhaMapa(res) {
  const g = preparaGeo();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = g.w * dpr;
  canvas.height = g.h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, g.w, g.h);

  const porMun = estado.mapa === "mun";
  const ufSel = estado.filtros.uf;
  let valores, formas, ignorados;
  if (porMun) {
    const r = agrega(dados.mun, estado.filtros, "mi", { ignorar: ["uf"], tamanho: municipios.mun.length });
    ignorados = r.ignorados;
    const idx = new Map(municipios.mun.map((m, i) => [m, i]));
    valores = new Map();
    for (const f of g.mun) {
      const i = idx.get(f.id);
      const p = r.mapa.get(i);
      if (p) valores.set(f.id, { v: valorDe(p), p, nome: `${municipios.nome[i]} (${meta.dims.uf[municipios.uf[i]]})` });
    }
    formas = g.mun;
  } else {
    ignorados = [];
    valores = new Map();
    for (const [uf, p] of res.facetas.uf) valores.set(uf, { v: valorDe(p), p, nome: meta.uf_nome[uf] });
    formas = g.ufs;
  }

  const minimo = estado.metrica === "rem" || estado.metrica === "rot" ? 10 : 0;
  const lista = [...valores.values()].filter((x) => x.v != null && x.p.ativos >= minimo).map((x) => x.v);
  const rampa = css("--seq").split(",").map((s) => s.trim());
  const escala = d3.scaleQuantile().domain(lista).range(rampa);
  const semDado = css("--nodata");

  for (const f of formas) {
    const x = valores.get(f.id);
    const ok = x && x.v != null && x.p.ativos >= minimo;
    ctx.globalAlpha = ufSel.size && !ufSel.has(f.uf) ? 0.22 : 1;
    ctx.fillStyle = ok ? escala(x.v) : semDado;
    ctx.fill(f.p);
  }
  ctx.globalAlpha = 1;
  ctx.lineJoin = "round";
  ctx.strokeStyle = css("--surface");
  ctx.lineWidth = porMun ? 0.8 : 1.2;
  ctx.stroke(g.divisas);
  ctx.strokeStyle = css("--axis");
  ctx.lineWidth = 0.8;
  ctx.stroke(g.contorno);
  if (ufSel.size) {
    ctx.strokeStyle = css("--ink");
    ctx.lineWidth = 1.5;
    for (const f of g.ufs) if (ufSel.has(f.uf)) ctx.stroke(f.p);
  }

  mapaAtual = { formas, valores, minimo };
  desenhaLugares(valores, minimo, porMun);
  $("#titulo-mapa").textContent = `${metrica().titulo} por ${porMun ? "município" : "estado"}`;
  const ign = ignorados.filter((d) => d !== "uf");
  $("#nota-mapa").textContent = [
    ign.length ? `O mapa municipal não distingue ${ign.map(nomeFiltro).join(", ")}; esses filtros não se aplicam a ele.` : "",
    ufSel.size ? "Estados fora do filtro aparecem esmaecidos." : "",
    minimo ? `Municípios com menos de ${minimo} vínculos ficam em cinza.` : "",
  ].filter(Boolean).join(" ");
  desenhaLegendaMapa(escala, rampa);
}

function desenhaLugares(valores, minimo, porMun) {
  const ufSel = estado.filtros.uf;
  const itens = [...valores.entries()]
    .filter(([id, x]) => x.v != null && x.p.ativos >= Math.max(minimo, porMun && metrica().media ? 1000 : 0))
    .filter(([id]) => !ufSel.size || ufSel.has(porMun ? Math.floor(id / 100000) : id))
    .sort((a, b) => b[1].v - a[1].v).slice(0, 15);
  $("#titulo-lugares").textContent = porMun ? "Municípios" : "Estados";
  const lista = $("#lugares");
  lista.replaceChildren();
  if (!itens.length) return vazio(lista, "Sem dados para esta seleção.");
  const max = itens[0][1].v;
  const ml = metrica();
  itens.forEach(([id, x], i) => {
    const det = ml.media ? `${compacto(x.p.ativos)} vínculos` : x.p.rem_n ? `remuneração média ${reais.format((x.p.rem_s / x.p.rem_n) * deflator(estado.ano))}` : "";
    itemRanking(lista, i + 1, x.nome, ml.fmt(x.v), x.v / max, det);
  });
  if (porMun && ml.media) vazio(lista, "Municípios com 1.000+ vínculos.");
}

function desenhaLegendaMapa(escala, rampa) {
  const box = $("#legenda-mapa");
  box.replaceChildren();
  const q = escala.quantiles();
  if (!q.length) return;
  const faixas = document.createElement("div");
  faixas.className = "faixas";
  const fmt = metrica().fmtCurto ?? metrica().fmt;
  rampa.forEach((cor, i) => {
    const f = document.createElement("div");
    f.className = "faixa";
    const sw = document.createElement("i");
    sw.style.background = cor;
    const s = document.createElement("span");
    s.textContent = i === 0 ? `< ${fmt(q[0])}` : i === rampa.length - 1 ? `≥ ${fmt(q[i - 1])}` : fmt(q[i - 1]);
    f.append(sw, s);
    faixas.append(f);
  });
  const t = document.createElement("span");
  t.textContent = "Faixas de igual número de áreas (quantis)";
  box.append(faixas, t);
}

function formaSob(ev) {
  if (!mapaAtual) return null;
  const r = canvas.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  try {
    for (const f of mapaAtual.formas) {
      const [[x0, y0], [x1, y1]] = f.bb;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (ctx.isPointInPath(f.p, x, y)) return f;
    }
    return null;
  } finally {
    ctx.restore();
  }
}

canvas.addEventListener("pointermove", (ev) => {
  const f = formaSob(ev);
  if (!f) return escondeDica();
  const x = mapaAtual.valores.get(f.id);
  const nome = x?.nome ?? (estado.mapa === "mun" ? "Município" : meta.uf_nome[f.uf]);
  const linhas = [[metrica().titulo, x && x.v != null && x.p.ativos >= mapaAtual.minimo ? metrica().fmtLongo(x.v) : "sem dados"]];
  if (x && estado.metrica !== "ativos") linhas.push(["Vínculos ativos", nf.format(Math.round(x.p.ativos))]);
  mostraDica(ev, nome, linhas);
});
canvas.addEventListener("pointerleave", escondeDica);
canvas.addEventListener("click", (ev) => {
  const f = formaSob(ev);
  if (f) alternaFiltro("uf", f.uf);
});

// ── série temporal ───────────────────────────────────────────────────────────
function seriesAtuais() {
  const hist = estado.div === "historia";
  const c = hist ? dados.historia : dados.serie;
  const div = hist || estado.div === "nenhum" ? null : estado.div;
  const { mapa, ignorados } = agrega(c, estado.filtros, div ? ["ai", div] : "ai", { tamanho: 64, ignorar: div ? [div] : [] });
  const grupos = div ? Object.keys(meta.dims[div]).map(Number) : [null];
  const cores = [css("--s1"), css("--s2"), css("--s3")];
  const series = grupos.map((gv, i) => {
    const pontos = [];
    for (let ai = 0; ai < 64; ai++) {
      const p = mapa.get(div ? `${ai}|${gv}` : ai);
      if (!p) continue;
      const ano = ai + 1984;
      const v = valorDe(p, ano);
      if (v != null && !(estado.metrica === "rem" && ano < 1999) && !(estado.metrica === "adm" && ano < 1994)) pontos.push({ ano, v });
    }
    return { nome: div ? rotulo(div, gv) : metrica().titulo, cor: cores[i], pontos };
  }).filter((s) => s.pontos.length);
  return { series, ignorados, hist, div };
}

function desenhaSerie() {
  const box = $("#serie");
  const { series, ignorados, hist, div } = seriesAtuais();
  $("#titulo-serie").textContent = `${metrica().titulo}, ${hist ? "1985" : "2006"}–${meta.anos.cubo.at(-1)}`;
  const notas = [];
  if (ignorados.length) notas.push(`A série não distingue ${ignorados.map(nomeFiltro).join(", ")}; esses filtros não se aplicam a ela.`);
  if (div && estado.filtros[div].size) notas.push(`Dividida por ${nomeFiltro(div)}, ignora o filtro de ${nomeFiltro(div)}.`);
  if (hist && estado.metrica === "rem") notas.push("Remuneração disponível a partir de 1999.");
  if (hist && estado.preco === "nominal" && estado.metrica === "rem") notas.push("Valores nominais em reais.");
  notas.push("Clique em um ano para selecioná-lo.");
  $("#nota-serie").textContent = notas.join(" ");

  const W = box.clientWidth || 600, H = 260, m = { t: 12, r: div ? 96 : 24, b: 26, l: 64 };
  const todos = series.flatMap((s) => s.pontos);
  const anos = hist ? meta.anos.historia : meta.anos.cubo;
  const x = d3.scaleLinear().domain([anos[0], anos.at(-1)]).range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(todos, (p) => p.v) || 1]).nice().range([H - m.b, m.t]);

  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("height", H).attr("role", "img")
    .attr("aria-label", `${metrica().titulo} por ano`);
  svg.append("g").attr("class", "grade").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "eixo").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(metrica().fmt).tickSizeOuter(0)).call((g) => g.select(".domain").remove());
  svg.append("g").attr("class", "eixo").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(Math.min(anos.length, Math.floor(W / 60))).tickFormat(d3.format("d")).tickSizeOuter(0));

  if (!hist || estado.ano >= anos[0]) {
    svg.append("line").attr("x1", x(estado.ano)).attr("x2", x(estado.ano)).attr("y1", m.t).attr("y2", H - m.b)
      .attr("stroke", css("--axis")).attr("stroke-dasharray", "3 3");
  }
  const linha = d3.line().x((p) => x(p.ano)).y((p) => y(p.v)).defined((p, i, a) => i === 0 || p.ano - a[i - 1].ano === 1);
  for (const s of series) {
    svg.append("path").attr("d", linha(s.pontos)).attr("fill", "none").attr("stroke", s.cor).attr("stroke-width", 2)
      .attr("stroke-linejoin", "round").attr("stroke-linecap", "round");
    const sel = s.pontos.find((p) => p.ano === estado.ano);
    if (sel) svg.append("circle").attr("cx", x(sel.ano)).attr("cy", y(sel.v)).attr("r", 4.5).attr("fill", s.cor)
      .attr("stroke", css("--surface")).attr("stroke-width", 2);
    if (div) {
      const u = s.pontos.at(-1);
      svg.append("text").attr("class", "rotulo-direto").attr("x", x(u.ano) + 8).attr("y", y(u.v)).attr("dy", "0.35em").text(s.nome);
    }
  }
  if (div) evitaColisao(svg.selectAll(".rotulo-direto"));

  const guia = svg.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--muted")).attr("opacity", 0);
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b)
    .attr("fill", "transparent").style("cursor", "pointer")
    .on("pointermove", (ev) => {
      const [px] = d3.pointer(ev);
      const ano = Math.round(x.invert(px * (W / svg.node().clientWidth)));
      guia.attr("x1", x(ano)).attr("x2", x(ano)).attr("opacity", 1);
      mostraDica(ev, String(ano), series.map((s) => {
        const p = s.pontos.find((q) => q.ano === ano);
        return [s.nome, p ? metrica().fmtLongo(p.v) : "—", s.cor];
      }));
    })
    .on("pointerleave", () => { guia.attr("opacity", 0); escondeDica(); })
    .on("click", (ev) => {
      const [px] = d3.pointer(ev);
      const ano = Math.round(x.invert(px * (W / svg.node().clientWidth)));
      if (meta.anos.cubo.includes(ano)) mudaAno(ano);
    });
  box.replaceChildren(svg.node());

  const leg = $("#legenda-serie");
  leg.replaceChildren();
  if (series.length > 1) for (const s of series) leg.append(itemLegenda(s.nome, s.cor));
}

function itemLegenda(nome, cor, ponto = false) {
  const it = document.createElement("span");
  it.className = "item";
  const i = document.createElement("i");
  if (ponto) i.className = "ponto";
  i.style.background = cor;
  it.append(i, nome);
  return it;
}

function evitaColisao(sel) {
  const nos = sel.nodes().map((n) => ({ n, y: +n.getAttribute("y") })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < nos.length; i++) if (nos[i].y - nos[i - 1].y < 14) nos[i].y = nos[i - 1].y + 14;
  for (const { n, y } of nos) n.setAttribute("y", y);
}

// ── diferença salarial ───────────────────────────────────────────────────────
function desenhaGap() {
  const linhaDim = estado.gap;
  const { mapa } = agrega(dados.cubo, estado.filtros, [linhaDim, "sexo"], { ignorar: [linhaDim, "sexo"], tamanho: 32 });
  const def = deflator(estado.ano);
  const media = (p) => (p && p.rem_n >= 30 ? (p.rem_s / p.rem_n) * def : null);
  let linhas = Object.keys(meta.dims[linhaDim]).map(Number).map((v) => {
    const h = mapa.get(`${v}|1`), mu = mapa.get(`${v}|2`);
    return { v, nome: rotulo(linhaDim, v), h: media(h), m: media(mu), n: (h?.ativos || 0) + (mu?.ativos || 0) };
  }).filter((l) => l.h != null || l.m != null);
  if (linhaDim === "gg") linhas.sort((a, b) => (b.h ?? 0) - (a.h ?? 0));

  const notas = [`Linhas e sexo ignoram os próprios filtros; os demais filtros se aplicam. R$ ${estado.preco === "real" ? `de ${meta.base_preco}` : "nominais"}.`];
  $("#nota-gap").textContent = notas.join(" ");

  const box = $("#gap");
  const W = box.clientWidth || 600, rowH = 30, m = { t: 8, r: 72, b: 26, l: Math.min(220, W * 0.34) };
  const H = m.t + m.b + linhas.length * rowH;
  const max = d3.max(linhas, (l) => Math.max(l.h ?? 0, l.m ?? 0)) || 1;
  const x = d3.scaleLinear().domain([0, max]).nice().range([m.l, W - m.r]);
  const y = (i) => m.t + i * rowH + rowH / 2;
  const corH = css("--s1"), corM = css("--s2");

  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("height", H).attr("role", "img")
    .attr("aria-label", "Remuneração média de homens e mulheres");
  svg.append("g").attr("class", "grade").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 160))).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "eixo").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 160))).tickFormat((v) => compacto(v)).tickSizeOuter(0));

  linhas.forEach((l, i) => {
    const g = svg.append("g");
    g.append("text").attr("x", m.l - 10).attr("y", y(i)).attr("dy", "0.35em").attr("text-anchor", "end")
      .attr("class", "rotulo-direto").text(l.nome.length > 34 ? `${l.nome.slice(0, 33)}…` : l.nome);
    if (l.h != null && l.m != null) {
      g.append("line").attr("x1", x(l.h)).attr("x2", x(l.m)).attr("y1", y(i)).attr("y2", y(i))
        .attr("stroke", css("--axis")).attr("stroke-width", 2);
    }
    for (const [v, cor] of [[l.h, corH], [l.m, corM]]) {
      if (v == null) continue;
      g.append("circle").attr("cx", x(v)).attr("cy", y(i)).attr("r", 5.5).attr("fill", cor)
        .attr("stroke", css("--surface")).attr("stroke-width", 2);
    }
    if (l.h && l.m) {
      g.append("text").attr("class", "valor-rotulo").attr("x", W - m.r + 10).attr("y", y(i)).attr("dy", "0.35em")
        .text(`${l.m < l.h ? "−" : "+"}${nf1.format(Math.abs(1 - l.m / l.h) * 100)}%`);
    }
    g.append("rect").attr("x", 0).attr("y", y(i) - rowH / 2).attr("width", W).attr("height", rowH).attr("fill", "transparent")
      .on("pointermove", (ev) => mostraDica(ev, l.nome, [
        ["Homens", l.h ? reais.format(l.h) : "—", corH],
        ["Mulheres", l.m ? reais.format(l.m) : "—", corM],
        ["Vínculos ativos", nf.format(Math.round(l.n))],
      ]))
      .on("pointerleave", escondeDica);
  });
  box.replaceChildren(svg.node());
  const leg = $("#legenda-gap");
  leg.replaceChildren(itemLegenda("Homens", corH, true), itemLegenda("Mulheres", corM, true));
  const t = document.createElement("span");
  t.textContent = "À direita: quanto as mulheres recebem a menos (−) ou a mais (+) que os homens";
  leg.append(t);
}

// ── rankings ─────────────────────────────────────────────────────────────────
function itemRanking(lista, pos, nome, valor, frac, detalhe) {
  const li = document.createElement("li");
  const p = document.createElement("span");
  p.className = "pos";
  p.textContent = pos;
  const n = document.createElement("span");
  n.className = "nome";
  n.textContent = nome;
  n.title = nome;
  const v = document.createElement("span");
  v.className = "num";
  v.textContent = valor;
  const b = document.createElement("span");
  b.className = "barra";
  const i = document.createElement("i");
  i.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  b.append(i);
  li.append(p, n, v, b);
  if (detalhe) {
    const d = document.createElement("span");
    d.className = "det";
    d.textContent = detalhe;
    li.append(document.createElement("span"), d);
  }
  lista.append(li);
}

function vazio(lista, msg) {
  const li = document.createElement("li");
  li.className = "vazio";
  li.textContent = msg;
  lista.append(li);
}

function desenhaOcupacoes() {
  const { mapa, ignorados } = agrega(dados.ocup, estado.filtros, "fam", { tamanho: 10000 });
  const porSexo = agrega(dados.ocup, estado.filtros, ["fam", "sexo"], { tamanho: 10000, ignorar: ["sexo"] }).mapa;
  const minimo = 500;
  const ml = metrica();
  const itens = [...mapa].filter(([f, p]) => f > 0 && (!ml.media || p.ativos >= minimo))
    .map(([f, p]) => ({ f, p, v: valorDe(p) })).filter((x) => x.v != null)
    .sort((a, b) => b.v - a.v).slice(0, 15);
  $("#titulo-ocup").textContent = `Ocupações · ${ml.titulo.toLowerCase()}`;
  $("#nota-ocup").textContent = [
    "Famílias ocupacionais da CBO 2002.",
    ml.media ? `Apenas ocupações com ${minimo}+ vínculos.` : "",
    ignorados.length ? `Não distingue ${ignorados.map(nomeFiltro).join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  const lista = $("#ocup");
  lista.replaceChildren();
  if (!itens.length) return vazio(lista, "Sem ocupações para esta seleção.");
  const max = itens[0].v;
  itens.forEach((x, i) => {
    const h = porSexo.get(`${x.f}|1`)?.ativos || 0, m = porSexo.get(`${x.f}|2`)?.ativos || 0;
    const det = `${pct(m / (h + m || 1))} mulheres · ${compacto(x.p.ativos)} vínculos`;
    itemRanking(lista, i + 1, meta.cbo[x.f] ?? `Código CBO ${x.f} (sem descrição)`, ml.fmt(x.v), x.v / max, det);
  });
}

function desenhaEmpresas() {
  const e = dados.emp;
  const f = estado.filtros;
  const soma = new Map();
  for (let i = 0; i < e.cnpj.length; i++) {
    if (f.uf.size && !f.uf.has(e.uf[i])) continue;
    if (f.setor.size && !f.setor.has(e.setor[i])) continue;
    if (f.secao.size && !f.secao.has(e.secao[i])) continue;
    const k = e.cnpj[i];
    const a = soma.get(k) || { nome: e.nome[i], ativos: 0, estab: 0, ufs: new Set() };
    a.ativos += e.ativos[i];
    a.estab += e.estab[i];
    a.ufs.add(e.uf[i]);
    soma.set(k, a);
  }
  const top = [...soma.values()].sort((a, b) => b.ativos - a.ativos).slice(0, 15);
  const outros = ["gg", "sexo", "raca", "idade", "esc"].filter((d) => f[d].size);
  $("#titulo-emp").textContent = `Maiores empregadores · ${dados.anoEmp}`;
  $("#nota-emp").textContent = [
    dados.anoEmp !== estado.ano ? `Dados por CNPJ só existem de ${meta.anos.empresas[0]} a ${meta.anos.empresas.at(-1)}; mostrando ${dados.anoEmp}.` : "",
    "Vínculos ativos somados por CNPJ raiz.",
    outros.length ? `Não distingue ${outros.map(nomeFiltro).join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  const lista = $("#emp");
  lista.replaceChildren();
  if (!top.length) return vazio(lista, "Sem empregadores para esta seleção.");
  const max = top[0].ativos;
  top.forEach((x, i) => {
    const ufs = [...x.ufs].map((u) => meta.dims.uf[u]).sort();
    const det = `${nf.format(x.estab)} estabelecimento${x.estab > 1 ? "s" : ""} · ${ufs.length > 6 ? `${ufs.length} estados` : ufs.join(", ")}`;
    itemRanking(lista, i + 1, x.nome, nf.format(x.ativos), x.ativos / max, det);
  });
}

// ── controles ────────────────────────────────────────────────────────────────
let tocando = null;

function mudaAno(ano) {
  estado.ano = ano;
  $("#ano").value = ano;
  $("#ano-valor").textContent = ano;
  return atualiza({ recarrega: true });
}

function sincronizaBotoes() {
  for (const b of document.querySelectorAll("#metricas button")) b.setAttribute("aria-pressed", b.dataset.m === estado.metrica);
  for (const b of document.querySelectorAll("[data-mapa]")) b.setAttribute("aria-pressed", b.dataset.mapa === estado.mapa);
  for (const b of document.querySelectorAll("[data-div]")) b.setAttribute("aria-pressed", b.dataset.div === estado.div);
  $("#preco").value = estado.preco;
  $("#gap-linhas").value = estado.gap;
}

function montaControles() {
  const box = $("#metricas");
  for (const [k, m] of Object.entries(METRICAS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.m = k;
    b.textContent = m.rotulo;
    b.title = m.titulo;
    b.onclick = () => { estado.metrica = k; sincronizaBotoes(); atualiza(); };
    box.append(b);
  }
  const anos = meta.anos.cubo;
  Object.assign($("#ano"), { min: anos[0], max: anos.at(-1), value: estado.ano });
  $("#ano-valor").textContent = estado.ano;
  $("#ano").addEventListener("input", (ev) => { $("#ano-valor").textContent = ev.target.value; });
  $("#ano").addEventListener("change", (ev) => mudaAno(+ev.target.value));
  $("#play").onclick = async () => {
    if (tocando) { clearTimeout(tocando); tocando = null; $("#play").textContent = "▶"; return; }
    $("#play").textContent = "❚❚";
    const passo = async () => {
      const prox = estado.ano >= anos.at(-1) ? anos[0] : estado.ano + 1;
      await mudaAno(prox);
      if (prox === anos.at(-1)) { tocando = null; $("#play").textContent = "▶"; return; }
      tocando = setTimeout(passo, 700);
    };
    tocando = setTimeout(passo, 0);
  };
  $("#preco").onchange = (ev) => { estado.preco = ev.target.value; atualiza(); };
  $("#gap-linhas").onchange = (ev) => { estado.gap = ev.target.value; atualiza(); };
  for (const b of document.querySelectorAll("[data-mapa]")) b.onclick = () => { estado.mapa = b.dataset.mapa; sincronizaBotoes(); atualiza(); };
  for (const b of document.querySelectorAll("[data-div]")) b.onclick = () => { estado.div = b.dataset.div; sincronizaBotoes(); atualiza(); };
  $("#limpa-tudo").onclick = () => { for (const d of DIMS) estado.filtros[d].clear(); atualiza(); };
  $("#abre-filtros").onclick = () => $("#painel").classList.add("aberto");
  $("#fecha-filtros").onclick = () => $("#painel").classList.remove("aberto");
  sincronizaBotoes();

  const topoH = () => document.documentElement.style.setProperty("--topo-h", `${$(".topo").offsetHeight}px`);
  topoH();
  let pendente;
  new ResizeObserver(() => {
    topoH();
    cancelAnimationFrame(pendente);
    pendente = requestAnimationFrame(() => { if (dados.cubo) atualiza(); });
  }).observe($("#principal"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => atualiza());
}

async function inicia() {
  leHash();
  [meta, municipios, topo] = await Promise.all([json("meta.json"), json("municipios.json.gz"), json("brasil.topo.json")]);
  if (!meta.anos.cubo.includes(estado.ano)) estado.ano = meta.anos.cubo.at(-1);
  const [serie, historia] = await Promise.all([cuboUnico("serie"), cuboUnico("historia")]);
  derivaColuna(serie, "ai", "ano", (a) => a - 1984);
  derivaColuna(historia, "ai", "ano", (a) => a - 1984);
  dados.serie = serie;
  dados.historia = historia;
  montaControles();
  await atualiza({ recarrega: true });
}

inicia().catch((e) => {
  console.error(e);
  $("#resumo").textContent = `Erro ao carregar os dados: ${e.message}`;
});
