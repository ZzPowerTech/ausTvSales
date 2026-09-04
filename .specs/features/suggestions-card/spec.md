# Spec — Card de sugestões v2 (autor, votos e tópico)

> Feature do épico **AusTV Admin**, continuação da S10.2. Atravessa dois repositórios:
> `austv-minecraft/Ticket-Bot` (a maior parte) e `ZzPowerTech/ausTvSales` (uma rota nova).
>
> **Data:** 2026-09-04 · **Origem:** pedido do dono depois da primeira sugestão real criada em
> produção (bot `v0.2.1`), comparando o card atual com o do Carl-bot.

---

## 1. Objetivo

O subsistema de sugestões funciona ponta a ponta desde 2026-09-04, mas o card entrega menos do
que o servidor já esperava de um bot de sugestões: não mostra quem sugeriu, não deixa a comunidade
votar, e não abre espaço para discussão. As três lacunas são de **superfície**, não de mecanismo —
a máquina de estados, a auditoria e a trilha já estão prontas e validadas.

---

## 2. Escopo

### Dentro

| ID | Entrega |
|---|---|
| **R1** | Nick e avatar do autor no embed do card, resolvidos **ao vivo** do Discord |
| **R2** | Votos por **reação** 👍/👎, com a contagem sincronizada para a API |
| **R3** | **Tópico** de discussão criado junto com toda sugestão |
| **R4** | Rota na API para receber a contagem de votos, chaveada por `discord_msg_id` |

### Fora, por decisão do dono (2026-09-04)

**Esconder os botões de Aprovar/Recusar por cargo.** Foi pedido e **não é possível**: componentes
fazem parte da mensagem, e todo mundo que vê a mensagem vê os botões — o Discord não oferece
componentes por-espectador. As três alternativas reais (espelho em canal de staff; moderar só pelo
`/sugestoes` efêmero; manter como está) foram apresentadas, e a escolha foi **manter como está**:
o botão fica visível e a recusa acontece no clique, já registrada na trilha de auditoria.

### Adiado, não esquecido

Mostrar a contagem de votos na listagem `/sugestoes`. O card ganha os números pelas próprias
reações, mas a listagem efêmera não tem reações — e depois da R2 o dado existe na API para isso.
Fica para quando alguém pedir; entra como uma linha, não como projeto.

---

## 3. Decisões tomadas antes do código

Todas do dono, em 2026-09-04, com o custo de cada alternativa na mesa.

### D1 — Autor resolvido **ao vivo**, não congelado

O card lê nick e avatar do Discord na hora de renderizar.

**Por que não congelar,** apesar do precedente do `assignee_nickname`: aquele existe porque o
apelido de quem aprovou aparece **na loja**, fora do Discord, e precisa dizer o que era verdade
naquele dia. Aqui o card **vive dentro do Discord**, ao lado de menções que já se resolvem ao
vivo — congelar o nome do autor ao lado de uma menção que se atualiza sozinha seria inconsistente
dentro do mesmo card. E URL de avatar do Discord **expira**: congelar o link entrega uma imagem
quebrada meses depois, que é pior do que um nome desatualizado.

**O custo aceito:** um card antigo mostra o nick de hoje, e se a pessoa saiu do servidor o card cai
para o nome de usuário global.

### D2 — Votos por **reação**, e não por botão

**O que se perde, e foi aceito com o custo à vista:** a mesma pessoa pode marcar 👍 e 👎; reação
removida não deixa rastro; e a contagem verdadeira mora no Discord, não na API — o que a API
guarda é um **retrato**, e retrato pode ficar velho se um evento se perder.

**Mitigação, e é o que fecha o buraco:** a sincronização envia **valor absoluto**, nunca
incremento. Um evento perdido se corrige sozinho no próximo — com incremento, o erro seria
permanente e invisível.

### D3 — Tópico em **toda** sugestão, na criação

Não só nas aprovadas, e não a partir de um limiar de votos. A discussão é o que ajuda a **decidir**
se aprova, então criá-la depois da aprovação chega tarde. Limiar foi descartado por acrescentar um
número para calibrar, e limiar sem medição vira chute — o mesmo erro que os alertas de saúde já
cobraram uma vez neste épico.

**O custo aceito:** tópico também para sugestão ruim. Tópicos arquivam sozinhos por inatividade.

---

## 4. Requisitos

### R1 — Autor no card

- **R1.1** O embed traz o autor no campo `author` do embed: nome + ícone.
- **R1.2** O nome é o **apelido do servidor** (`displayName`). Quem não tem apelido cai no nome de
  usuário — o próprio Discord já resolve assim.
- **R1.3** O ícone é o avatar **do servidor** quando existe, senão o global.
- **R1.4** Membro que **saiu** do servidor: o card renderiza com o nome de usuário e o avatar
  global; se nem isso for resolvível, renderiza **sem** o bloco de autor. Em nenhum caso a falha de
  resolução impede o card de existir.
- **R1.5** A resolução lê o **cache** primeiro e só busca na API do Discord quando o membro não
  está em cache. O card é repintado a cada transição de estado, e uma busca por repintura
  multiplicaria chamadas sem necessidade.
- **R1.6** A menção do autor **continua** no card. Ela é o que permite clicar e chegar à pessoa, e
  não depende de resolução — some no dia em que a resolução falhar, e o autor ainda estará lá.

### R2 — Votos por reação

- **R2.1** Ao criar o card, o bot semeia 👍 e 👎 na mensagem.
- **R2.2** O bot escuta adição e remoção de reação e sincroniza a contagem com a API.
- **R2.3** Só contam as **duas** emojis semeadas, e só no canal de sugestões configurado. Qualquer
  outra reação é ignorada sem custo de rede.
- **R2.4** A contagem descontada da **própria semente do bot**: uma sugestão sem voto nenhum grava
  `0/0`, não `1/1`.
- **R2.5** O envio é **absoluto** (`{ votes_up, votes_down }`), nunca incremento — ver D2.
- **R2.6** Rajada de reações não vira rajada de chamadas: as atualizações da mesma mensagem são
  agrupadas numa janela curta.
- **R2.7** Falha na API **não** desfaz a reação nem responde ao jogador. Fica no log; o próximo
  evento reenvia o absoluto e corrige.
- **R2.8** O embed **não** exibe números de voto. As reações já os exibem, e duas fontes do mesmo
  número divergem — foi assim que a divergência de contagem apareceu no funil deste épico.
- **R2.9** Reação em mensagem que **não é** uma sugestão conhecida (404 na API) é ignorada em
  silêncio, sem repetir a chamada.

### R3 — Tópico de discussão

- **R3.1** O tópico é criado na mensagem do card, **depois** de a sugestão existir na API — o
  número dela vai no nome.
- **R3.2** Nome: `#<id> — <início do texto>`, com o texto do jogador **escapado e truncado** ao
  limite de 100 caracteres do Discord.
- **R3.3** Arquivamento automático em 24 h de inatividade.
- **R3.4** Falha ao criar o tópico (sem permissão, canal que não aceita tópico, limite atingido)
  **não** derruba a sugestão nem apaga o card: registra no log e segue. A sugestão já existe, e
  destruí-la por causa de um tópico seria trocar o essencial pelo acessório — o mesmo erro que a
  S10.2 já corrigiu uma vez no caminho de criação.

### R4 — Rota de votos na API

- **R4.1** `PUT /suggestions/by-message/:discordMsgId/votes`, corpo `{ votes_up, votes_down }`.
- **R4.2** Chaveada por **id de mensagem**, não por id de sugestão: é o que o evento de reação
  entrega. A alternativa (buscar o id e depois gravar) seria duas chamadas por reação.
- **R4.3** Mesmas guardas do resto da superfície do bot (`BOT_AUTH_GUARDS`: allowlist de IP,
  throttling, chave de serviço).
- **R4.4** `404` quando a mensagem não corresponde a nenhuma sugestão. É o caso normal de alguém
  reagir a outra mensagem do canal, então **não** é erro de servidor.
- **R4.5** Inteiros `>= 0`, validados na entrada. A CHECK do banco já garante, mas erro de
  constraint não é resposta que alguém consiga ler.
- **R4.6** **Sem linha de auditoria por voto.** A trilha existe para decisões de staff; um registro
  por clique de jogador encheria a tabela com o que a própria contagem já resume.

---

## 5. Superfície de ataque

| Entrada | Quem alcança | Controle |
|---|---|---|
| Reação no card | qualquer jogador que vê o canal | não chega à API como dado bruto: só a **contagem agregada** viaja, e o bot é quem a calcula |
| `PUT .../votes` | quem tiver a chave de serviço do bot | `BOT_AUTH_GUARDS` (IP + chave + throttle), como o resto |
| Nome do tópico | texto escrito pelo jogador | escapado e truncado (R3.2), reusando o `sanitizeSuggestionText` que já existe |
| Nick/avatar do autor | apelido escrito pelo jogador | renderizado pelo `renderPlayerText`, como todo texto de pessoa neste card |

**O que a rota de votos aceita e não verifica:** qualquer número que o portador da chave mandar. O
banco não sabe se é verdade. A mitigação não é validação — é que o **Discord é a fonte**, o envio é
absoluto, e o próximo evento sobrescreve. Um número errado é transitório por construção.

---

## 6. Critérios de aceite

| # | Critério | Como verificar |
|---|---|---|
| CA1 | O card mostra nick do servidor e avatar de quem sugeriu | `/sugestao` em produção; comparar com o perfil |
| CA2 | Autor que saiu do servidor não quebra o card | teste com id de membro ausente |
| CA3 | 👍 e 👎 aparecem no card recém-criado | `/sugestao` |
| CA4 | Votar altera `votes_up`/`votes_down` na API | reagir e ler `GET /suggestions/:id` |
| CA5 | Sugestão sem voto grava `0/0`, não `1/1` | ler logo após a criação |
| CA6 | Remover a reação diminui a contagem | reagir, desreagir, ler |
| CA7 | Reação em outra mensagem do canal não gera erro nem escrita | reagir numa mensagem qualquer; conferir o log |
| CA8 | Tópico criado com o número da sugestão no nome | `/sugestao` |
| CA9 | Sem permissão de criar tópico, a sugestão ainda é criada | remover a permissão do bot e tentar |
| CA10 | A rota de votos recusa quem não tem a chave | `curl` sem `X-Api-Key` → 401/403 |

---

## 7. Riscos

- **🔴 Nada disto é verificável fora de produção.** O bot só tem teste unitário; reações, tópicos e
  resolução de membro dependem do gateway do Discord. O padrão desta sprint deve ser o mesmo que
  fechou a S10: lógica pura extraída e testada, casca fina não testada, e **verificação em
  produção como parte do DoD** — não como "depois eu confiro".
- **Rate limit de reação.** Semear duas reações por sugestão é barato; a rajada de votos é que não
  é. R2.6 existe por isso, e o valor da janela precisa sair de medição, não de chute.
- **`members.fetch` na repintura.** R1.5 mitiga com cache, mas um servidor grande com cache frio
  pode transformar cada transição numa chamada extra. Medir antes de assumir que é grátis.
- **Ordem de implantação entre os dois repositórios.** A rota da API tem de subir **antes** do bot
  que a chama, senão toda reação vira 404 no log. Mesma regra que a S10.2 já estabeleceu.

---

## 8. Referências

- Épico: [`.specs/features/austv-admin/spec.md`](../austv-admin/spec.md)
- Decisão de arquitetura bot↔API (S10.2): `CLAUDE.md`, seção AusTV Admin
- Precedente de apelido congelado: `suggestions.assignee_nickname`
