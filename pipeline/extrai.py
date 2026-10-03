#!/usr/bin/env python3
"""Agrega os microdados da RAIS (basedosdados) em cubos Parquet.

Roda o DuckDB no host que guarda a base (por padrão via SSH no `beelink`),
grava os Parquet lá e copia para `pipeline/bruto/`.

Uso:
  python pipeline/extrai.py                 # todos os cubos
  python pipeline/extrai.py cubo mun        # só alguns
  RAIS_HOST=outro python pipeline/extrai.py
  RAIS_LOCAL=1 DB_PATH=base.duckdb python pipeline/extrai.py
"""

import os
import subprocess
import sys
from pathlib import Path

HOST = os.environ.get("RAIS_HOST", "beelink")
LOCAL = os.environ.get("RAIS_LOCAL") == "1"
DB = os.environ.get("DB_PATH", "~/rodado/basedosdados.duckdb")
DUCKDB = os.environ.get("DUCKDB_BIN", "~/bin/duckdb")
REMOTE_OUT = os.environ.get("REMOTE_OUT", "~/rodado/_export/rais")
BRUTO = Path(__file__).parent / "bruto"

V = "br_me_rais.microdados_vinculos"

DERIVADAS = """
  CAST(left(id_municipio, 2) AS UTINYINT) AS uf,
  CASE left(natureza_juridica, 1) WHEN '1' THEN 1 WHEN '2' THEN 2 ELSE 3 END AS setor,
  CASE sexo WHEN '1' THEN 1 WHEN '2' THEN 2 ELSE 0 END AS sexo_,
  CASE raca_cor WHEN '1' THEN 1 WHEN '2' THEN 2 WHEN '4' THEN 3 WHEN '6' THEN 4 WHEN '8' THEN 5 ELSE 0 END AS raca,
  CASE WHEN idade < 25 THEN 1 WHEN idade < 30 THEN 2 WHEN idade < 40 THEN 3
       WHEN idade < 50 THEN 4 WHEN idade < 65 THEN 5 ELSE 6 END AS idade_,
  CASE WHEN grau_instrucao_apos_2005 IN ('1','2','3','4') THEN 1
       WHEN grau_instrucao_apos_2005 IN ('5','6') THEN 2
       WHEN grau_instrucao_apos_2005 IN ('7','8') THEN 3
       WHEN grau_instrucao_apos_2005 = '9' THEN 4
       WHEN grau_instrucao_apos_2005 IN ('10','11') THEN 5 ELSE 0 END AS esc,
  coalesce(CAST(left(cbo_2002, 1) AS UTINYINT), 10) AS gg,
  coalesce(try_cast(left(cbo_2002, 4) AS USMALLINT), 0) AS fam,
  coalesce(ascii(s.secao) - 65, 21) AS secao,
  CAST(id_municipio AS UINTEGER) AS mun,
  vinculo_ativo_3112 = '1' AS ativo,
  mes_admissao BETWEEN 1 AND 12 AND tipo_admissao NOT IN ('0', '-1') AS admitido,
  mes_desligamento BETWEEN 1 AND 12 AS desligado,
  CASE WHEN vinculo_ativo_3112 = '1' AND valor_remuneracao_dezembro > 0 THEN valor_remuneracao_dezembro END AS rem
"""

MEDIDAS = """
  count(*) FILTER (WHERE ativo) AS ativos,
  count(*) FILTER (WHERE admitido) AS adm,
  count(*) FILTER (WHERE desligado) AS desl,
  sum(rem) AS rem_s,
  count(rem) AS rem_n
"""

BASE = f"""
WITH sec AS (
  SELECT DISTINCT left(lpad(subclasse, 7, '0'), 2) AS div, secao FROM br_bd_diretorios_brasil.cnae_2
), v AS (
  SELECT ano, {DERIVADAS}
  FROM {V} LEFT JOIN sec s ON s.div = left(lpad(cnae_2_subclasse, 7, '0'), 2)
  WHERE ano BETWEEN 2006 AND 2024
)
"""

CUBOS = {
    "cubo": BASE + f"""
SELECT ano, uf, setor, secao, gg, sexo_ AS sexo, raca, idade_ AS idade, esc, {MEDIDAS}
FROM v GROUP BY ALL""",
    "mun": BASE + f"""
SELECT ano, mun, setor, secao, sexo_ AS sexo, {MEDIDAS}
FROM v GROUP BY ALL""",
    "ocup": BASE + f"""
SELECT ano, fam, uf, setor, sexo_ AS sexo, {MEDIDAS}
FROM v GROUP BY ALL""",
    "historia": f"""
SELECT ano,
  CAST(left(id_municipio, 2) AS UTINYINT) AS uf,
  CASE sexo WHEN '1' THEN 1 WHEN '2' THEN 2 ELSE 0 END AS sexo,
  CASE WHEN faixa_etaria IN ('1','2','3') THEN 1 WHEN faixa_etaria = '4' THEN 2 WHEN faixa_etaria = '5' THEN 3
       WHEN faixa_etaria = '6' THEN 4 WHEN faixa_etaria = '7' THEN 5 WHEN faixa_etaria = '8' THEN 6 ELSE 0 END AS idade,
  count(*) FILTER (WHERE vinculo_ativo_3112 = '1') AS ativos,
  count(*) FILTER (WHERE mes_admissao BETWEEN 1 AND 12 AND tipo_admissao NOT IN ('0', '-1')) AS adm,
  count(*) FILTER (WHERE mes_desligamento BETWEEN 1 AND 12) AS desl,
  sum(valor_remuneracao_dezembro) FILTER (WHERE vinculo_ativo_3112 = '1' AND valor_remuneracao_dezembro > 0 AND ano >= 1999) AS rem_s,
  count(*) FILTER (WHERE vinculo_ativo_3112 = '1' AND valor_remuneracao_dezembro > 0 AND ano >= 1999) AS rem_n
FROM {V} WHERE id_municipio IS NOT NULL GROUP BY ALL""",
    "empresas": """
WITH sec AS (
  SELECT DISTINCT left(lpad(subclasse, 7, '0'), 2) AS div, secao FROM br_bd_diretorios_brasil.cnae_2
), e AS (
  SELECT ano, cnpj_basico,
    CAST(left(id_municipio, 2) AS UTINYINT) AS uf,
    CASE left(natureza_juridica, 1) WHEN '1' THEN 1 WHEN '2' THEN 2 ELSE 3 END AS setor,
    coalesce(ascii(s.secao) - 65, 21) AS secao,
    razao_social, quantidade_vinculos_ativos AS v
  FROM br_me_rais_identificada.estabelecimentos
  LEFT JOIN sec s ON s.div = left(lpad(cnae_fiscal_principal, 7, '0'), 2)
  WHERE quantidade_vinculos_ativos > 0 AND id_municipio IS NOT NULL
), g AS (
  SELECT ano, cnpj_basico, uf, setor, secao, sum(v) AS ativos, count(*) AS estab, arg_max(razao_social, v) AS nome
  FROM e GROUP BY ALL
), r AS (
  SELECT *,
    row_number() OVER (PARTITION BY ano, uf, secao ORDER BY ativos DESC) AS r_us,
    row_number() OVER (PARTITION BY ano, uf ORDER BY ativos DESC) AS r_u,
    row_number() OVER (PARTITION BY ano, secao ORDER BY ativos DESC) AS r_s
  FROM g
)
SELECT ano, cnpj_basico, uf, setor, secao, ativos, estab, nome FROM r
WHERE r_us <= 20 OR r_u <= 150 OR r_s <= 150""",
    "dic_mun": """
SELECT CAST(id_municipio AS UINTEGER) AS mun, nome, sigla_uf, CAST(id_uf AS UTINYINT) AS uf, nome_regiao
FROM br_bd_diretorios_brasil.municipio""",
    "dic_cbo": """
SELECT DISTINCT try_cast(familia AS USMALLINT) AS fam, descricao_familia AS nome FROM br_bd_diretorios_brasil.cbo_2002
WHERE familia IS NOT NULL""",
    "dic_secao": """
SELECT DISTINCT ascii(secao) - 65 AS secao, secao AS letra, descricao_secao AS nome FROM br_bd_diretorios_brasil.cnae_2""",
    "ipca": """
SELECT ano, avg(indice) AS indice FROM br_ibge_ipca.mes_brasil WHERE ano BETWEEN 1994 AND 2024 GROUP BY ano ORDER BY ano""",
}


def roda(nome, sql):
    alvo = f"{REMOTE_OUT}/{nome}.parquet"
    script = f"""
SET threads = 14;
SET memory_limit = '20GB';
SET preserve_insertion_order = false;
SET temp_directory = '{REMOTE_OUT}/tmp';
COPY ({sql}) TO '{alvo}' (FORMAT parquet, COMPRESSION zstd);
"""
    cmd = [os.path.expanduser(DUCKDB) if LOCAL else DUCKDB, "-readonly", DB]
    if not LOCAL:
        cmd = ["ssh", HOST, f"mkdir -p {REMOTE_OUT}/tmp && {DUCKDB} -readonly {DB}"]
    print(f"→ {nome}", flush=True)
    proc = subprocess.run(cmd, input=script.encode(), capture_output=True)
    if proc.returncode != 0 or b"Error" in proc.stderr:
        raise RuntimeError(f"{nome}: {proc.stderr.decode()}")
    BRUTO.mkdir(exist_ok=True)
    origem = alvo if LOCAL else f"{HOST}:{alvo}"
    subprocess.run(["scp", "-q", origem, str(BRUTO / f"{nome}.parquet")], check=True)


if __name__ == "__main__":
    nomes = sys.argv[1:] or list(CUBOS)
    for n in nomes:
        roda(n, CUBOS[n])
