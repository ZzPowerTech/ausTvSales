# ADR-0003 — Biblioteca de gráfico do dashboard (Chart.js vs ECharts)

- **Status:** Proposto (aguardando aprovação do Murilo)
- **Data:** 2026-07-20
- **História:** S5.4 (spike) — sprint 5
- **Responsáveis:** `frontend-specialist` + `devops-specialist`
- **Decisor:** Murilo
- **Fecha:** ponto em aberto #1 do [spec da S5](../features/sprint-05-dashboard-analytics/spec.md) (§7) e primeiro critério de aceite da S5.4

## Contexto

A S5.4 precisa de um gráfico de **série temporal por item**: eventos de venda
agregados por dia, com alternância **quantidade × receita**, respeitando o filtro
de período da página (presets 7d/30d/custom) e com granularidade de dia como
padrão. O visual é o do AusTV — cores e tipografia vêm dos tokens em
[`frontend/src/styles/_tokens.scss`](../../frontend/src/styles/_tokens.scss)
(tema escuro único; a série de dados usa `--color-chart-series`), **nada** do tema
default da lib (spec §5.3).

Uma restrição de arquitetura já foi **fechada pelo Murilo em 2026-07-20** e não é
reaberta aqui (sprint-05.md §"Nota de revisão" item 4):

- A lib **deve ser agnóstica de framework**, instanciada **direto** num `effect`
  do componente Angular, **sem wrapper** (`ng2-charts` e similares estão
  descartados). Motivo: wrappers demoram a suportar major novo, e o projeto está
  em **Angular 22 / TypeScript 6** — um wrapper incompatível travaria a S5.4 no
  meio do sprint. Efeito colateral desejado: controle total sobre os tokens
  visuais.

Portanto a decisão **deste** ADR é apenas a escolha entre as duas candidatas
nomeadas no plano: **Chart.js vs ECharts**. Ambas são agnósticas de framework,
MIT/Apache, instanciáveis via `new` num `effect` com `destroy()` no teardown —
então o eixo real de decisão é: peso de bundle, esforço para chegar ao visual
AusTV (o que é preciso *desligar* do default), adequação ao caso de uso concreto
(série diária pré-agregada pelo backend) e acessibilidade.

### Fato que enviesa a comparação: o backend já entrega os dados prontos

O contrato da S5.1 (spec §2.4) devolve a série **já bucketizada por dia**, com os
pontos como strings de data (`{ "at": "2026-07-01", "qtd": 12, "revenue":
"1440.00" }`) e a janela **limitada a 366 buckets** (§2.8). Ou seja: o gráfico
recebe ≤366 pontos, ordenados, com o eixo X já discretizado em dias. **Não há
dataset denso, nem necessidade de eixo de tempo contínuo, zoom, streaming ou
downsampling no cliente** — exatamente as áreas em que o ECharts brilha.

## Comparação

| Critério | Chart.js v4 | ECharts v5 |
|---|---|---|
| **Bundle (tree-shaken, gzip)** | ~30 KB para um único tipo de gráfico (linha), com registro explícito de controllers/scales/plugins (v4+) | ~100 KB de piso mesmo importando só `LineChart` + componentes; núcleo mais pesado |
| **Tree-shaking / ESM** | Sim (v4+); registra-se só o que se usa | Sim; importa-se `echarts/core` + módulos, mas o piso é ~3× o do Chart.js |
| **Eixo temporal do caso de uso** | Eixo **de categoria** sobre as strings de dia que a API já manda — **zero dependência extra** de adapter de data | `xAxis.type: 'time'` nativo e potente — mas desnecessário aqui, já que os dias vêm prontos |
| **"Desligar o tema default"** | Não há tema visual imposto: o `options` object define tudo. Alimentar cor/tipografia a partir de `_tokens.scss` é preencher o options — não há nada a *desativar* | Tem tema default (`registerTheme`/tema embutido). Para o visual AusTV é preciso sobrescrever tema **e** estilos de série/eixo/tooltip — mais peças a neutralizar |
| **Toggle quantidade × receita** | Trocar `data` do dataset + eixo Y e `chart.update()` — trivial | Trocar `series`/`yAxis` via `setOption(..., { notMerge })` — também simples, com mais superfície de options |
| **Ciclo de vida no `effect`** | `new Chart(canvas, cfg)` → `chart.update()` na troca de período → `chart.destroy()` no teardown | `echarts.init(el)` → `setOption()` → `dispose()`; equivalente |
| **Acessibilidade** | **Fraca**: canvas invisível a leitor de tela sem ARIA manual — exige fallback textual/tabela ao lado | **Melhor**: módulo `aria` (importar `AriaComponent`, `aria.enabled`) gera `aria-label` por série + decals para CVD; recomenda-se renderer **SVG** |
| **Licença** | MIT | Apache-2.0 |
| **Maturidade / manutenção** | Muito madura; padrão de fato para dashboards de linha/barra simples; comunidade enorme | Muito madura; projeto Apache; força em viz densa/complexa (mapas, heatmaps, grandes volumes) |

## Decisão

**Chart.js v4**, importado como ESM com registro explícito de componentes
(tree-shaking), instanciado direto num `effect` do componente Angular, **sem
wrapper**. Para a série diária, usar **eixo de categoria** sobre as strings de dia
que a S5.1 já devolve — dispensando qualquer adapter de data.

> Versão: fixar na **última da linha 4.x** no momento de instalar na S5.4 (linha
> 4.5.x na data deste ADR — a versão exata deve ser conferida no `npm install`,
> ver "Incertezas" abaixo).

**Argumento decisivo:** para uma série **única, diária e pré-agregada pelo
backend** (≤366 pontos), o Chart.js tree-shaka para ~1/3 do piso do ECharts,
**não precisa de adapter de data** (o eixo de categoria consome as strings de dia
direto), e **não impõe tema visual** — o `options` object é alimentado
diretamente de `_tokens.scss`, que é exatamente o "controle total sobre os tokens"
que a restrição sem-wrapper busca. Os pontos fortes do ECharts (datasets densos,
zoom, mapas, eixo de tempo contínuo, módulo `aria` embutido) ficam **quase todos
ociosos** neste caso — seu bundle maior e sua máquina de temas seriam custo sem
contrapartida. A acessibilidade é o único eixo em que o ECharts lidera, mitigável
(ver Consequências) e de menor risco num painel **interno de admin único**
(ADR-0002).

## Consequências

- **Bundle.** Import seletivo obrigatório — registrar apenas
  `LineController`, `LineElement`, `PointElement`, `LinearScale`, `CategoryScale`,
  `Tooltip`, `Legend` (e `Filler` se houver área). **Nunca** `import Chart from
  'chart.js/auto'`, que anula o tree-shaking e traz todos os controllers. Meta
  prática: manter o custo do gráfico em ~30 KB gzip. Como o backend já entrega
  dias prontos, **não** entra `chartjs-adapter-luxon`/`date-fns` — o eixo é
  `type: 'category'`.

- **Tema via `_tokens.scss` (nada de default).** As cores/tipografia são lidas em
  runtime dos custom properties — `getComputedStyle(host).getPropertyValue('--color-chart-series')`
  etc. — e injetadas no `options` object (cor da linha/ponto de `--color-chart-series`,
  grid de `--color-line`, texto de `--color-ink`/`--color-ink-muted`, fonte de
  `--font-body`). Regra do design system respeitada: **dado veste roxo**
  (`--color-chart-series`), a cor segue a entidade e nunca o accent
  (`--color-accent`) nem o gold (VIP). Não há tema da lib a desativar; só se
  preenche o options. Tema escuro único (o AusTV não tem variante clara).

- **Ciclo de vida no `effect` (spec §5.2).** Instância criada uma vez com
  `new Chart(canvasRef, config)`; troca de período/toggle chama
  `chart.update()` (atualiza, **não** recria); teardown chama `chart.destroy()`
  no cleanup do `effect` — gráfico não destruído em rota que troca é vazamento de
  memória e listener duplicado.

- **Alternância quantidade × receita.** Um Signal controla o modo; o `effect`
  reescreve `data.datasets[0].data` e o rótulo do eixo Y e chama `update()`. A
  receita vem como **string** da API (spec §2.5) e é convertida para número
  **só na fronteira do gráfico** (o `<canvas>` precisa de `number`), formatando
  os ticks/tooltip com `Intl.NumberFormat('pt-BR', currency BRL)` — nunca
  `parseFloat` espalhado pela app.

- **`excludedHistorical` (CA7).** Renderizado como **anotação/baseline textual
  fora da área de plotagem** (spec §2.4/§5.3) — nunca como ponto datado. Sem
  plugin extra: é texto no template ao lado do canvas.

- **Acessibilidade — o trade-off assumido.** Canvas do Chart.js é opaco a leitor
  de tela. Mitigação obrigatória na S5.4: `role="img"` + `aria-label` com resumo
  no elemento do gráfico **e** uma tabela equivalente visualmente oculta
  (`.sr-only`) com os pontos da série — dados que a página já possui. Aceitável
  porque o dashboard é ferramenta **interna de admin único via allowlist**
  (ADR-0002), não superfície pública. Se o público mudar, reavaliar (o ECharts
  com renderer SVG + módulo `aria` seria o caminho — geraria um novo ADR).

- **Manutenção/segurança.** +1 dependência de runtime no `frontend/package.json`
  (MIT). Sem wrapper = sem dependência que precise "alcançar" o Angular 22; o
  acoplamento é só com a API pública estável do Chart.js. `devops-specialist`
  acompanha a fixação de versão e o custo no bundle no PR da S5.4.

## Alternativas consideradas

- **ECharts v5 (a outra candidata) — rejeitada para este caso.** Tecnicamente
  superior para viz densa/complexa e com melhor história de acessibilidade
  embutida (módulo `aria`, decals), mas seus diferenciais ficam ociosos numa
  série **única, diária e já agregada** de ≤366 pontos. Custa ~3× o bundle do
  Chart.js tree-shaken e traz uma máquina de temas que **precisaria ser
  neutralizada** para chegar ao visual AusTV — o oposto do "nada a desligar" do
  Chart.js. Fica como **caminho de evolução** se o dashboard passar a precisar de
  gráficos densos, mapas, zoom/brush ou de acessibilidade forte por padrão
  (aí, novo ADR).

- **Wrapper Angular (`ng2-charts` etc.) — já descartado pelo Murilo**, fora do
  escopo deste ADR (sprint-05.md §"Nota de revisão" item 4): risco de atraso de
  suporte a major novo (Angular 22) e perda de controle sobre os tokens.

- **Chart.js com eixo de tempo (`type: 'time'` + adapter Luxon/date-fns) —
  rejeitada.** Adicionaria uma dependência de adapter de data sem ganho: a API já
  entrega os dias discretizados; eixo de categoria basta e é mais leve. Reavaliar
  só se surgir granularidade sub-diária (hora/semana), que o contrato aceita mas
  o MVP não implementa (spec §7 item 4).

## Referências

- [`sprint-05.md`](../sprints/sprint-05.md) — S5.4 e §"Nota de revisão" (restrição sem-wrapper)
- [`spec.md`](../features/sprint-05-dashboard-analytics/spec.md) — §2.4 (contrato da série), §2.5 (dinheiro como string), §2.8 (limite de 366 buckets), §5 (S5.4)
- [`_tokens.scss`](../../frontend/src/styles/_tokens.scss) — tokens visuais do AusTV
- [ADR-0002](ADR-0002-permissoes-dashboard.md) — admin único via allowlist (contexto do trade-off de acessibilidade)
