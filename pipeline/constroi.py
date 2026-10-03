#!/usr/bin/env python3
"""Converte os Parquet de `pipeline/bruto/` nos arquivos estáticos de `docs/data/`.

Cada cubo vira um binário colunar gzipado (formato em `docs/js/dados.js`):
  [u32 tamanho do cabeçalho][cabeçalho JSON][colunas alinhadas em 8 bytes]
Colunas de 32 bits vão com os bytes transpostos (planos), o que deixa o gzip ~40% menor.
A remuneração vai como média inteira em reais (`rem_m`) e vínculos sem remuneração
(`rem_f` = ativos − rem_n); o navegador reconstrói rem_s e rem_n.
"""

import gzip
import json
import shutil
from pathlib import Path

import numpy as np
import polars as pl

RAIZ = Path(__file__).parent
BRUTO = RAIZ / "bruto"
SAIDA = RAIZ.parent / "docs" / "data"

TIPOS = {np.uint8: "u8", np.uint16: "u16", np.uint32: "u32"}
MEDIDAS = {"ativos": np.uint32, "adm": np.uint32, "desl": np.uint32, "rem_m": np.uint32, "rem_f": np.uint32}

UFS = {
    11: ("RO", "Rondônia", "Norte"), 12: ("AC", "Acre", "Norte"), 13: ("AM", "Amazonas", "Norte"),
    14: ("RR", "Roraima", "Norte"), 15: ("PA", "Pará", "Norte"), 16: ("AP", "Amapá", "Norte"),
    17: ("TO", "Tocantins", "Norte"), 21: ("MA", "Maranhão", "Nordeste"), 22: ("PI", "Piauí", "Nordeste"),
    23: ("CE", "Ceará", "Nordeste"), 24: ("RN", "Rio Grande do Norte", "Nordeste"), 25: ("PB", "Paraíba", "Nordeste"),
    26: ("PE", "Pernambuco", "Nordeste"), 27: ("AL", "Alagoas", "Nordeste"), 28: ("SE", "Sergipe", "Nordeste"),
    29: ("BA", "Bahia", "Nordeste"), 31: ("MG", "Minas Gerais", "Sudeste"), 32: ("ES", "Espírito Santo", "Sudeste"),
    33: ("RJ", "Rio de Janeiro", "Sudeste"), 35: ("SP", "São Paulo", "Sudeste"), 41: ("PR", "Paraná", "Sul"),
    42: ("SC", "Santa Catarina", "Sul"), 43: ("RS", "Rio Grande do Sul", "Sul"),
    50: ("MS", "Mato Grosso do Sul", "Centro-Oeste"), 51: ("MT", "Mato Grosso", "Centro-Oeste"),
    52: ("GO", "Goiás", "Centro-Oeste"), 53: ("DF", "Distrito Federal", "Centro-Oeste"),
}

GG = {
    0: "Forças armadas, policiais e bombeiros", 1: "Dirigentes e gerentes", 2: "Profissionais das ciências e artes",
    3: "Técnicos de nível médio", 4: "Serviços administrativos", 5: "Serviços e vendas",
    6: "Agropecuária, florestal e pesca", 7: "Produção industrial (I)", 8: "Produção industrial (II)",
    9: "Manutenção e reparação", 10: "Não informado",
}


def codifica_rem(df: pl.DataFrame) -> pl.DataFrame:
    if "rem_s" not in df.columns:
        return df
    return df.with_columns(
        pl.when(pl.col("rem_n") > 0).then((pl.col("rem_s") / pl.col("rem_n")).round()).otherwise(0).alias("rem_m"),
        (pl.col("ativos") - pl.col("rem_n")).clip(0).alias("rem_f"),
    )


def grava_bin(df: pl.DataFrame, tipos: dict, destino: Path):
    df = codifica_rem(df)
    cols, partes, off = [], [], 0
    for nome, tipo in tipos.items():
        arr = df[nome].fill_null(0).to_numpy().astype(tipo)
        planos = arr.itemsize == 4
        buf = arr.view(np.uint8).reshape(-1, 4).T.copy().tobytes() if planos else arr.tobytes()
        cols.append({"k": nome, "t": TIPOS[tipo], "o": off, **({"p": 1} if planos else {})})
        pad = (-len(buf)) % 8
        partes.append(buf + b"\0" * pad)
        off += len(buf) + pad
    cab = json.dumps({"n": df.height, "cols": cols}, separators=(",", ":")).encode()
    cab += b" " * ((-(len(cab) + 4)) % 8)
    corpo = np.uint32(len(cab)).tobytes() + cab + b"".join(partes)
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_bytes(gzip.compress(corpo, 9))
    return destino.stat().st_size


def grava_json(obj, destino: Path):
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_bytes(gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), 9))
    return destino.stat().st_size


def por_ano(df, nome, dims, ordem):
    total = 0
    anos = sorted(df["ano"].unique().to_list())
    for ano in anos:
        parte = df.filter(pl.col("ano") == ano).sort(ordem)
        total += grava_bin(parte, {**dims, **MEDIDAS}, SAIDA / nome / f"{ano}.bin.gz")
    print(f"{nome}: {len(anos)} anos, {df.height:,} linhas, {total / 1e6:.1f} MB")
    return anos


def main():
    if SAIDA.exists():
        shutil.rmtree(SAIDA)
    SAIDA.mkdir(parents=True)

    cubo = pl.read_parquet(BRUTO / "cubo.parquet")
    dims_cubo = {k: np.uint8 for k in ["uf", "setor", "secao", "gg", "sexo", "raca", "idade", "esc"]}
    anos_cubo = por_ano(cubo, "cubo", dims_cubo, list(dims_cubo))

    serie_dims = ["ano", "uf", "setor", "secao", "sexo", "raca"]
    serie = cubo.group_by(serie_dims).agg(pl.col(["ativos", "adm", "desl", "rem_s", "rem_n"]).sum()).sort(serie_dims)
    n = grava_bin(serie, {"ano": np.uint16, **{k: np.uint8 for k in serie_dims[1:]}, **MEDIDAS}, SAIDA / "serie.bin.gz")
    print(f"serie: {serie.height:,} linhas, {n / 1e6:.1f} MB")

    dic_mun = pl.read_parquet(BRUTO / "dic_mun.parquet").sort("mun")
    idx_mun = {m: i for i, m in enumerate(dic_mun["mun"].to_list())}
    mun = pl.read_parquet(BRUTO / "mun.parquet").with_columns(
        pl.col("mun").replace_strict(idx_mun, default=None).alias("mi")
    ).filter(pl.col("mi").is_not_null())
    por_ano(mun, "mun", {"mi": np.uint16, "setor": np.uint8, "secao": np.uint8, "sexo": np.uint8}, ["mi"])

    ocup = pl.read_parquet(BRUTO / "ocup.parquet")
    por_ano(ocup, "ocup", {"fam": np.uint16, "uf": np.uint8, "setor": np.uint8, "sexo": np.uint8}, ["fam", "uf"])

    hist = pl.read_parquet(BRUTO / "historia.parquet").filter(pl.col("uf").is_in(list(UFS)))
    n = grava_bin(hist.sort("ano"), {"ano": np.uint16, "uf": np.uint8, "sexo": np.uint8, "idade": np.uint8, **MEDIDAS},
                  SAIDA / "historia.bin.gz")
    print(f"historia: {hist.height:,} linhas, {n / 1e6:.1f} MB")

    emp = pl.read_parquet(BRUTO / "empresas.parquet")
    anos_emp = sorted(emp["ano"].unique().to_list())
    total = 0
    for ano in anos_emp:
        p = emp.filter(pl.col("ano") == ano).sort("ativos", descending=True)
        total += grava_json({
            "cnpj": p["cnpj_basico"].to_list(), "nome": p["nome"].to_list(),
            "uf": p["uf"].to_list(), "setor": p["setor"].to_list(), "secao": p["secao"].to_list(),
            "ativos": p["ativos"].to_list(), "estab": p["estab"].to_list(),
        }, SAIDA / "empresas" / f"{ano}.json.gz")
    print(f"empresas: {len(anos_emp)} anos, {emp.height:,} linhas, {total / 1e6:.1f} MB")

    ipca = pl.read_parquet(BRUTO / "ipca.parquet")
    base = ipca.filter(pl.col("ano") == anos_cubo[-1])["indice"][0]
    deflator = {int(a): round(base / i, 6) for a, i in zip(ipca["ano"], ipca["indice"])}

    secoes = pl.read_parquet(BRUTO / "dic_secao.parquet").sort("secao")
    cbo = pl.read_parquet(BRUTO / "dic_cbo.parquet").unique("fam").sort("fam")

    grava_json({
        "mun": dic_mun["mun"].to_list(), "nome": dic_mun["nome"].to_list(), "uf": dic_mun["uf"].to_list(),
    }, SAIDA / "municipios.json.gz")

    meta = {
        "anos": {"cubo": anos_cubo, "empresas": anos_emp,
                 "historia": sorted(hist["ano"].unique().to_list())},
        "base_preco": anos_cubo[-1],
        "deflator": deflator,
        "dims": {
            "uf": {str(k): v[0] for k, v in UFS.items()},
            "setor": {"1": "Administração pública", "2": "Empresas", "3": "Sem fins lucrativos e outros"},
            "secao": {**{str(s): f"{l} · {nm[0].upper()}{nm[1:].lower()}" for s, l, nm in secoes.iter_rows()}, "21": "Não informada"},
            "gg": {str(k): v for k, v in GG.items()},
            "sexo": {"1": "Homens", "2": "Mulheres"},
            "raca": {"1": "Indígena", "2": "Branca", "3": "Preta", "4": "Amarela", "5": "Parda", "0": "Não informada"},
            "idade": {"1": "até 24", "2": "25–29", "3": "30–39", "4": "40–49", "5": "50–64", "6": "65+"},
            "esc": {"1": "Fundamental incompleto", "2": "Fundamental completo", "3": "Médio completo",
                    "4": "Superior completo", "5": "Mestrado ou doutorado", "0": "Não informada"},
        },
        "uf_nome": {str(k): v[1] for k, v in UFS.items()},
        "uf_regiao": {str(k): v[2] for k, v in UFS.items()},
        "cbo": {str(f): nm for f, nm in cbo.iter_rows() if f is not None},
    }
    (SAIDA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    shutil.copy(RAIZ / "geo" / "brasil.topo.json", SAIDA / "brasil.topo.json")
    print("ok")


if __name__ == "__main__":
    main()
