# RAIS · Explorador do emprego formal

Plataforma para explorar no navegador os microdados da Relação Anual de Informações Sociais (RAIS):
vínculos, remuneração, admissões, desligamentos e rotatividade por estado, município, setor,
atividade econômica (CNAE), ocupação (CBO), sexo, raça/cor, idade e escolaridade, de 2006 a 2024,
mais a série histórica desde 1985 e os maiores empregadores por CNPJ (2010–2021).

**https://rafapolo.github.io/rais/**

Não há servidor: o pipeline pré-agrega 2,2 bilhões de vínculos em cubos binários gzipados, e o
navegador faz o crossfilter em JavaScript sobre arrays tipados. O painel da direita mostra cada
dimensão com os *outros* filtros aplicados, então dá para ver como as variáveis se relacionam.

## Dados

| Arquivo | Conteúdo | Dimensões |
|---|---|---|
| `cubo/AAAA.bin.gz` | cubo principal, um por ano | UF × setor × seção CNAE × grupo CBO × sexo × raça × idade × escolaridade |
| `serie.bin.gz` | série 2006–2024 | ano × UF × setor × seção × sexo × raça |
| `historia.bin.gz` | série 1985–2024 | ano × UF × sexo × idade |
| `mun/AAAA.bin.gz` | mapa municipal | município × setor × seção × sexo |
| `ocup/AAAA.bin.gz` | ocupações | família CBO × UF × setor × sexo |
| `empresas/AAAA.json.gz` | maiores empregadores | CNPJ raiz × UF × setor × seção |

Medidas em todos os cubos: vínculos ativos em 31/12, admissões no ano, desligamentos no ano,
soma e contagem da remuneração de dezembro dos vínculos ativos. A remuneração média é corrigida
pelo IPCA médio anual (R$ do último ano). Cada visão avisa quais filtros não consegue aplicar.

A remuneração usa o valor de dezembro, não a média anual: em 2022 o campo de média anual tem
milhares de valores inflados (aparentemente ×100), que distorcem a média nacional.

## Pipeline

Requer a base da [Base dos Dados](https://basedosdados.org/dataset/br-me-rais) em DuckDB
(`br_me_rais`, `br_me_rais_identificada`, `br_bd_diretorios_brasil`, `br_ibge_ipca`).

```sh
python pipeline/extrai.py      # agrega no DuckDB (via SSH) e copia os Parquet para pipeline/bruto/
python pipeline/constroi.py    # gera docs/data/
python -m http.server -d docs  # abre em http://localhost:8000
```

`pipeline/geo/brasil.topo.json` tem os municípios (IBGE) simplificados e as UFs dissolvidas.
