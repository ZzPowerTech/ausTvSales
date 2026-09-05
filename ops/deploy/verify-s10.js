/**
 * Verificacao pos-implantacao do subsistema de sugestoes (AusTV Admin S10).
 *
 * Cobre os itens 1, 2, 3, 4, 5b, 6 e 7 da tabela do `s10-sugestoes.md`.
 *
 * ## Por que roda DENTRO do container do bot
 *
 * Com `BOT_ALLOWED_IPS` fixado no IP do bot na rede da API, um `curl` rodado no
 * HOST chega como loopback e leva 403. Nao e defeito, e a lista funcionando —
 * mas significa que "chamar a API como o bot" so acontece de dentro do
 * container. De quebra, as credenciais vem do ambiente de la: nenhum segredo e
 * digitado na linha de comando nem impresso na saida.
 *
 *   docker cp ops/deploy/verify-s10.js discordbot:/tmp/verify-s10.js
 *   docker exec discordbot node /tmp/verify-s10.js <id-da-sugestao> <seu-discord-id>
 *
 * O `<seu-discord-id>` vai para a trilha de auditoria como autor da tentativa
 * ilegal do item 4. E honesto que seja o real, nao um inventado.
 *
 * ## Os dois itens que este script NAO decide, de proposito
 *
 * - **item 3** (apelido congelado) exige DUAS execucoes com uma troca de
 *   apelido no meio. Uma leitura so e indistinguivel de um valor resolvido ao
 *   vivo — e distinguir os dois e o ponto inteiro do congelamento.
 * - **item 1** (`created_at` = hora do post) exige comparar com o horario da
 *   mensagem no Discord. ATENCAO: a API devolve **UTC** (o `Z` do ISO 8601) e o
 *   Discord mostra no fuso de quem olha. Em America/Sao_Paulo sao 3h de
 *   diferenca aparente, e ja pareceu atraso de gravacao uma vez.
 */

const BASE = process.env.ADMIN_API_BASE_URL;
const KEY = process.env.ADMIN_API_KEY;
const [id, actor] = process.argv.slice(2);

if (!BASE || !KEY) {
  console.error("ADMIN_API_BASE_URL/ADMIN_API_KEY ausentes neste container");
  process.exit(1);
}
if (!id || !actor) {
  console.error("uso: node verify-s10.js <id-da-sugestao> <seu-discord-id>");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(BASE.replace(/\/+$/, "") + path, {
    method,
    headers: {
      "X-Api-Key": KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, body: parsed };
}

const line = (mark, n, msg) => console.log(`${mark} item ${n} — ${msg}`);

(async () => {
  const before = await api("GET", `/suggestions/${id}`);
  if (before.status !== 200) {
    console.error(`sugestao ${id} nao encontrada (HTTP ${before.status})`);
    process.exit(1);
  }
  const s = before.body;
  console.log(`\nSugestao #${s.id} · estado: ${s.status}\n`);

  // ---- item 1 -------------------------------------------------------------
  line("··", 1, `createdAt = ${s.createdAt}`);
  console.log("      compare com o horario da mensagem no Discord — a API devolve UTC.");

  // ---- item 2: idempotencia por discord_msg_id ----------------------------
  // Manda o MESMO id de mensagem com texto e data DIFERENTES. Se a
  // idempotencia valer, a API devolve a linha original e ignora os dois.
  const replay = await api("POST", "/suggestions", {
    discord_msg_id: s.discordMsgId,
    author: s.author,
    text: "TEXTO DIFERENTE - se este aparecer, a idempotencia falhou",
    created_at: new Date().toISOString(),
  });
  const ok2 = replay.body?.id === s.id && replay.body?.text === s.text;
  line(
    ok2 ? "OK" : "!!",
    2,
    ok2
      ? `reenvio devolveu a mesma sugestao (#${replay.body.id}) com o texto original`
      : `reenvio devolveu id=${replay.body?.id} texto=${JSON.stringify(replay.body?.text)?.slice(0, 60)}`,
  );

  // ---- item 4: transicao ilegal -> 409, registro intacto ------------------
  if (s.status === "enviada") {
    const bad = await api("PATCH", `/suggestions/${id}/status`, {
      to: "concluida",
      actor,
      command: "verificacao-s10",
    });
    const after = await api("GET", `/suggestions/${id}`);
    const intact = after.body?.status === s.status;
    line(
      bad.status === 409 && intact ? "OK" : "!!",
      4,
      `enviada->concluida devolveu ${bad.status} (esperado 409); estado depois: ${after.body?.status}`,
    );
  } else {
    line("--", 4, `pulado: so vale a partir de 'enviada', e esta em '${s.status}'`);
  }

  // ---- item 3: apelido congelado -----------------------------------------
  if (s.assigneeNickname) {
    line("··", 3, `assigneeNickname = ${JSON.stringify(s.assigneeNickname)}`);
    console.log("      TROQUE seu apelido no servidor e rode de novo: se MUDAR, nao esta congelado.");
  } else {
    line("--", 3, "pulado: ainda nao aprovada");
  }

  // ---- itens 6 e 5b: a trilha ---------------------------------------------
  const audit = await api("GET", `/suggestions/${id}/audit`);
  const rows = Array.isArray(audit.body) ? audit.body : [];
  const denied = rows.filter(
    (r) => r.action === "transition_denied" || r.action === "auth_denied",
  );
  line(rows.length > 0 ? "OK" : "!!", 6, `${rows.length} entrada(s) na trilha`);
  for (const r of rows) {
    console.log(
      `      ${r.at}  ${r.action}  ${r.fromStatus}->${r.toStatus ?? "-"}  actor=${r.actor}  cmd=${r.command}  ${r.reason ?? ""}`,
    );
  }
  line(
    denied.length > 0 ? "OK" : "!!",
    "5b",
    denied.length > 0
      ? `${denied.length} recusa(s) registrada(s) — a recusa e consultavel`
      : "NENHUMA recusa na trilha. Se um nao-staff ja tentou, o recordDeniedAttempt nao esta gravando.",
  );

  // ---- item 7: paginacao --------------------------------------------------
  // `limit=1` em vez de encher o banco: a propriedade que importa e que `total`
  // seja o do conjunto INTEIRO e que paginas vizinhas nao repitam nem pulem.
  const p0 = await api("GET", "/suggestions?limit=1&offset=0");
  const p1 = await api("GET", "/suggestions?limit=1&offset=1");
  const total = p0.body?.total;
  const a = p0.body?.items?.[0]?.id;
  const b = p1.body?.items?.[0]?.id;
  const ok7 =
    typeof total === "number" && total >= 2 && a !== undefined && b !== undefined && a !== b;
  line(
    ok7 ? "OK" : "!!",
    7,
    `total=${total} (conjunto inteiro), pagina0=#${a}, pagina1=#${b}${a === b ? " — REPETIU" : ""}`,
  );
  if (typeof total === "number" && total < 2) {
    console.log(`      so ha ${total} sugestao(oes); crie outra para exercitar a paginacao.`);
  }

  console.log("");
})();
