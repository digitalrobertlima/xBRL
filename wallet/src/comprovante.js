// =====================================================================
// BRLS — Comprovante em português
// Lê a transação direto da blockchain (sem servidor) e explica, em linguagem simples, o que aconteceu:
// quem enviou, quanto, para quem, em qual trabalho, quanto custou a taxa.
// =====================================================================
import "./rede-ponte.js"; // primeiro: dentro do app Android, a rede vem da janela de cima (Tor)
import { ABIS, CREATOR_TREASURY, REDES, REDE_PADRAO, carregarImplantacao, linkTecnico } from "./config.js";
import { enderecoSalvo } from "./keystore.js";
import { marca, roseta } from "./marca.js";
import { ProvedorRotativo } from "./rpc.js";

const E = globalThis.ethers;
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const curto = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ZERO = E.ZeroAddress.toLowerCase();

function fmt(v, dec = 18, casas = 2) {
  const n = Number(E.formatUnits(v, dec));
  return n.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: Math.max(casas, n !== 0 && Math.abs(n) < 0.01 ? 6 : casas) });
}

const params = new URLSearchParams(location.search);
const chainId = Number(params.get("rede") || REDE_PADRAO);
const hash = params.get("tx") || "";

async function main() {
  $("#marca").innerHTML = marca(30);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || !REDES[chainId]) throw new Error("Link de comprovante inválido.");
  const provider = new ProvedorRotativo(REDES[chainId].rpcs, chainId);
  const [tx, rc, imp] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash), carregarImplantacao(chainId)]);
  if (!tx) throw new Error("Transação não encontrada. Ela pode ainda estar sendo enviada: tente de novo em alguns segundos.");
  if (!rc) {
    pintar(`<div class="recibo">${roseta({ tam: 72, tracos: 3 })}<h1>Aguardando a rede</h1><p class="status">A transação foi enviada e ainda não foi confirmada. Atualize em alguns segundos.</p></div>`);
    return;
  }
  const bloco = await provider.getBlock(rc.blockNumber);
  const eu = (enderecoSalvo() || "").toLowerCase();

  // ---------- nomes legíveis ----------
  const nomes = new Map();
  const tokens = new Map();
  if (imp) {
    const n = { xBRL: "Moeda BRLS", ReservaBRL: "Reserva do BRLS", CofreCripto: "Cofre cripto do BRLS", EscrowTrabalho: "Contrato de trabalhos do BRLS", Mensageiro: "Conversas do BRLS", Encaminhador: "Envio sem gás do BRLS" };
    for (const [k, v] of Object.entries(n)) if (imp[k]) nomes.set(imp[k].toLowerCase(), v);
    tokens.set(imp.xBRL.toLowerCase(), { simbolo: "BRLS", decimais: 18 });
  }
  nomes.set(CREATOR_TREASURY.toLowerCase(), "Criador da rede");
  for (const t of REDES[chainId].tokens || []) tokens.set(t.endereco.toLowerCase(), { simbolo: t.simbolo, decimais: t.decimais });
  const quem = (a) => {
    const x = a.toLowerCase();
    if (x === eu) return `<b>Você</b> <span class="quem">${esc(curto(a))}</span>`;
    if (nomes.has(x)) return `<b>${esc(nomes.get(x))}</b>`;
    return `<b>Carteira ${esc(curto(a))}</b><br><span class="quem">${esc(a)}</span>`;
  };
  async function token(end) {
    const x = end.toLowerCase();
    if (!tokens.has(x)) {
      const c = new E.Contract(end, ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], provider);
      const [s, d] = await Promise.all([c.symbol().catch(() => "moeda"), c.decimals().catch(() => 18)]);
      tokens.set(x, { simbolo: String(s).slice(0, 12), decimais: Number(d) });
    }
    return tokens.get(x);
  }

  // ---------- eventos ----------
  const interfaces = [];
  if (imp) for (const k of ["EscrowTrabalho", "ReservaBRL", "CofreCripto", "Mensageiro", "Encaminhador"]) if (imp[k]) interfaces.push([imp[k].toLowerCase(), k, new E.Interface(ABIS[k])]);
  const iErc20 = new E.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)", "event Approval(address indexed owner, address indexed spender, uint256 value)"]);
  const itens = [];
  const add = (ic, texto, valor = "") => itens.push(`<div class="evento"><span class="ic">${ic}</span><div>${texto}${valor ? `<br><b class="valor">${valor}</b>` : ""}</div></div>`);
  const brls = (v) => `R$ ${fmt(v)} em BRLS`;
  const MOD = ["Presencial", "Entrega", "Remoto", "Por etapas"];

  if (tx.value > 0n) add("💠", `${quem(tx.from)} enviou POL (a moeda da taxa) para ${quem(tx.to)}`, `${fmt(tx.value, 18, 4)} POL`);

  for (const log of rc.logs) {
    const end = log.address.toLowerCase();
    const prot = interfaces.find(([a]) => a === end);
    let ev = null;
    try {
      ev = prot ? prot[2].parseLog(log) : iErc20.parseLog(log);
    } catch { ev = null; }
    if (!ev) continue;
    const a = ev.args;
    if (!prot) {
      const t = await token(log.address);
      const v = `${fmt(a.value, t.decimais)} ${esc(t.simbolo)}`;
      if (ev.name === "Approval") add("🔓", `${quem(a.owner)} autorizou ${quem(a.spender)} a usar até`, v);
      else if (a.from.toLowerCase() === ZERO) add("🪙", `${esc(t.simbolo)} criado (emissão) para ${quem(a.to)}`, v);
      else if (a.to.toLowerCase() === ZERO) add("🔥", `${esc(t.simbolo)} destruído (queima) de ${quem(a.from)}`, v);
      else add("💸", `${quem(a.from)} enviou para ${quem(a.to)}`, v);
      continue;
    }
    const id = a.id !== undefined ? `trabalho nº ${a.id}` : "";
    switch (`${prot[1]}.${ev.name}`) {
      case "EscrowTrabalho.TrabalhoCriado":
        add("📝", `${quem(a.cliente)} criou o ${id} (${MOD[Number(a.modalidade)] || "trabalho"}): “${esc(a.descricao)}”. O pagamento ficou travado no contrato até o fim do trabalho.${a.trabalhador.toLowerCase() !== ZERO ? `<br>Trabalhador escolhido: ${quem(a.trabalhador)}` : " Vaga aberta para qualquer pessoa."}<br>Prazo: ${new Date(Number(a.prazo) * 1000).toLocaleDateString("pt-BR")}`, brls(a.valor));
        break;
      case "EscrowTrabalho.TrabalhoAceito": add("🤝", `${quem(a.trabalhador)} começou o ${id}`); break;
      case "EscrowTrabalho.CandidaturaRecebida": add("🙋", `${quem(a.candidato)} se candidatou ao ${id}. O cliente precisa aprovar.`); break;
      case "EscrowTrabalho.CandidaturaEncerrada": add("↩️", `Candidatura de ${quem(a.candidato)} ao ${id} ${a.porCliente ? "recusada pelo cliente" : "retirada"}.`); break;
      case "EscrowTrabalho.ChegadaConfirmada": add("📍", `${quem(a.trabalhador)} chegou ao local do ${id} (confirmado com o código do local).`); break;
      case "EscrowTrabalho.ChegadaConfirmadaPeloCliente": add("📍", `O cliente confirmou a chegada do trabalhador no ${id}.`); break;
      case "EscrowTrabalho.EntregaMarcada": add("📦", `Trabalho marcado como entregue no ${id}${Number(a.etapa) > 1 ? ` (etapa ${a.etapa})` : ""}. O cliente tem 3 dias para conferir.`); break;
      case "EscrowTrabalho.Pagamento": add("✅", `${quem(a.para)} recebeu o pagamento do ${id}. Taxa do protocolo: R$ ${fmt(a.taxa)} (metade para o criador, metade para o colchão de proteção).`, brls(a.liquido)); break;
      case "EscrowTrabalho.Reembolso": add("↩️", `${quem(a.cliente)} recebeu de volta valor do ${id}`, brls(a.valor)); break;
      case "EscrowTrabalho.TrabalhoConcluido": add("🏁", `O ${id} foi concluído.`); break;
      case "EscrowTrabalho.TrabalhoCancelado": add("✖️", `O ${id} foi encerrado sem conclusão.`); break;
      case "EscrowTrabalho.CaucaoTravada": add("🔒", `${quem(a.entregador)} travou a caução do ${id}. Ela volta com o código de entrega ou de devolução.`, brls(a.valor)); break;
      case "EscrowTrabalho.CaucaoLiberada": add("🔓", `Caução do ${id} liberada para ${quem(a.para)}`, brls(a.valor)); break;
      case "EscrowTrabalho.Devolvido": add("↩️", `A mercadoria do ${id} voltou ao cliente (código de devolução).`); break;
      case "EscrowTrabalho.KitGas": add("⛽", `${a.devolvido ? "Gás reservado voltou para" : "Gás para trabalhar entregue a"} ${quem(a.para)} (${id})`, `${fmt(a.valor, 18, 3)} POL`); break;
      case "EscrowTrabalho.DisputaAberta": add("⚖️", `${quem(a.por)} abriu uma disputa no ${id}.`); break;
      case "EscrowTrabalho.AcordoProposto": add("🗣️", `${quem(a.por)} propôs no ${id}: ${Number(a.bpsTrabalhador) / 100}% do restante ao trabalhador.`); break;
      case "EscrowTrabalho.ArbitroPropos": add("⚖️", `O árbitro ${quem(a.arbitro)} propôs no ${id}: ${Number(a.bpsTrabalhador) / 100}% ao trabalhador.`); break;
      case "EscrowTrabalho.ArbitroDoTrabalhador": add("⚖️", `O trabalhador indicou ${quem(a.arbitro)} como árbitro do ${id}.`); break;
      case "EscrowTrabalho.DesempateDoCriador": add("⚖️", `O criador da rede desempatou o ${id}: ${Number(a.bpsTrabalhador) / 100}% ao trabalhador.`); break;
      case "EscrowTrabalho.DisputaResolvida": add("⚖️", `Disputa do ${id} resolvida${a.porAcordo ? " por acordo" : ""}: R$ ${fmt(a.paraTrabalhador)} ao trabalhador e R$ ${fmt(a.paraCliente)} ao cliente.`); break;
      case "EscrowTrabalho.Avaliacao": add("⭐", `${quem(a.avaliador)} deu ${"★".repeat(Number(a.estrelas))} para ${quem(a.avaliado)} (${id}).`); break;
      case "EscrowTrabalho.TrabalhoConfigurado": if (a.caucao > 0n) add("🛡️", `O ${id} exige caução do entregador`, brls(a.caucao)); break;
      case "ReservaBRL.Emitido": add("🏛️", `${quem(a.usuario)} trocou stablecoin de Real por BRLS na Reserva. Taxa: R$ ${fmt(a.taxa)}.`, brls(a.xbrlLiquido)); break;
      case "ReservaBRL.Resgatado": add("🏛️", `${quem(a.usuario)} devolveu BRLS à Reserva e recebeu stablecoin de Real. Taxa: R$ ${fmt(a.taxa)}.`, brls(a.xbrlEntregue)); break;
      case "CofreCripto.Depositado": add("🏦", `${quem(a.conta)} depositou garantia em cripto no cofre.`, fmt(a.quantidade, 18, 6)); break;
      case "CofreCripto.Retirado": add("🏦", `${quem(a.conta)} retirou garantia do cofre.`, fmt(a.quantidade, 18, 6)); break;
      case "CofreCripto.Emitido": add("🪙", `${quem(a.conta)} emitiu BRLS com garantia em cripto (taxa de R$ ${fmt(a.taxa)} somada à dívida).`, brls(a.valor)); break;
      case "CofreCripto.Quitado": add("💳", `${quem(a.pagador)} pagou dívida do cofre de ${quem(a.conta)}.`, brls(a.valor)); break;
      case "CofreCripto.Liquidado": add("⚠️", `A posição de ${quem(a.conta)} ficou sem garantia suficiente e foi liquidada por ${quem(a.liquidante)}. Dívida paga: R$ ${fmt(a.dividaQuitada)}.`); break;
      case "Mensageiro.Mensagem": add("💬", `${quem(a.de)} mandou uma mensagem cifrada (só os participantes conseguem ler).`); break;
      case "Mensageiro.ChaveRegistrada": add("🔑", `${quem(a.conta)} ativou a conversa cifrada.`); break;
      case "Encaminhador.ExecutedForwardRequest": add("📨", `Ação assinada por ${quem(a.signer)} e enviada por ${quem(tx.from)}, que pagou a taxa por ela.${a.success ? "" : " <b>A ação assinada não passou.</b>"}`); break;
      default: break;
    }
  }

  // ---------- taxa ----------
  const taxaPol = rc.gasUsed * (rc.gasPrice ?? tx.gasPrice ?? 0n);
  let taxaReais = "";
  try {
    if (imp?.CofreCripto) {
      const k = new E.Contract(imp.CofreCripto, ABIS.CofreCripto, provider);
      for (let i = 0; i < Number(await k.totalAtivos()); i++) {
        const at = await k.ativo(i);
        if (at.token.toLowerCase() === (imp.criptos?.[1] || "").toLowerCase()) {
          const [p, ok] = await k.precoBrl(i);
          if (ok) taxaReais = ` (≈ R$ ${fmt((taxaPol * p) / 10n ** 18n, 18, 2)})`;
        }
      }
    }
  } catch { /* sem preço: mostra só em POL */ }

  const certo = rc.status === 1;
  const quando = new Date(Number(bloco.timestamp) * 1000);
  const tecnico = linkTecnico(chainId, "tx", hash);
  pintar(`
    <article class="recibo">
      ${roseta({ tam: 84, tracos: 4, classe: "desenhar" })}
      <h1>Comprovante</h1>
      <p class="status ${certo ? "certo" : "falhou"}">${certo ? "✅ Confirmado na blockchain" : "✖️ Não aconteceu: a rede recusou esta operação e nada mudou de dono"}</p>
      <p class="serie" style="text-align:center">${esc(quando.toLocaleDateString("pt-BR", { dateStyle: "full" }))}, ${esc(quando.toLocaleTimeString("pt-BR"))}</p>
      <h2>O que aconteceu</h2>
      ${itens.join("") || `<p class="mudo">Nenhuma movimentação de dinheiro nesta transação.</p>`}
      <h2>Taxa da rede</h2>
      <div class="evento"><span class="ic">⛽</span><div>Paga por ${quem(tx.from)} para a rede Polygon processar a operação. Não vai para o BRLS.<br><b class="valor">${fmt(taxaPol, 18, 5)} POL${taxaReais}</b></div></div>
      <h2>Para conferir</h2>
      <p class="mudo">Este comprovante é público e não pode ser alterado por ninguém. Qualquer pessoa confere com o código abaixo.</p>
      <p class="quem">Código da transação: ${esc(hash)}<br>Bloco nº ${rc.blockNumber.toLocaleString("pt-BR")} · rede ${esc(REDES[chainId].nome)}</p>
    </article>
    <button class="btn prim" id="compartilhar">Compartilhar comprovante</button>
    ${tecnico ? `<a class="btn sec" href="${esc(tecnico)}" target="_blank" rel="noopener">Ver a versão técnica (em inglês)</a>` : ""}
    <a class="btn sec" href="./">Abrir a carteira</a>`);
  $("#compartilhar").addEventListener("click", () => {
    if (navigator.share) navigator.share({ title: "Comprovante BRLS", url: location.href }).catch(() => {});
    else navigator.clipboard?.writeText(location.href).then(() => ($("#compartilhar").textContent = "Link copiado"));
  });
}

function pintar(html) {
  $("#tela").innerHTML = html;
}

main().catch((e) => pintar(`<div class="recibo">${roseta({ tam: 72, tracos: 3 })}<h1>Não deu para abrir</h1><p class="status falhou">${esc(e?.message || e)}</p><a class="btn sec" href="./">Abrir a carteira</a></div>`));
