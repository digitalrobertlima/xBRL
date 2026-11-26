// =====================================================================
// BRLS — Carteira Nativa (PWA) — máquina de estados travada
// - Só transições declaradas em TRANSICOES são possíveis (botão "voltar" do aparelho não fura o bloqueio).
// - A frase/chave só existe na memória enquanto a carteira está desbloqueada (auto-bloqueio em 5 min).
// - Ações que movem dinheiro exigem "deslizar para confirmar"; desbloqueio exige "deslizar" + PIN.
// - Chegada ao local é comprovada por código/QR (palavras), nunca por GPS (falsificável).
// =====================================================================
import { REDE_PELA_PONTE } from "./rede-ponte.js"; // primeiro: no app Android, a rede vem pela Caixa Forte (Tor)
import { carregarImplantacaoBeta } from "./config.js";
import { ABIS, COFRE, CREATOR_TREASURY, ESCROW, REDE_PADRAO, REDES, SEGURANCA, TANQUE, VERSAO, carregarImplantacao, linkExplorer } from "./config.js";
import * as K from "./keystore.js";
import * as G from "./gas-tank.js";
import { EscrowClient, REGRAS_NIVEL, codigoGuardado, codigoTemFormatoValido, gerarCodigoEntrega, guardarCodigo, hashChegada, hashCodigo, hashDevolucao, idConversa, normalizarCodigo } from "./escrow-client.js";
import { Chat, MAX_CARACTERES, cifrar as cifrarChat, decifrar as decifrarChat } from "./chat.js";
import * as SG from "./semgas.js";
import { marca, roseta } from "./marca.js";
import { ProvedorRotativo } from "./rpc.js";
import { AssinanteExterno, conectarInjetada, procurarPonte, temInjetada } from "./externa.js";
import qrcode from "./vendor/qrcode.mjs";
import { VEICULOS, VALIDADES_HORAS, descricaoCorrida, lerCorrida, enderecoCorrida, passoCorrida, tarifas, gravarTarifas, voltarTarifasPadrao, precoSugerido, distanciaKm, PREFIXO_CONTRA } from "./corrida.js";
import { rotaPelaRua } from "./rota.js";
import { escolherPonto, botoesGps, textoDoPonto, coordenadasNoTexto, fmtCoord, mapaFixo } from "./mapa.js";
import * as CO from "./correio.js";
import { CATEGORIAS, CAT, STATUS, ENTREGAS, MAX_FOTOS, Vitrine, codificar, conversaVitrine, montarItens, novoId, precoBr } from "./vitrine.js";

const E = globalThis.ethers;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[c]);
const curto = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const agora = () => Math.floor(Date.now() / 1000);

// ----------------------------------------------------------------------------
// Estado da sessão (somente memória)
// ----------------------------------------------------------------------------
const S = {
  tela: null,
  params: {},
  chainId: REDE_PADRAO,
  rede: null,
  provider: null,
  imp: null, // endereços do protocolo nesta rede (ou null)
  carteira: null, // HDNodeWallet conectada — só enquanto desbloqueada
  endereco: K.enderecoSalvo(),
  frasePendente: null,
  pinPendente: null,
  ultimoUso: Date.now(),
  escrow: null,
  tokensInfo: [],
};

// ----------------------------------------------------------------------------
// Máquina de estados
// ----------------------------------------------------------------------------
const ABERTAS = ["VITRINE", "ANUNCIO", "ANUNCIAR", "MEUS_ANUNCIOS", "LOJA_EDITAR", "LOJA", "SACOLA", "CORRIDA", "MOTORISTA", "MEU_CARRO", "TARIFAS", "GANHOS", "INICIO", "ENVIAR", "RECEBER", "RESERVA", "COFRE", "EXTRATO", "TRABALHOS", "TRABALHO_NOVO", "TRABALHO", "CHAT", "TANQUE", "AJUSTES", "BACKUP"];
const TRANSICOES = {
  CARREGANDO: ["BOAS_VINDAS", "BLOQUEADA", "INICIO"],
  BOAS_VINDAS: ["CRIAR_FRASE", "RESTAURAR", "VAGAS_PUBLICAS", "INICIO"],
  VAGAS_PUBLICAS: ["BOAS_VINDAS", "CRIAR_FRASE", "RESTAURAR"],
  CRIAR_FRASE: ["CONFIRMAR_FRASE", "BOAS_VINDAS"],
  CONFIRMAR_FRASE: ["DEFINIR_PIN", "CRIAR_FRASE"],
  RESTAURAR: ["DEFINIR_PIN", "BOAS_VINDAS"],
  DEFINIR_PIN: ["CONFIRMAR_PIN", "BOAS_VINDAS"],
  CONFIRMAR_PIN: ["DEFINIR_PIN", "INICIO"],
  BLOQUEADA: ["INICIO", "BOAS_VINDAS"],
};
for (const t of ABERTAS) TRANSICOES[t] = [...ABERTAS, "BLOQUEADA"];
TRANSICOES.AJUSTES.push("BOAS_VINDAS");

function ir(destino, params = {}) {
  const permitido = S.tela === null || destino === S.tela || (TRANSICOES[S.tela] || []).includes(destino);
  if (!permitido) {
    console.warn(`Transição bloqueada: ${S.tela} → ${destino}`);
    return false;
  }
  if (ABERTAS.includes(destino) && !S.carteira) return ir("BLOQUEADA");
  S.tela = destino;
  S.params = params;
  if (S.querAcesa) telaAcesa(false);
  const viva = lerViva();
  setTimeout(() => desenharFaixaViva(S.carteira ? viva : null), 0);
  const aberta = ABERTAS.includes(destino);
  $("#abas").hidden = !aberta;
  $("#btn-bloquear").hidden = !aberta || !!S.externa;
  for (const b of $$("#abas button")) b.toggleAttribute("aria-current", false);
  const aba = { ANUNCIO: "VITRINE", ANUNCIAR: "VITRINE", MEUS_ANUNCIOS: "VITRINE", LOJA_EDITAR: "VITRINE", LOJA: "VITRINE", SACOLA: "VITRINE", CORRIDA: "TRABALHOS", MOTORISTA: "TRABALHOS", MEU_CARRO: "TRABALHOS", TARIFAS: "TRABALHOS", GANHOS: "TRABALHOS", TRABALHO_NOVO: "TRABALHOS", TRABALHO: "TRABALHOS", CHAT: "TRABALHOS", COFRE: "RESERVA", EXTRATO: "INICIO", ENVIAR: "INICIO", RECEBER: "INICIO", TANQUE: "INICIO", BACKUP: "AJUSTES" }[destino] || destino;
  $(`#abas button[data-ir="${aba}"]`)?.setAttribute("aria-current", "page");
  if (aberta) history.replaceState({ tela: destino }, "", location.pathname + location.search);
  window.scrollTo(0, 0);
  render().catch(mostrarErro);
  return true;
}

// O botão "voltar" do sistema nunca sai do estado atual de forma insegura.
history.pushState({ trava: true }, "", location.href);
window.addEventListener("popstate", () => {
  if (location.hash.startsWith("#" + SG.PREFIXO)) return receberPedidoDoLink(); // link de pedido sem gás, não é "voltar"
  history.pushState({ trava: true }, "", location.href);
  if (ABERTAS.includes(S.tela) && S.tela !== "INICIO") ir("INICIO");
});

// ----------------------------------------------------------------------------
// Utilidades de UI
// ----------------------------------------------------------------------------
function tela(html) {
  const m = $("#tela");
  m.innerHTML = html;
  m.focus({ preventScroll: true });
  ligarSegurar(m);
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3800);
}

function modal(html) {
  $("#modal-corpo").innerHTML = html;
  $("#modal").hidden = false;
  ligarSegurar($("#modal-corpo"));
}
function fecharModal() {
  $("#modal").hidden = true;
}

const MENSAGENS = {
  NaoAutorizado: "Você não tem permissão para esta ação.",
  ValorZero: "Informe um valor maior que zero.",
  LastroInsuficiente: "A reserva não tem saldo suficiente desse lastro. Escolha outro.",
  LimiteJanelaResgate: "Limite de resgate das últimas 24 h atingido (proteção da Fase 2). Tente mais tarde.",
  LimiteEmissaoDiaria: "Limite diário de emissão com este lastro atingido (proteção contra drenagem). Use o outro lastro ou tente amanhã.",
  ChegadaObrigatoria: "O trabalhador ainda não confirmou a chegada com o código.",
  ValorBaixoParaAvaliar: "Só trabalhos a partir de 10 BRLS podem ser avaliados.",
  EmissaoPausada: "Emissão com este lastro está pausada. Resgates seguem livres.",
  SaidaMinimaNaoAtingida: "A cotação mudou. Atualize e tente de novo.",
  CodigoIncorreto: "Código incorreto.",
  RevisaoEmAndamento: "O cliente ainda tem prazo para revisar a entrega.",
  PrazoNaoVencido: "O prazo ainda não venceu.",
  PrazoInvalido: "Prazo inválido.",
  EstadoInvalido: "O trabalho mudou de situação. Atualize a tela.",
  JaAvaliou: "Você já avaliou este trabalho.",
  TetoDaReservaAtingido: "A versão beta tem um teto pequeno de reserva e ele foi atingido. Obrigado por testar!",
  ArbitroInvalido: "Árbitro inválido: precisa ser outra pessoa (nem o cliente, nem o trabalhador).",
  CaucaoInvalida: "Regra da caução: a mercadoria só sai com o código de entrega ou de devolução.",
  SemDisputaNaEntrega: "Entrega não tem disputa: só o código de entrega (ou de devolução) resolve.",
  ForaDoIntervaloDosArbitros: "O desempate precisa ficar entre as propostas dos dois árbitros.",
  AguardandoArbitros: "Ainda é a vez dos árbitros (3 dias).",
  PrecoIndisponivel: "Preço da cripto indisponível ou divergente agora. Pagar dívida e depositar continuam liberados.",
  GarantiaInsuficiente: "Garantia insuficiente para isso. Deposite mais ou emita menos.",
  TetoDeDivida: "O teto de emissão deste cofre foi atingido (limite da versão beta).",
  DividaMinima: "A dívida precisa ser zero ou pelo menos 10 BRLS.",
  PosicaoSaudavel: "Essa posição está saudável: não pode ser liquidada.",
  ColateralInsuficiente: "Você não tem essa quantidade depositada.",
  MensagemInvalida: "Mensagem grande demais.",
  ERC20InsufficientBalance: "Saldo insuficiente.",
  ERC20InsufficientAllowance: "Autorização insuficiente.",
};

function traduzirErro(e) {
  const nome = e?.revert?.name || e?.info?.error?.data?.name;
  if (nome && MENSAGENS[nome]) return MENSAGENS[nome];
  const msg = String(e?.shortMessage || e?.message || e);
  if (/insufficient funds/i.test(msg)) return "POL insuficiente para a taxa da rede. Abasteça o tanque.";
  if (/user rejected|denied/i.test(msg)) return "Operação cancelada.";
  if (/missing revert data|execution reverted|CALL_EXCEPTION/i.test(msg)) return "A rede recusou a operação. O mais comum é faltar BRLS (o valor fica travado) ou POL para a taxa. Confira os saldos na tela Início.";
  if (/network|fetch|timeout|failed to detect/i.test(msg)) return "Sem conexão com a rede Polygon. Verifique a internet.";
  return msg.length > 180 ? msg.slice(0, 180) + "…" : msg;
}

function mostrarErro(e) {
  console.error(e);
  fecharModal();
  toast("⚠️ " + traduzirErro(e));
}

/** Botões "deslize para confirmar": arraste a bolinha até o fim (toque, mouse ou setas do teclado).
 *  Não depende de segurar: o menu de contexto de tablets/Androids não aparece porque não há pressão parada. */
function ligarSegurar(raiz) {
  for (const b of $$(".segurar", raiz)) {
    if (b.dataset.ligado) continue;
    b.dataset.ligado = "1";
    const rotulo = b.textContent.trim().replace(/^[✋👉]\s*/u, "").replace(/^Segure para/i, "Deslize para");
    b.innerHTML = `<span class="fio" aria-hidden="true">»</span><i>${esc(rotulo)}</i>`;
    b.setAttribute("role", "slider");
    b.setAttribute("aria-label", rotulo);
    b.setAttribute("aria-valuemin", "0");
    b.setAttribute("aria-valuemax", "100");
    b.setAttribute("aria-valuenow", "0");
    const fio = b.querySelector(".fio");
    let x0 = 0;
    let max = 0;
    let arrastando = false;
    const pos = (p) => {
      const q = Math.max(0, Math.min(1, p));
      b.style.setProperty("--p", `${q * 100}%`);
      fio.style.transform = `translateX(${q * max}px)`;
      b.setAttribute("aria-valuenow", String(Math.round(q * 100)));
      return q;
    };
    const medir = () => { max = Math.max(1, b.clientWidth - fio.offsetWidth - 12); };
    const concluir = () => {
      navigator.vibrate?.(40);
      b.dispatchEvent(new CustomEvent("confirmado", { bubbles: true }));
      setTimeout(() => { fio.style.transition = "transform .2s"; pos(0); }, 120); // volta ao início: dá para tentar de novo se der erro
    };
    const soltar = () => {
      if (!arrastando) return;
      arrastando = false;
      b.classList.remove("arrastando");
      const p = parseFloat(b.style.getPropertyValue("--p")) / 100;
      fio.style.transition = "transform .2s";
      if (p >= 0.88) { pos(1); concluir(); } else pos(0);
    };
    fio.addEventListener("pointerdown", (ev) => {
      if (b.disabled) return;
      ev.preventDefault();
      medir();
      fio.style.transition = "none";
      x0 = ev.clientX;
      arrastando = true;
      b.classList.add("arrastando");
      try { fio.setPointerCapture(ev.pointerId); } catch { /* sem captura */ }
    });
    fio.addEventListener("pointermove", (ev) => { if (arrastando) pos((ev.clientX - x0) / max); });
    fio.addEventListener("pointerup", soltar);
    fio.addEventListener("pointercancel", soltar);
    fio.addEventListener("lostpointercapture", soltar);
    // Nada de menu do aparelho nem seleção de texto
    for (const el of [b, fio]) {
      el.addEventListener("contextmenu", (ev) => ev.preventDefault());
      el.addEventListener("selectstart", (ev) => ev.preventDefault());
      el.addEventListener("dragstart", (ev) => ev.preventDefault());
    }
    // Teclado: setas empurram a bolinha; chegando ao fim, confirma
    b.addEventListener("keydown", (ev) => {
      if (b.disabled || !["ArrowRight", "ArrowLeft", "Home"].includes(ev.key)) return;
      ev.preventDefault();
      medir();
      const p = parseFloat(b.style.getPropertyValue("--p") || "0") / 100;
      if (ev.key === "ArrowLeft" || ev.key === "Home") return pos(ev.key === "Home" ? 0 : p - 0.25);
      const q = pos(p + 0.25);
      if (q >= 1) concluir();
    });
    b.addEventListener("click", (ev) => ev.preventDefault());
  }
}

function botaoSegurar(texto, acao, extra = "") {
  return `<button class="btn prim segurar" data-confirmar="${esc(acao)}" ${extra}><i>👉 Deslize para ${esc(texto)}</i></button>`;
}

// ---------- Números em reais ----------
function fmt(v, dec = 18, casas = 2) {
  const n = Number(E.formatUnits(v ?? 0n, dec));
  return n.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: Math.max(casas, n < 1 && n > 0 ? 6 : casas) });
}
const reais = (v, dec = 18) => `R$ ${fmt(v, dec)}`;
function lerValor(txt, dec = 18) {
  let s = String(txt || "").trim().replace(/\s|R\$/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Valor inválido");
  const [i, f = ""] = s.split(".");
  return E.parseUnits(`${i}.${f.slice(0, dec) || "0"}`, dec);
}

// ----------------------------------------------------------------------------
// Rede e contratos
// ----------------------------------------------------------------------------
function escolherRedeInicial() {
  const q = new URLSearchParams(location.search).get("rede");
  const salva = Number(localStorage.getItem("xbrl.rede"));
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const pedida = Number(q) || salva || REDE_PADRAO;
  if (REDES[pedida]?.somenteDev && !local) return REDE_PADRAO;
  return REDES[pedida] ? pedida : REDE_PADRAO;
}

async function conectarRede(chainId) {
  S.chainId = chainId;
  S.rede = REDES[chainId];
  S.provider = new ProvedorRotativo(S.rede.rpcs, chainId);
  S.imp = await carregarImplantacao(chainId);
  const beta = await carregarImplantacaoBeta(chainId);
  S.beta = beta && S.imp && beta.xBRL.toLowerCase() !== S.imp.xBRL.toLowerCase() ? beta : null;
  S.escrow = S.imp ? new EscrowClient(S.provider, chainId, S.imp.EscrowTrabalho, S.imp.blocoInicial) : null;
  S.chat = S.imp ? new Chat(S.provider, S.imp.Mensageiro, S.imp.blocoInicial) : null;
  if (S.chat) S.chat.encaminhador = S.imp.Encaminhador || null;
  S.vitrine = S.imp?.Mensageiro ? new Vitrine(S.provider, chainId, S.imp.Mensageiro, S.imp.blocoInicial) : null;
  const chip = $("#rede");
  chip.textContent = S.rede.curto;
  chip.classList.toggle("teste", chainId !== 137);
  if (S.carteira) S.carteira = S.carteira.connect(S.provider);
  S.tokensInfo = await montarListaTokens();
}

async function montarListaTokens() {
  const lista = [];
  if (S.imp) lista.push({ simbolo: "BRLS", nome: "Real Soberano", endereco: S.imp.xBRL, decimais: 18, principal: true });
  const conhecidos = new Set(lista.map((t) => t.endereco.toLowerCase()));
  for (const t of S.rede.tokens) {
    if (!conhecidos.has(t.endereco.toLowerCase())) {
      lista.push(t);
      conhecidos.add(t.endereco.toLowerCase());
    }
  }
  const extras = [...(S.imp?.lastros || []).map((l) => [l, true]), ...(S.imp?.criptos || []).map((l) => [l, false])];
  for (const [l, ehLastro] of extras) {
    if (conhecidos.has(l.toLowerCase())) continue;
    try {
      const c = new E.Contract(l, ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], S.provider);
      const [simbolo, decimais] = await Promise.all([c.symbol(), c.decimals()]);
      lista.push({ simbolo: String(simbolo).slice(0, 12), nome: ehLastro ? "Lastro" : "Cripto", endereco: l, decimais: Number(decimais), lastro: ehLastro, cripto: !ehLastro });
      conhecidos.add(l.toLowerCase());
    } catch { /* lastro ilegível: ignora na lista */ }
  }
  return lista;
}

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function torneira()",
];
const c = (nome, assinar = false) => new E.Contract(S.imp[nome], ABIS[nome], assinar ? S.carteira : S.provider);
const erc20 = (end, assinar = false) => new E.Contract(end, ERC20, assinar ? S.carteira : S.provider);

async function opcoesGas() {
  const [fd, bloco] = await Promise.all([S.provider.getFeeData(), S.provider.getBlock("latest")]);
  const min = S.rede.prioridadeMinimaGwei * 10n ** 9n;
  let prio = fd.maxPriorityFeePerGas ?? min;
  if (prio < min) prio = min;
  const base = bloco?.baseFeePerGas ?? fd.gasPrice ?? 0n;
  return { maxPriorityFeePerGas: prio, maxFeePerGas: base * 2n + prio };
}

/** Executa uma sequência de transações com feedback claro. `passos` = [{rotulo, fn: (opts)=>Promise<tx>}] */
async function executar(titulo, passos) {
  let ultimo;
  try {
    const opts = await opcoesGas();
    // Tanque automático: garante POL antes, se o usuário ativou.
    const preferidos = S.tokensInfo.filter((t) => t.principal || t.lastro || t.simbolo === "USDC").map((t) => ({ endereco: t.endereco, simbolo: t.simbolo, decimais: t.decimais, moeda: t.moeda || "BRL" }));
    modal(`<div class="giro"></div><h2>${esc(titulo)}</h2><p class="mudo">Verificando o tanque de gás…</p>`);
    const auto = S.externa ? null : await G.abastecerSeNecessario(S.provider, S.carteira, S.chainId, preferidos, opts, [S.imp?.xBRL]).catch(() => null);
    if (auto) { S.ultimoAbastecimento = Date.now(); toast(`⛽ Tanque abastecido com ${auto.simbolo}`); }
    // Sem POL para terminar? Se der, vira pedido sem gás (QR/link) para outra pessoa enviar.
    const saldoPol = await S.provider.getBalance(S.endereco);
    const precisa = opts.maxFeePerGas * 400_000n * BigInt(passos.length);
    if (saldoPol < precisa) {
      if (S.imp?.Encaminhador && passos.every((p) => p.chamada || p.permit)) {
        await pedirSemGas(titulo, passos);
        return "semgas";
      }
      throw new Error(`Falta POL para a taxa da rede (precisa de uns ${fmt(precisa, 18, 3)} POL, você tem ${fmt(saldoPol, 18, 3)}).`);
    }
    for (const [i, p] of passos.entries()) {
      modal(`<div class="giro"></div><h2>${esc(titulo)}</h2><p>Passo ${i + 1} de ${passos.length}: ${esc(p.rotulo)}</p><p class="mudo">Assinando no seu aparelho…</p>`);
      S.descricaoAtual = `${titulo}: ${p.rotulo}`;
      const tx = await p.fn(opts);
      if (!tx) continue;
      const link = linkExplorer(S.chainId, "tx", tx.hash);
      modal(`<div class="giro"></div><h2>${esc(titulo)}</h2><p>Passo ${i + 1} de ${passos.length}: ${esc(p.rotulo)}</p><p class="mudo">Aguardando a rede confirmar…</p>${link ? `<p><a href="${esc(link)}" target="_blank" rel="noopener">Ver no explorador</a></p>` : ""}`);
      ultimo = await tx.wait();
      if (ultimo.status !== 1) throw new Error("A transação falhou na rede");
    }
    const link = ultimo ? linkExplorer(S.chainId, "tx", ultimo.hash) : "";
    modal(`<h2>✅ ${esc(titulo)}</h2><p>Confirmado na Polygon.</p>${link ? `<p><a href="${esc(link)}" target="_blank" rel="noopener">Ver comprovante público</a></p>` : ""}<button class="btn prim" data-acao="fechar-modal">Ok</button>`);
    return ultimo;
  } catch (e) {
    modal(`<h2>Não foi possível concluir</h2><div class="erro">${esc(traduzirErro(e))}</div><button class="btn sec" data-acao="fechar-modal">Fechar</button>`);
    throw e;
  }
}

/** Monta o pedido sem gás e mostra o QR + link para outra pessoa enviar. */
async function pedirSemGas(titulo, passos) {
  const chamadas = passos.filter((p) => p.chamada).map((p) => p.chamada);
  const ap = passos.find((p) => p.permit);
  let permit = null;
  if (ap && (await erc20(ap.permit.token).allowance(S.endereco, ap.permit.gastador)) < ap.permit.valor) permit = { token: ap.permit.token, valor: ap.permit.valor };
  modal(`<div class="giro"></div><h2>${esc(titulo)}</h2><p class="mudo">Assinando no seu aparelho (não custa nada)…</p>`);
  const texto = await SG.assinar(S.carteira, S.provider, S.imp.Encaminhador, chamadas, permit);
  const link = `${location.origin}${location.pathname}#${texto}`;
  S.pedidoProprio = link;
  // Dentro de um trabalho: manda direto para o app da outra parte (ela aceita ou recusa)
  const t = S.tela === "TRABALHO" ? S.params.t : null;
  let postado = false;
  if (t) {
    modal(`<div class="giro"></div><h2>${esc(titulo)}</h2><p class="mudo">Mandando o pedido para o app da outra pessoa…</p>`);
    postado = await CO.postar(S.chainId, S.imp.EscrowTrabalho, t.id, texto).catch(() => false);
  }
  if (postado) {
    const cor = lerCorrida(S.escrow.resumoTrabalhos().get(String(t.id))?.descricao);
    const souCliente = t.cliente.toLowerCase() === S.endereco.toLowerCase();
    const quem = cor ? (souCliente ? "do motorista" : "do passageiro") : souCliente ? "do trabalhador" : "do cliente";
    modal(`<h2>📨 Pedido enviado</h2>
      <p>Você está sem POL, então assinou de graça: <b>${esc(titulo)}</b>. O pedido foi <b>direto para o app ${quem}</b>, que vai ver um aviso para aceitar ou recusar (e paga a taxa, centavos).</p>
      <p class="mudo">Esta tela atualiza sozinha quando a pessoa aceitar. Ela precisa estar com o app BRLS aberto. O pedido vale por 2 horas.</p>
      <details class="cartao"><summary>Estão juntos? Mostrar o QR</summary>${qrSvg(texto)}<button class="btn sec" data-acao="semgas-compartilhar">📤 Mandar por WhatsApp/link</button></details>
      <button class="btn prim" data-acao="fechar-modal">Ok, vou aguardar</button>`);
    return null;
  }
  modal(`<h2>⛽ Sem POL? Sem problema</h2>
    <p>Você assinou: <b>${esc(titulo)}</b>. Agora peça para a outra pessoa (o cliente, por exemplo) <b>ler este QR</b> no app BRLS dela, em <b>Trabalhos → 📷 Ler pedido sem gás</b>. Ela paga a taxa e a ação vale como sua.</p>
    ${qrSvg(texto)}
    <button class="btn sec" data-acao="semgas-compartilhar">📤 Mandar por WhatsApp/link</button>
    <p class="mudo">Vale por 2 horas e só para esta ação. Ninguém consegue usar para outra coisa.</p>
    <button class="btn prim" data-acao="semgas-pronto">Já enviaram — atualizar</button>`);
  return null;
}

/** Quem tem POL lê/abre o pedido de outra pessoa e envia por ela. */
/** Link "…#brls:…" aberto com o app já rodando. */
function receberPedidoDoLink() {
  if (!location.hash.startsWith("#" + SG.PREFIXO)) return;
  const txt = location.hash.slice(1);
  history.replaceState({ trava: true }, "", location.pathname + location.search);
  if (S.carteira && ABERTAS.includes(S.tela)) abrirPedidoSemGas(txt).catch(mostrarErro);
  else S.pedidoRecebido = txt;
}

async function abrirPedidoSemGas(texto) {
  if (!S.imp?.Encaminhador) throw new Error("Esta rede ainda não aceita pedidos sem gás");
  const d = SG.decodificar(texto);
  const descricoes = d.pedidos.map((p) => SG.descrever(p, S.imp));
  await SG.conferir(S.provider, S.imp, d);
  S.params.pedidoSemGas = d;
  modal(`<h2>📨 Pedido sem gás</h2>
    <p><b>${esc(curto(d.pedidos[0].from))}</b> assinou e pediu para você enviar:</p>
    <div class="cartao">${descricoes.map((x) => `<p>• ${esc(x)}</p>`).join("")}${d.permit ? `<p>• autorizar o contrato a usar ${fmt(d.permit.valor)} BRLS dela (caução)</p>` : ""}</div>
    <p class="mudo">Você paga só a taxa da rede (centavos). Nenhum dinheiro seu é usado na ação.</p>
    ${botaoSegurar("enviar pela pessoa", "semgas-enviar")}
    <button class="btn sec" data-acao="fechar-modal">Agora não</button>`);
}

/** Passo de envio de mensagem cifrada: também pode virar pedido sem gás. */
function passoMensagem(rotulo, prep) {
  const m = c("Mensageiro", true);
  const args = [prep.conversa, prep.para, prep.cifrados, prep.registrar];
  return { rotulo, fn: (o) => m.enviar(...args, o), chamada: { to: S.imp.Mensageiro, data: m.interface.encodeFunctionData("enviar", args), gas: 600_000 } };
}

/** Passo de uma ação do Escrow: pode virar pedido sem gás. */
function passoEscrow(rotulo, metodo, args, gas = 500_000) {
  const k = c("EscrowTrabalho", true);
  return { rotulo, fn: (o) => k[metodo](...args, o), chamada: { to: S.imp.EscrowTrabalho, data: k.interface.encodeFunctionData(metodo, args), gas } };
}

/** Aprova só o necessário (nunca infinito). */
function passoAprovar(token, gastador, valor, rotulo = "Autorizar") {
  const ehBrls = S.imp && token.toLowerCase() === S.imp.xBRL.toLowerCase();
  return {
    rotulo,
    permit: ehBrls ? { token, gastador, valor } : null,
    fn: async (o) => {
      const atual = await erc20(token).allowance(S.endereco, gastador);
      return atual >= valor ? null : erc20(token, true).approve(gastador, valor, o);
    },
  };
}

// ----------------------------------------------------------------------------
// Sessão: desbloqueio e auto-bloqueio
// ----------------------------------------------------------------------------
function abrirSessao(frase) {
  S.carteira = K.carteiraDaFrase(frase).connect(S.provider);
  S.endereco = S.carteira.address;
  S.ultimoUso = Date.now();
}

/** Conecta uma carteira de fora (Caixa Forte, MetaMask, Rabby): ela assina, o BRLS lê. */
function conectarExterna(conexao) {
  S.externa = conexao;
  S.carteira = new AssinanteExterno(conexao, S.provider, () => S.descricaoAtual || "");
  S.endereco = conexao.endereco;
  S.ultimoUso = Date.now();
  conexao.aoTrocarConta?.((novo) => {
    if (!novo || !E.isAddress(novo)) return;
    // A carteira de fora pode avisar a mesma conta de novo (ex.: ao atualizar saldos): nada muda, nada recarrega.
    if (S.endereco && E.getAddress(novo) === E.getAddress(S.endereco)) return;
    conectarExterna({ ...conexao, endereco: E.getAddress(novo) });
    toast("Conta trocada na carteira conectada");
    render();
  });
}

function bloquear() {
  if (S.externa) return; // quem tranca é a carteira conectada
  if (ABERTAS.includes(S.tela) && S.tela !== "INICIO") S.voltarPara = { tela: S.tela, params: S.params };
  S.carteira = null;
  S.frasePendente = null;
  S.pinPendente = null;
  fecharModal();
  S.tela = "BLOQUEADA";
  ir("BLOQUEADA");
}

["pointerdown", "keydown", "scroll"].forEach((ev) => addEventListener(ev, () => (S.ultimoUso = Date.now()), { passive: true }));
setInterval(() => {
  if (S.carteira && !S.externa && Date.now() - S.ultimoUso > SEGURANCA.bloqueioAutomaticoMs) bloquear();
}, 10_000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { S.ocultoEm = Date.now(); return; }
  if (S.carteira && !S.externa && S.ocultoEm && Date.now() - S.ocultoEm > 60_000) return bloquear();
  // Voltou para o app: atualiza na hora (sem esperar o próximo ciclo), religa a tela acesa e,
  // se houver corrida em andamento e a pessoa estiver em outra tela, leva direto para ela.
  if (S.querAcesa) telaAcesa(true);
  S.vigiaFn?.().catch(() => {});
  const fora = S.ocultoEm ? Date.now() - S.ocultoEm : 0;
  if (S.carteira && fora > 10_000) voltarParaCorrida(true).catch(() => {});
});

// ---------- Corrida em andamento: nunca se perde (app fechado, bateria acabou, bloqueio, outra tela) ----------
const CHAVE_VIVA = "xbrl.corrida.viva";
const lerViva = () => { try { const v = JSON.parse(localStorage.getItem(CHAVE_VIVA) || "null"); return v && v.chain === S.chainId ? v : null; } catch { return null; } };

/** A corrida em andamento desta conta (passageiro ou motorista), ou null. Fica lembrada no aparelho. */
async function corridaViva() {
  if (!S.escrow || !S.endereco) return null;
  await S.escrow.sincronizar();
  const { meus } = await S.escrow.listar(S.endereco);
  const eu = S.endereco.toLowerCase();
  for (const r of minhasCorridas(meus).slice(0, 6)) {
    const t = await S.escrow.detalhe(r.id).catch(() => null);
    if (!t || t.estado >= 4) continue;
    const souP = t.cliente.toLowerCase() === eu;
    const souM = [t.trabalhador, t.candidato].some((a) => a && a.toLowerCase() === eu);
    if (!souP && !souM) continue;
    const tela = souP && t.estado === 0 && !t.pendenteAprovacao && t.trabalhador === E.ZeroAddress ? "CORRIDA" : "TRABALHO";
    const v = { id: String(t.id), tela, texto: passoCorrida(t, souP).texto, chain: S.chainId, souP };
    try { localStorage.setItem(CHAVE_VIVA, JSON.stringify(v)); } catch { /* ok */ }
    return v;
  }
  try { localStorage.removeItem(CHAVE_VIVA); } catch { /* ok */ }
  return null;
}
const naTelaDaCorrida = (v) => (v.tela === "TRABALHO" ? S.tela === "TRABALHO" && String(S.params?.id) === v.id : S.tela === "CORRIDA");

/** Leva para a corrida em andamento (se houver e a pessoa não estiver nela). */
async function voltarParaCorrida(avisar) {
  const v = await corridaViva();
  desenharFaixaViva(v);
  if (!v || naTelaDaCorrida(v) || !ABERTAS.includes(S.tela) || $("#modal")?.hidden === false) return false;
  if (avisar) toast("🚗 Você tem uma corrida em andamento");
  ir(v.tela, v.tela === "TRABALHO" ? { id: v.id } : {});
  return true;
}

/** Depois de desbloquear/conectar: volta para a corrida, ou para onde a pessoa estava. */
async function aoEntrar() {
  const volta = S.voltarPara;
  S.voltarPara = null;
  if (await voltarParaCorrida(true).catch(() => false)) return;
  atualizarVivos().then(() => desenharFaixaViva(lerViva())).catch(() => {});
  if (volta && S.tela === "INICIO" && ABERTAS.includes(volta.tela)) ir(volta.tela, volta.params);
}

/** Faixa fixa "Corrida em andamento" em todas as telas, enquanto houver corrida. */
function desenharFaixaViva(v) {
  let f = $("#faixa-viva");
  // Sem corrida: a faixa mostra os trabalhos/contratações em andamento (mesmo jeito da corrida)
  const tv = !v ? S.trabalhosVivos : null;
  const naTela = v ? naTelaDaCorrida(v) : tv && (S.tela === "TRABALHOS" || S.tela === "TRABALHO_NOVO" || S.tela === "CHAT" || (S.tela === "TRABALHO" && tv.lista.some((x) => x.id === String(S.params.id))));
  const mostrar = (v || tv?.lista.length) && S.carteira && ABERTAS.includes(S.tela) && !naTela;
  if (!mostrar) { f?.remove(); return; }
  if (!f) {
    f = document.createElement("button");
    f.id = "faixa-viva";
    f.type = "button";
    f.addEventListener("click", () => {
      const x = lerViva();
      if (x) return ir(x.tela, x.tela === "TRABALHO" ? { id: x.id } : {});
      const l = S.trabalhosVivos?.lista || [];
      if (l.length === 1) ir("TRABALHO", { id: l[0].id }); else ir("TRABALHOS", { aba: "meus" });
    });
    document.body.appendChild(f);
  }
  if (v) { f.classList.remove("trabalho"); f.innerHTML = `<b>🚗 Corrida em andamento</b><span>${esc(v.texto)}</span><i>Abrir ›</i>`; return; }
  f.classList.add("trabalho");
  const l = tv.lista;
  const um = l[0];
  f.innerHTML = l.length === 1
    ? `<b>${esc(um.titulo)}</b><span>${esc(um.fase.texto)}</span>${barraFases(um.fase, true)}<i>Abrir ›</i>`
    : `<b>📋 ${l.length} trabalhos em andamento</b><span>${esc(resumoVivos(l))}</span><i>Ver ›</i>`;
}

// ---------- Fases de um trabalho (barra de progresso para quem contratou e para quem trabalha) ----------
/**
 * t: resumo (eventos) ou detalhe (contrato) — usa estado, modalidade, trabalhador, pendenteAprovacao, chegou, etapas.
 * Devolve { passos: [nomes], atual (índice), texto (o que acontece agora, para quem vê), alerta? }.
 */
function fasesTrabalho(t, souCliente, extra = {}) {
  const z = E.ZeroAddress;
  const m = Number(t.modalidade);
  const comChegada = extra.comChegada ?? t.comChegada;
  const passos = ["Publicado", "Aceito"];
  if (m === 0 && comChegada) passos.push("Chegou");
  if (m === 3) passos.push(`Etapas (${t.etapasPagas || 0}/${t.etapas || 0})`);
  else if (m !== 1) passos.push("Feito");
  else passos.push("Entregue");
  passos.push("Pago");
  const ultimo = passos.length - 1;
  const semTrab = !t.trabalhador || t.trabalhador === z;
  let atual = 0;
  let texto;
  if (t.estado === 4) return { passos, atual: ultimo + 1, texto: souCliente ? "✅ Concluído e pago" : "✅ Concluído: você recebeu" };
  if (t.estado === 5) return { passos, atual: 0, texto: "↩️ Cancelado: o valor voltou para quem contratou", cancelado: true };
  if (t.estado === 3) return { passos, atual: ultimo, texto: "⚖️ Em disputa: aguardando acordo", alerta: true };
  if (t.estado === 0 && t.pendenteAprovacao) { atual = 0; texto = souCliente ? "🙋 Alguém quer fazer: aprove ou recuse" : "⏳ Esperando o contratante aprovar você"; }
  else if (t.estado === 0 && semTrab) { atual = 0; texto = souCliente ? "🔎 Procurando quem faça" : "Vaga aberta"; }
  else if (t.estado === 0) { atual = 0; texto = souCliente ? "⏳ Esperando a pessoa aceitar" : "📩 Você foi chamado: aceite ou recuse"; }
  else if (t.estado === 1) {
    atual = 1;
    if (m === 0 && comChegada && !t.chegou) texto = souCliente ? "🚶 Trabalhador a caminho" : "🚶 Vá até o local e use o código de chegada";
    else {
      if (m === 0 && comChegada) atual = 2;
      if (m === 1) texto = souCliente ? "🛵 A caminho: dê o código só ao receber" : "🛵 Leve até o destino e peça o código";
      else if (m === 3) { atual = passos.length - 2; texto = souCliente ? `🧱 Em execução: etapa ${(t.etapasPagas || 0) + 1} de ${t.etapas}` : `🧱 Faça a etapa ${(t.etapasPagas || 0) + 1} de ${t.etapas}`; }
      else texto = souCliente ? "🛠️ Em execução" : "🛠️ Você está executando: marque como feito ao terminar";
    }
  } else if (t.estado === 2) { atual = ultimo; texto = souCliente ? "👀 Feito: confira e libere o pagamento" : "⏳ Feito: esperando o contratante liberar (ou 3 dias)"; }
  return { passos, atual, texto };
}

/** Barra de fases: bolinhas numeradas por passo (feito / agora / depois). `mini` = só a barra fina. */
function barraFases(f, mini = false) {
  const n = f.passos.length;
  const pct = f.cancelado ? 0 : Math.min(100, Math.round((Math.min(f.atual, n) / n) * 100 + (f.atual < n ? 100 / n / 2 : 0)));
  if (mini) return `<span class="fases-mini ${f.alerta ? "alerta" : ""}" aria-hidden="true"><span style="width:${pct}%"></span></span>`;
  return `<ol class="fases ${f.alerta ? "alerta" : ""} ${f.cancelado ? "cancelado" : ""}" aria-label="Andamento: ${esc(f.texto)}">${f.passos
    .map((p, i) => `<li class="${i < f.atual ? "feito" : i === f.atual ? "agora" : ""}"${i === f.atual ? ' aria-current="step"' : ""}><i>${i < f.atual ? "✓" : i + 1}</i><span>${esc(p)}</span></li>`)
    .join("")}</ol><p class="fase-agora ${f.alerta ? "alerta" : ""}">${esc(f.texto)}</p>`;
}

/** Meus trabalhos em andamento (sem as corridas, que têm a faixa delas), com o papel e a fase. */
function trabalhosVivos(meus) {
  const eu = S.endereco.toLowerCase();
  const lista = meus
    .filter((t) => !t.encerrado && !lerCorrida(t.descricao))
    .map((t) => {
      const souCliente = t.cliente.toLowerCase() === eu;
      const fase = fasesTrabalho(t, souCliente);
      const emExec = t.estado >= 1;
      const titulo = souCliente ? (emExec ? "🤝 Sua contratação está em execução" : "🤝 Você tem uma contratação em aberto") : emExec ? "🛠️ Você está executando um trabalho" : "📩 Você tem um trabalho em aberto";
      return { id: t.id, souCliente, fase, titulo, descricao: t.descricao };
    });
  return { lista };
}
function resumoVivos(l) {
  const c = l.filter((x) => x.souCliente).length;
  const tr = l.length - c;
  return [c ? `${c} contratação${c > 1 ? "ões" : ""}` : "", tr ? `${tr} trabalho${tr > 1 ? "s" : ""} seu${tr > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
}
async function atualizarVivos() {
  if (!S.escrow || !S.endereco || !S.carteira) return;
  await S.escrow.sincronizar();
  const { meus } = await S.escrow.listar(S.endereco);
  S.trabalhosVivos = trabalhosVivos(meus);
}
setInterval(() => {
  if (S.carteira && !document.hidden) corridaViva().then(async (v) => { if (!v) await atualizarVivos().catch(() => {}); desenharFaixaViva(v); }).catch(() => {});
}, 30_000);

// ---------- Avisos de verdade (com o app em segundo plano) e plantão ----------
// "Plantão" = há algo que precisa de aviso: corrida em andamento, motorista online, loja/caixa recebendo
// pedidos. No APK, a Caixa Forte liga um aviso fixo que mantém o app vivo; no navegador, a aba aberta basta.
// A vigia de fundo só usa dados PÚBLICOS (blockchain + avisador): funciona até com a carteira bloqueada.
const dentroDaCaixaForte = () => window.parent !== window;
const lojaOnline = () => { try { return localStorage.getItem("xbrl.loja.online") === "1"; } catch { return false; } };
const emPlantao = () => !!(S.motorista?.online || lerViva() || lojaOnline());

function textoPlantao() {
  const v = lerViva();
  if (v) return `🚗 ${v.texto}`;
  if (S.motorista?.online) return "🟢 Online como motorista: avisando pedidos de corrida";
  return "🛍️ Recebendo pedidos da sua loja / Pix";
}

function notificar(titulo, corpo = "", tag = "brls") {
  if (!document.hidden) return; // com o app na tela, o toast + som bastam
  if (dentroDaCaixaForte()) return window.parent.postMessage({ brls: 1, tipo: "notificar", titulo, corpo }, "*");
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const op = { body: corpo, tag, icon: "./icons/icon-192.png", badge: "./icons/icon-192.png", renotify: true };
    if (navigator.serviceWorker?.controller) navigator.serviceWorker.ready.then((r) => r.showNotification(titulo, op)).catch(() => {});
    else new Notification(titulo, op);
  } catch { /* sem avisos neste aparelho */ }
}

async function pedirAvisos() {
  try {
    if (dentroDaCaixaForte()) return true; // a Caixa Forte pede a permissão dela
    if (!("Notification" in window)) return false;
    if (Notification.permission === "default") await Notification.requestPermission();
    return Notification.permission === "granted";
  } catch { return false; }
}

function atualizarPlantao() {
  const liga = emPlantao();
  const texto = liga ? textoPlantao() : "";
  if (S.plantaoEnviado === `${liga}|${texto}`) return;
  S.plantaoEnviado = `${liga}|${texto}`;
  if (dentroDaCaixaForte()) window.parent.postMessage({ brls: 1, tipo: "plantao", liga, texto }, "*");
}

/** Vigia de fundo: com o app escondido e em plantão, confere o que mudou e notifica. */
async function vigiaFundo() {
  atualizarPlantao();
  if (!document.hidden || !emPlantao() || !S.escrow) return;
  const eu = String(S.endereco || K.enderecoSalvo() || "").toLowerCase();
  if (!eu) return;
  await S.escrow.sincronizar();
  const V = (S.fundo ||= { pronto: false, ids: new Set(), passos: new Map(), textos: new Set() });
  const avisos = [];
  const novo = (chave) => { if (V.ids.has(chave)) return false; V.ids.add(chave); return V.pronto; };
  const agoraS = agora();
  for (const t of S.escrow.resumoTrabalhos().values()) {
    if (t.encerrado) continue;
    const cor = lerCorrida(t.descricao);
    if (S.motorista?.online && cor && t.trabalhador === E.ZeroAddress && !t.candidato && Number(t.prazo) > agoraS && novo(`v${t.id}`)) {
      avisos.push([`🚗 Corrida: ${cor.de} → ${cor.para}`, `R$ ${fmt(t.valor)} · ${cor.nomeCategorias}${cor.km != null ? ` · ${brNum(cor.km, 1)} km` : ""}`]);
    }
    if (t.trabalhador?.toLowerCase() === eu && t.cliente.toLowerCase() !== eu && novo(`d${t.id}`)) {
      avisos.push([cor ? "🚗 Corrida para você" : "🛍️ Novo pedido para você", String(t.descricao).split("\n")[0].slice(0, 120)]);
    }
  }
  const v = lerViva();
  if (v) {
    const t = await S.escrow.detalhe(v.id).catch(() => null);
    if (t) {
      const texto = passoCorrida(t, t.cliente.toLowerCase() === eu).texto;
      if (V.passos.has(v.id) && V.passos.get(v.id) !== texto) avisos.push(["🚗 Sua corrida", texto]);
      V.passos.set(v.id, texto);
      if (t.estado >= 4) corridaViva().catch(() => {});
      const textos = await CO.ler(S.chainId, S.imp.EscrowTrabalho, t.id).catch(() => []);
      const extras = await CO.lerTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), "1h", "brls").catch(() => []);
      for (const x of [...textos, ...extras]) {
        if (x.startsWith(PREFIXO_LOC) || !novo(`x${E.id(x)}`)) continue;
        if (x.startsWith(PREFIXO_CANCEL_NAO)) avisos.push(["🚗 Corrida", "O motorista recusou o cancelamento"]);
        else if (x.startsWith(PREFIXO_CANCEL)) avisos.push(["🚗 Corrida", "O passageiro pediu para cancelar"]);
        else if (x.startsWith(PREFIXO_CONTRA)) avisos.push(["💬 Contraproposta", "Um motorista propôs outro preço"]);
        else if (x.startsWith(SG.PREFIXO)) avisos.push(["📨 Pedido esperando você", "A outra parte está sem POL e pediu para você enviar"]);
      }
    }
  }
  if (lojaOnline()) {
    const pix = await CO.lerTopico(CO.topicoDe(S.chainId, eu, "pix"), "1h", PREFIXO_P2P).catch(() => []);
    for (const x of pix) if (novo(`p${E.id(x)}`)) avisos.push(["💱 Pedido de compra de BRLS", "Alguém quer comprar BRLS com Pix"]);
  }
  V.pronto = true;
  for (const [a, b] of avisos.slice(0, 4)) notificar(a, b, a);
  if (avisos.length) try { navigator.vibrate?.([200, 100, 200]); } catch { /* ok */ }
}
setInterval(() => vigiaFundo().catch(() => {}), 20_000);
document.addEventListener("visibilitychange", () => { if (document.hidden) vigiaFundo().catch(() => {}); });

/** Mantém a tela do celular acesa durante a corrida e enquanto o motorista está online. */
async function telaAcesa(liga) {
  // No APK (Tor) a janela não tem Wake Lock: pede à Caixa Forte para manter a tela acesa
  if (REDE_PELA_PONTE && S.acesaNativa !== liga) { S.acesaNativa = liga; window.parent.postMessage({ brls: 1, tipo: "tela-acesa", liga }, "*"); }
  try {
    if (liga) {
      S.querAcesa = true;
      if (!S.wake && navigator.wakeLock && !document.hidden) {
        S.wake = await navigator.wakeLock.request("screen");
        S.wake.addEventListener("release", () => (S.wake = null));
      }
    } else {
      S.querAcesa = false;
      await S.wake?.release();
      S.wake = null;
    }
  } catch { /* aparelho sem suporte: segue normal */ }
}

// ---------- Saldo disponível + botão Máximo (já descontando as taxas) ----------
/** Valor para o campo, sem arredondar para cima (nunca passa do que dá para enviar). */
function paraCampo(v, dec = 18, casas = 6) {
  const [i, f = ""] = E.formatUnits(v < 0n ? 0n : v, dec).split(".");
  const fr = f.slice(0, Math.min(casas, dec)).replace(/0+$/, "");
  return fr ? `${i},${fr}` : i;
}
/** Custo estimado do gás (com folga de 50%) para uma operação de `gas` unidades. */
async function custoGas(gas) {
  const f = await S.provider.getFeeData();
  const preco = f.maxFeePerGas || f.gasPrice || E.parseUnits("100", "gwei");
  return (preco * BigInt(gas) * 3n) / 2n;
}
/**
 * Mostra embaixo do campo "Disponível: …" e um botão Máximo.
 * calcular() → { max (bigint), decimais, simbolo, texto?, nota? } — `max` já sem as taxas.
 */
function ligarMaximo(sel, calcular) {
  const campo = $(sel);
  if (!campo || campo.dataset.maximo) return;
  campo.dataset.maximo = "1";
  const linha = document.createElement("p");
  linha.className = "disponivel";
  linha.innerHTML = `<span class="mudo">Disponível: …</span><button type="button" class="btn sec mini">Máximo</button>`;
  campo.insertAdjacentElement("afterend", linha);
  const span = linha.querySelector("span");
  const botao = linha.querySelector("button");
  const atualizar = async () => {
    try {
      const r = await calcular();
      span.innerHTML = r.texto || `Disponível: <b>${fmt(r.max, r.decimais, 4)} ${esc(r.simbolo)}</b>`;
      botao.disabled = !(r.max > 0n);
    } catch { span.textContent = ""; }
  };
  botao.addEventListener("click", async () => {
    try {
      const r = await calcular();
      if (!(r.max > 0n)) return toast(r.semSaldo || "Sem saldo para enviar");
      campo.value = paraCampo(r.max, r.decimais);
      campo.dispatchEvent(new Event("input", { bubbles: true }));
      if (r.nota) toast(r.nota);
    } catch (e) { mostrarErro(e); }
  });
  atualizar();
  return atualizar;
}
const saldoBrls = async () => ({ max: await c("xBRL").balanceOf(S.endereco), decimais: 18, simbolo: "BRLS" });

// ----------------------------------------------------------------------------
// Componentes: PIN e deslizar
// ----------------------------------------------------------------------------
function tecladoPin(titulo, subtitulo, aoCompletar) {
  let pin = "";
  tela(`
    <h1>${esc(titulo)}</h1><p class="mudo">${esc(subtitulo)}</p>
    <div class="pin-pontos" id="pontos">${"<i></i>".repeat(SEGURANCA.pinDigitos)}</div>
    <div id="pin-msg" role="alert"></div>
    <div class="teclado">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-d="${n}" aria-label="${n}">${n}</button>`).join("")}
      <button data-d="apagar" aria-label="Apagar">⌫</button><button data-d="0" aria-label="0">0</button><button data-d="limpar" aria-label="Limpar">✕</button>
    </div>`);
  const pontos = () => $$("#pontos i").forEach((el, i) => el.classList.toggle("cheio", i < pin.length));
  const digitar = async (d) => {
    if (d === "apagar") pin = pin.slice(0, -1);
    else if (d === "limpar") pin = "";
    else if (pin.length < SEGURANCA.pinDigitos) pin += d;
    pontos();
    if (pin.length === SEGURANCA.pinDigitos) {
      const p = pin;
      pin = "";
      try {
        await aoCompletar(p);
      } catch (e) {
        pontos();
        $("#pontos")?.classList.remove("tremer");
        void $("#pontos")?.offsetWidth;
        $("#pontos")?.classList.add("tremer");
        const m = $("#pin-msg");
        if (m) m.innerHTML = `<div class="erro">${esc(traduzirErro(e))}</div>`;
      }
    }
  };
  $$(".teclado button").forEach((b) => b.addEventListener("click", () => digitar(b.dataset.d)));
  const tecla = (ev) => {
    if (!$(".teclado")) return removeEventListener("keydown", tecla);
    if (/^\d$/.test(ev.key)) digitar(ev.key);
    else if (ev.key === "Backspace") digitar("apagar");
  };
  addEventListener("keydown", tecla);
}

// ----------------------------------------------------------------------------
// Telas
// ----------------------------------------------------------------------------
const TELAS = {};

TELAS.BOAS_VINDAS = () => tela(`
  <div class="abertura">
    ${roseta({ tam: 168, tracos: 6, classe: "desenhar", rotulo: "Roseta do BRLS" })}
    <h1 class="titulo-grande">O real que é só seu</h1>
    <p>Cada BRLS vale R$ 1. Você guarda, paga, contrata e recebe por trabalho, sem banco no meio e sem ninguém poder congelar.</p>
  </div>
  <button class="btn prim" data-acao="criar">Criar minha carteira</button>
  <button class="btn sec" data-acao="restaurar">Já tenho minhas palavras (12 ou 24)</button>
  <button class="btn sec" data-ir="VAGAS_PUBLICAS">👀 Ver vagas de trabalho abertas</button>
  ${temInjetada() ? `<button class="btn sec" data-acao="conectar-injetada">🔌 Usar a carteira deste navegador (MetaMask, Rabby)</button>` : ""}
  <div class="aviso">Sem cadastro, sem servidor. Se você perder as suas palavras, ninguém (nem nós) consegue recuperar seu dinheiro.</div>`);

TELAS.VAGAS_PUBLICAS = async () => {
  if (!S.escrow) return tela(`<h1>Vagas abertas</h1><div class="aviso">Ainda não há trabalhos nesta rede.</div><button class="btn sec" data-ir="BOAS_VINDAS">Voltar</button>`);
  tela(`<h1>👀 Vagas abertas</h1><div class="cartao"><div class="giro"></div><p class="mudo" id="sinc-txt">Lendo a blockchain…</p></div>`);
  await S.escrow.sincronizar(({ bloco, atual }) => {
    const t = $("#sinc-txt");
    if (t) t.textContent = `Lendo a blockchain… bloco ${bloco.toLocaleString("pt-BR")} de ${atual.toLocaleString("pt-BR")}`;
  });
  const { vagas } = await S.escrow.listar(E.ZeroAddress);
  tela(`
    <h1>👀 Vagas abertas</h1>
    <p class="mudo">Trabalhos com o pagamento já travado no contrato: quem fizer, recebe. Para aceitar uma vaga, crie sua carteira (é grátis e leva 1 minuto).</p>
    ${vagas.map((t) => {
      const m = ESCROW.modalidades[t.modalidade];
      const [ic, ds] = iconeDesc(t.descricao, m);
      return `<div class="item"><span class="ic">${ic}</span><span class="meio"><b>${esc(ds)}</b><span class="mudo">${esc(m.nome)} · prazo ${esc(new Date(t.prazo * 1000).toLocaleDateString("pt-BR"))}</span></span><b>${reais(t.valor)}</b></div>`;
    }).join("") || `<div class="cartao"><p class="mudo">Nenhuma vaga aberta agora. Volte mais tarde!</p></div>`}
    <button class="btn prim" data-acao="criar">Quero trabalhar: criar minha carteira</button>
    <button class="btn sec" data-ir="BOAS_VINDAS">Voltar</button>`);
};

TELAS.CRIAR_FRASE = () => {
  S.opcoesFrase ||= { n: 12, idioma: "en" };
  S.frasePendente ||= K.gerarFrase(S.opcoesFrase.n, S.opcoesFrase.idioma);
  const p = S.frasePendente.split(" ");
  const o = S.opcoesFrase;
  const opcao = (acao, ativo, rotulo, dica) => `<button class="btn ${ativo ? "prim" : "sec"} opcao-frase" data-acao="${acao}" aria-pressed="${ativo}">${rotulo}<small>${dica}</small></button>`;
  tela(`
    <h1>Suas ${p.length} palavras</h1>
    <p class="mudo">Elas SÃO a sua carteira. Anote no papel, na ordem, e guarde longe de fotos e nuvem.</p>
    <div class="opcoes-frase" role="group" aria-label="Quantidade de palavras">
      ${opcao("frase-12", o.n === 12, "12 palavras", "o mais comum")}
      ${opcao("frase-24", o.n === 24, "24 palavras", "ainda mais forte")}
    </div>
    <div class="opcoes-frase" role="group" aria-label="Língua das palavras">
      ${opcao("frase-en", o.idioma === "en", "Em inglês", "funciona na MetaMask e na Rabby")}
      ${opcao("frase-pt", o.idioma === "pt", "Em português", "mais fácil de anotar; funciona na Caixa Forte")}
    </div>
    <ol class="palavras borrado" id="palavras">${p.map((w) => `<li>${esc(w)}</li>`).join("")}</ol>
    <button class="btn sec" data-acao="revelar">👁️ Mostrar palavras</button>
    <div class="aviso">Nunca digite essas palavras em sites ou mensagens. Ninguém do BRLS vai pedir.</div>
    ${botaoSegurar("confirmar que anotei", "anotei")}
    <button class="btn sec" data-acao="voltar-boas-vindas">Voltar</button>`);
};

TELAS.CONFIRMAR_FRASE = () => {
  const pos = [];
  while (pos.length < 3) {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % S.frasePendente.split(" ").length;
    if (!pos.includes(r)) pos.push(r);
  }
  pos.sort((a, b) => a - b);
  S.params.posicoes = pos;
  tela(`
    <h1>Confira sua anotação</h1><p class="mudo">Digite as palavras pedidas, exatamente como anotou.</p>
    ${pos.map((i) => `<label for="w${i}">Palavra nº ${i + 1}</label><input id="w${i}" autocomplete="off" autocapitalize="none" spellcheck="false">`).join("")}
    <div id="msg" role="alert"></div>
    <button class="btn prim" data-acao="conferir">Conferir</button>
    <button class="btn sec" data-acao="rever-frase">Ver as palavras de novo</button>`);
};

// Restaurar: um quadrinho numerado por palavra (12, 15, 18, 21 ou 24). Colar a frase inteira espalha sozinho.
TELAS.RESTAURAR = () => {
  S.restN ||= 12;
  S.restPalavras ||= [];
  const n = S.restN;
  tela(`
  <h1>Restaurar carteira</h1>
  <p class="mudo">Digite cada palavra no seu quadrinho, na ordem. Em português ou em inglês: o app reconhece sozinho. Colou a frase inteira num quadrinho? Ela se espalha sozinha.</p>
  <p class="rotulo-ponto">Quantas palavras tem a sua frase?</p>
  <div class="seg quantas" role="group" aria-label="Quantas palavras">${K.QUANTIDADES.map((q) => `<button data-acao="rest-n-${q}" aria-pressed="${q === n}">${q}</button>`).join("")}</div>
  <div class="palavras-grade" id="grade">${Array.from({ length: n }, (_, i) => `<label class="palavra"><span>${i + 1}</span><input id="pw-${i}" data-i="${i}" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="${i === n - 1 ? "done" : "next"}" aria-label="Palavra ${i + 1}" value="${esc(S.restPalavras[i] || "")}"></label>`).join("")}</div>
  <div id="sug" class="sugestoes" aria-live="polite"></div>
  <div id="msg" role="alert"></div>
  <button class="btn prim" data-acao="restaurar-ok">Continuar</button>
  <button class="btn sec" data-acao="rest-limpar">Limpar tudo</button>
  <button class="btn sec" data-acao="voltar-boas-vindas">Voltar</button>`);
  const campos = $$("#grade input");
  const marcar = (c) => { const v = c.value.trim(); c.parentElement.classList.toggle("ok", !!v && K.palavraExiste(v)); c.parentElement.classList.toggle("erro", !!v && !K.palavraExiste(v)); };
  const guardar = () => { S.restPalavras = campos.map((c) => c.value.trim()); };
  const sugerir = (c) => {
    const box = $("#sug");
    const l = K.sugestoes(c.value);
    box.innerHTML = l.length && !K.palavraExiste(c.value) ? l.map((w) => `<button type="button" data-sug="${esc(w)}" data-i="${c.dataset.i}">${esc(w)}</button>`).join("") : "";
  };
  const proximo = (i) => { const c = campos[i + 1]; if (c) c.focus(); else $("#sug").innerHTML = ""; };
  campos.forEach((c, i) => {
    c.addEventListener("input", () => {
      const partes = K.normalizarFrase(c.value).split(" ").filter(Boolean);
      if (partes.length > 1) {
        // Frase colada (ou palavras com espaço): espalha a partir daqui; se for uma frase inteira de outro tamanho, troca o tamanho
        if (i === 0 && partes.length !== n && K.QUANTIDADES.includes(partes.length)) { S.restN = partes.length; S.restPalavras = partes; return render(); }
        partes.forEach((w, k) => { if (campos[i + k]) { campos[i + k].value = w; marcar(campos[i + k]); } });
        guardar();
        return proximo(Math.min(n - 2, i + partes.length - 1));
      }
      if (/\s$/.test(c.value) && c.value.trim()) { c.value = c.value.trim(); marcar(c); guardar(); return proximo(i); }
      guardar();
      sugerir(c);
    });
    c.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); marcar(c); if (i === n - 1) $('[data-acao="restaurar-ok"]').click(); else proximo(i); }
      if (ev.key === "Backspace" && !c.value && i > 0) { ev.preventDefault(); campos[i - 1].focus(); }
    });
    c.addEventListener("focus", () => sugerir(c));
    c.addEventListener("blur", () => marcar(c));
    if (c.value) marcar(c);
  });
  $("#sug").addEventListener("pointerdown", (ev) => {
    const b = ev.target.closest("[data-sug]");
    if (!b) return;
    ev.preventDefault();
    const c = campos[Number(b.dataset.i)];
    c.value = b.dataset.sug;
    marcar(c);
    guardar();
    proximo(Number(b.dataset.i));
  });
  (campos.find((c) => !c.value) || campos[0]).focus();
};

TELAS.DEFINIR_PIN = () =>
  tecladoPin("Crie um PIN", `${SEGURANCA.pinDigitos} dígitos para abrir a carteira neste aparelho. Evite datas e sequências.`, async (pin) => {
    if (!K.pinValido(pin)) throw new Error("PIN fraco. Evite repetições e sequências.");
    S.pinPendente = pin;
    ir("CONFIRMAR_PIN");
  });

TELAS.CONFIRMAR_PIN = () =>
  tecladoPin("Repita o PIN", "Para ter certeza.", async (pin) => {
    if (pin !== S.pinPendente) {
      S.pinPendente = null;
      toast("Os PINs não conferem. Crie de novo.");
      return ir("DEFINIR_PIN");
    }
    modal(`<div class="giro"></div><h2>Protegendo sua carteira</h2><p class="mudo">Cifrando com AES-256 no seu aparelho…</p>`);
    const frase = S.frasePendente;
    await K.criarCofre(frase, pin);
    abrirSessao(frase);
    S.frasePendente = null;
    S.pinPendente = null;
    fecharModal();
    ir("INICIO");
    toast("Carteira pronta! 🎉");
    if (await K.biometriaDisponivel()) {
      S.pinRecente = pin;
      modal(`<h2>👆 Proteja com biometria</h2><p>Um PIN de 6 dígitos pode ser adivinhado por quem copiar a memória do celular. A biometria guarda a chave no chip de segurança do aparelho.</p>
        <button class="btn prim" data-acao="bio-agora">Ativar biometria agora</button><button class="btn sec" data-acao="bio-depois">Depois</button>`);
    }
  });

TELAS.BLOQUEADA = async () => {
  const bio = K.temBiometria();
  // Com corrida em andamento, a tela bloqueada continua mostrando em que passo ela está (dado público)
  const atualizarBloqueada = async () => {
    const v = lerViva();
    if (!v || !S.escrow) return;
    const t = await S.escrow.detalhe(v.id).catch(() => null);
    if (!t) return;
    if (t.estado >= 4) { try { localStorage.removeItem(CHAVE_VIVA); } catch { /* ok */ } }
    const el = $("#bl-viva");
    if (el) el.textContent = passoCorrida(t, t.cliente.toLowerCase() === String(K.enderecoSalvo()).toLowerCase()).texto;
  };
  setTimeout(() => { atualizarBloqueada().catch(() => {}); vigiar("BLOQUEADA", atualizarBloqueada, 15000); }, 0);
  tela(`
    <div class="abertura">
      ${roseta({ tam: 120, tracos: 5 })}
      <h1>Carteira bloqueada</h1>
      <p class="serie">Nº ${esc(curto(K.enderecoSalvo()))}</p>
    </div>
    ${lerViva() ? `<div class="ok viva-bloqueada">🚗 <b>Você tem uma corrida em andamento.</b><br><span id="bl-viva">${esc(lerViva().texto)}</span><br><small>Desbloqueie para ver o mapa e o código.</small></div>` : ""}
    <div class="deslizar"><input type="range" id="deslize" min="0" max="100" value="0" aria-label="Deslize para desbloquear"><span>Deslize para desbloquear ➜</span></div>
    ${bio ? `<button class="btn sec" data-acao="biometria">👆 Usar biometria</button>` : ""}
    <button class="btn sec" data-acao="esqueci" style="margin-top:30px">Esqueci o PIN (restaurar com as palavras)</button>`);
  const r = $("#deslize");
  const soltar = () => {
    if (Number(r.value) >= 96) pedirPin();
    else r.value = 0;
  };
  r.addEventListener("change", soltar);
  r.addEventListener("pointerup", soltar);
  r.addEventListener("touchend", soltar);
};

function pedirPin() {
  const espera = K.esperaRestante();
  tecladoPin("Digite seu PIN", espera ? `Aguarde ${espera}s após tentativas erradas.` : "Para abrir a carteira.", async (pin) => {
    const frase = await K.abrirComPin(pin);
    abrirSessao(frase);
    ir("INICIO");
    aoEntrar();
  });
}

/** Guia de primeiros passos: some sozinho quando a pessoa já fez tudo (ou toca em "Já sei usar"). */
function primeirosPassos(pol, saldoX) {
  let escondido = false;
  try { escondido = localStorage.getItem("xbrl.guia.ok") === "1"; } catch { /* */ }
  const passos = [
    { feito: true, titulo: "Guardar as suas palavras", texto: "São a chave do seu dinheiro. Papel, fora do celular." },
    { feito: pol > 0n, titulo: "Ter um pouco de POL", texto: "É a moeda que paga a taxa da rede (centavos). Quem te contratar pode mandar junto com o trabalho.", ir: "RECEBER", botao: "Ver meu endereço" },
    { feito: saldoX > 0n, titulo: "Ter BRLS", texto: "Receba por um trabalho, peça para alguém te enviar, ou troque BRZ por BRLS na Reserva.", ir: "RESERVA", botao: "Ir para a Reserva" },
    { feito: false, titulo: "Fazer o primeiro trabalho", texto: "Veja as vagas abertas ou contrate alguém. O pagamento fica travado até o fim, seguro para os dois.", ir: "TRABALHOS", botao: "Ver trabalhos" },
  ];
  if (escondido || passos.every((p) => p.feito)) return "";
  const proximo = passos.find((p) => !p.feito);
  return `<section class="cartao guia" aria-label="Primeiros passos">
    <h2>Primeiros passos</h2>
    <ol class="passos">${passos.map((p) => `<li class="${p.feito ? "feito" : p === proximo ? "agora" : ""}"><b>${esc(p.titulo)}</b>${p === proximo ? `<p>${esc(p.texto)}</p><button class="btn prim" data-ir="${p.ir}">${esc(p.botao)}</button>` : ""}</li>`).join("")}</ol>
    <button class="btn sec" data-acao="guia-ok">Já sei usar, esconder</button>
  </section>`;
}

/** Trava de segurança do gás: abaixo de 1,5 POL, troca um pouco de BRLS (ou lastro/USDC) por POL sozinho. */
async function tanqueAutomatico() {
  if (S.externa || !S.carteira || !G.autoAtivo() || !S.rede?.uniswap || S.abastecendo) return null;
  if (S.ultimoAbastecimento && Date.now() - S.ultimoAbastecimento < 10 * 60_000) return null;
  S.abastecendo = true;
  try {
    const preferidos = S.tokensInfo.filter((t) => t.principal || t.lastro || t.simbolo === "USDC").map((t) => ({ endereco: t.endereco, simbolo: t.simbolo, decimais: t.decimais, moeda: t.moeda || "BRL" }));
    const auto = await G.abastecerSeNecessario(S.provider, S.carteira, S.chainId, preferidos, await opcoesGas(), [S.imp?.xBRL]);
    S.ultimoAbastecimento = Date.now(); // tentou: não tenta de novo em 10 min (sucesso ou sem rota)
    if (auto) toast(`⛽ Gás baixo: o tanque encheu sozinho com ${auto.simbolo}`);
    return auto;
  } catch { S.ultimoAbastecimento = Date.now(); return null; } finally { S.abastecendo = false; }
}

TELAS.INICIO = async () => {
  tela(`<div class="cartao"><div class="giro"></div></div>`);
  if (await tanqueAutomatico().catch(() => null)) return render();
  const [pol, saldos] = await Promise.all([
    S.provider.getBalance(S.endereco),
    Promise.all(S.tokensInfo.map((t) => erc20(t.endereco).balanceOf(S.endereco).catch(() => 0n))),
  ]);
  const tanque = await G.estadoTanque(S.provider, S.endereco);
  const xi = S.tokensInfo.findIndex((t) => t.principal);
  const saldoX = xi >= 0 ? saldos[xi] : 0n;
  tela(`
    ${S.imp ? "" : `<div class="aviso">O protocolo BRLS ainda não foi implantado na rede ${esc(S.rede.nome)}. Você já pode guardar e enviar POL e stablecoins.</div>`}
    ${S.imp?.beta ? `<div class="aviso">🧪 <b>Versão beta na rede real.</b> Limites baixos de propósito (reserva até R$ 1.000, cofre até R$ 500 por cripto). Contratos ainda não auditados: use só valores pequenos.</div>` : ""}
    <section class="cedula" aria-label="Seu saldo">
      ${roseta({ tam: 230, tracos: 6, classe: "fundo desenhar", centro: "" })}
      <p class="cedula-topo"><span>Real Soberano</span><span class="serie">Nº ${esc(curto(S.endereco))}</span></p>
      <p class="saldo"><span class="cifra">R$</span>${fmt(saldoX)}</p>
      <p class="cedula-pe">Saldo em BRLS · 1 BRLS = R$ 1 · ninguém congela</p>
    </section>
    ${primeirosPassos(pol, saldoX)}
    <div class="grade">
      <button class="atalho" data-ir="ENVIAR"><span>📤</span>Enviar</button>
      <button class="atalho" data-ir="RECEBER"><span>📥</span>Receber</button>
      <button class="atalho" data-ir="RESERVA"><span>🪙</span>Comprar</button>
      <button class="atalho" data-acao="modo-resgatar"><span>💵</span>Resgatar</button>
      <button class="atalho" data-ir="VITRINE"><span>🛍️</span>Vitrine</button>
      <button class="atalho" data-ir="CORRIDA"><span>🚗</span>Corrida</button>
      <button class="atalho" data-ir="TRABALHOS"><span>🤝</span>Trabalhos</button>
      <button class="atalho" data-ir="TANQUE"><span>⛽</span>Tanque</button>
      <button class="atalho" data-ir="EXTRATO"><span>🧾</span>Extrato</button>
      <button class="atalho" data-ir="COFRE"><span>🏦</span>Cofre cripto</button>
    </div>
    <div class="cartao">
      <div class="linha"><b>⛽ Tanque de gás</b><span>${fmt(pol, 18, 3)} ${esc(S.rede.nativo.simbolo)} / ${TANQUE.alvoPol}</span></div>
      <div class="tanque" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${tanque.nivelPct}" style="--n:${tanque.nivelPct}%"><i></i></div>
      ${tanque.precisaAbastecer ? `<p class="mudo">Tanque baixo. ${G.autoAtivo() ? "A trava automática tenta encher sozinha (troca um pouco do seu saldo por POL). Se não der, toque em Tanque." : "O abastecimento automático está desligado: toque em Tanque para abastecer."}</p>` : ""}
    </div>
    <div class="cartao"><h2 style="margin-top:0">Outros saldos</h2>
      ${S.tokensInfo.map((t, i) => (t.principal ? "" : `<div class="linha"><span>${esc(t.simbolo)}</span><b>${fmt(saldos[i], t.decimais)}</b></div>`)).join("") || `<p class="mudo">Nenhum.</p>`}
    </div>
    <button class="btn sec" data-acao="atualizar">↻ Atualizar</button>`);
};

TELAS.RECEBER = () => tela(`
  <h1>Receber</h1>
  <p class="mudo">Envie para este endereço somente pela rede <b>${esc(S.rede.nome)}</b>: BRLS, POL, BRZ, BRLA, USDC.</p>
  ${qrSvg(S.endereco)}
  <p class="mudo" style="text-align:center">Mostre este QR para quem vai te pagar.</p>
  <div class="endereco" id="meu-end">${esc(S.endereco)}</div>
  <div class="grade duas" style="margin-top:12px">
    <button class="btn prim" data-acao="copiar-end">Copiar</button>
    <button class="btn sec" data-acao="compartilhar-end">Compartilhar</button>
  </div>
  <div class="aviso">Confira sempre os 4 primeiros e os 4 últimos caracteres: <b>${esc(S.endereco.slice(0, 6))}…${esc(S.endereco.slice(-4))}</b></div>`);

TELAS.ENVIAR = () => {
  const opts = [`<option value="nativo">${esc(S.rede.nativo.simbolo)} (gás)</option>`, ...S.tokensInfo.map((t, i) => `<option value="${i}" ${t.principal ? "selected" : ""}>${esc(t.simbolo)}</option>`)];
  tela(`
    <h1>Enviar</h1>
    <label for="env-token">Moeda</label><select id="env-token">${opts.join("")}</select>
    <label for="env-para">Para (endereço 0x…)</label><input id="env-para" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="0x…"><button class="btn sec" data-acao="scan-endereco">📷 Ler QR do endereço</button>
    <label for="env-valor">Valor</label><input id="env-valor" class="grande" inputmode="decimal" placeholder="0,00">
    <div id="env-prev" class="mudo"></div>
    ${botaoSegurar("enviar", "enviar")}`);
  const atualizar = async () => {
    const out = $("#env-prev");
    try {
      const sel = $("#env-token").value;
      const t = sel === "nativo" ? null : S.tokensInfo[Number(sel)];
      const v = lerValor($("#env-valor").value, t ? t.decimais : 18);
      if (t) {
        out.innerHTML = `Chega ao destino: <b>${fmt(v, t.decimais)} ${esc(t.simbolo)}</b> · sem taxa do protocolo (só o gás da rede)`;
      } else out.textContent = "";
    } catch {
      out.textContent = "";
    }
  };
  const maximo = ligarMaximo("#env-valor", async () => {
    const sel = $("#env-token").value;
    const pol = await S.provider.getBalance(S.endereco);
    if (sel === "nativo") {
      const max = pol - (await custoGas(21_000));
      return { max, decimais: 18, simbolo: S.rede.nativo.simbolo, nota: "Já descontei a taxa da rede." };
    }
    const t = S.tokensInfo[Number(sel)];
    const bal = await new E.Contract(t.endereco, ABIS.xBRL, S.provider).balanceOf(S.endereco);
    const falta = pol < (await custoGas(80_000));
    return { max: bal, decimais: t.decimais, simbolo: t.simbolo, texto: `Disponível: <b>${fmt(bal, t.decimais, 4)} ${esc(t.simbolo)}</b>${falta ? ` · <span style="color:var(--pequi)">falta POL para a taxa da rede</span>` : ""}`, nota: falta ? "Atenção: falta POL para a taxa da rede (veja o Tanque)." : "" };
  });
  $("#env-valor").addEventListener("input", atualizar);
  $("#env-token").addEventListener("change", () => { $("#env-valor").value = ""; atualizar(); maximo?.(); });
  $("#env-para").addEventListener("change", atualizar);
};

TELAS.RESERVA = async () => {
  if (!S.imp) return tela(`<h1>Reserva</h1><div class="aviso">Protocolo ainda não implantado nesta rede.</div>`);
  const r = c("ReservaBRL");
  const k = c("CofreCripto");
  const [fase, total, colat, supply, janela, colchao, dividaCofre, ruim, teto] = await Promise.all([r.fase(), r.lastroTotal(), r.colateralizacaoBps(), c("xBRL").totalSupply(), r.resgateDisponivelNaJanela(), k.colchao(), k.dividaTotalGlobal(), k.dividaRuim(), r.TETO_RESERVA()]);
  const saldoBeta = S.beta ? await new E.Contract(S.beta.xBRL, ABIS.xBRL, S.provider).balanceOf(S.endereco).catch(() => 0n) : 0n;
  S.params.saldoBeta = saldoBeta;
  const lastros = S.tokensInfo.filter((t) => t.lastro && S.imp.lastros.map((x) => x.toLowerCase()).includes(t.endereco.toLowerCase()));
  const modo = S.params.modo || "emitir";
  const colatTxt = colat > 10n ** 30n ? "—" : `${(Number(colat) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
  tela(`
    <h1>Reserva BRL</h1>
    ${saldoBeta > 0n ? `<div class="aviso">🧪 Você tem <b>${fmt(saldoBeta)}</b> da versão de testes (beta). Ela foi substituída pela versão oficial. Um toque troca tudo pelo BRLS novo (custa 0,2% e um pouco de POL).<button class="btn prim" data-acao="beta-resgatar">Trocar pela versão nova</button></div>` : ""}
    <div class="cartao">
      <div class="linha"><span>Fase</span><b>${Number(fase) === 1 ? "1 · resgate livre" : "2 · resgate até 20%/dia"}</b></div>
      <div class="linha"><span>BRLS em circulação</span><b>${fmt(supply)}</b></div>
      <div class="linha"><span>Lastro total</span><b>${reais(total)}</b></div>
      <div class="linha"><span>Colateralização</span><b>${colatTxt}</b></div>
      ${Number(fase) === 2 ? `<div class="linha"><span>Resgate livre nas 24 h</span><b>${fmt(janela)}</b></div>` : ""}
      <div class="linha"><span>BRLS emitido no cofre cripto</span><b>${fmt(dividaCofre)}</b></div>
      <div class="linha"><span>🛟 Colchão de proteção</span><b>${fmt(colchao)} BRLS</b></div>
      ${ruim > 0n ? `<div class="linha"><span>Prejuízo descoberto (público)</span><b>${fmt(ruim)}</b></div>` : ""}
      ${teto > 0n ? `<div class="linha"><span>Teto da beta</span><b>${reais(teto)}</b></div>` : ""}
      <p class="mudo">Metade de toda taxa vai ao colchão, que cobre prejuízo se uma cripto despencar rápido demais.</p>
    </div>
    <button class="btn sec" data-ir="COFRE">🏦 Emitir BRLS com garantia em cripto</button>
    <div class="seg" role="group" aria-label="Operação">
      <button data-acao="modo-emitir" aria-pressed="${modo === "emitir"}">Comprar BRLS</button>
      <button data-acao="modo-resgatar" aria-pressed="${modo === "resgatar"}">Resgatar em reais</button>
    </div>
    <label for="res-lastro">${modo === "emitir" ? "Pagar com" : "Receber em"}</label>
    <select id="res-lastro">${lastros.map((t, i) => `<option value="${i}">${esc(t.simbolo)}</option>`).join("")}</select>
    <label for="res-valor">${modo === "emitir" ? "Quantidade do lastro" : "Quantidade de BRLS"}</label>
    <input id="res-valor" class="grande" inputmode="decimal" placeholder="0,00">
    <div id="res-cot" class="mudo"></div>
    ${S.chainId !== 137 && lastros[0] ? `<button class="btn sec" data-acao="torneira">🚰 Pegar 10.000 ${esc(lastros[0].simbolo)} de teste</button>` : ""}
    ${botaoSegurar(modo === "emitir" ? "comprar BRLS" : "resgatar", "reserva")}
    <p class="mudo">Taxa fixa de 0,1%. Quem traz o lastro que já sobra (ou leva o que está faltando) paga até 0,40% a mais, e esse valor fica na reserva como lastro extra. Cada lastro tem um teto de emissão por dia, contra drenagem. Resgates nunca podem ser pausados.</p>`);
  S.params.lastros = lastros;
  const cotar = async () => {
    const out = $("#res-cot");
    try {
      const t = lastros[Number($("#res-lastro").value)];
      if (modo === "emitir") {
        const v = lerValor($("#res-valor").value, t.decimais);
        const [[liq, taxa, spread], hoje] = await Promise.all([r.cotarEmissao(t.endereco, v), r.emissaoDisponivelNaJanela(t.endereco)]);
        out.innerHTML = `Você recebe <b>${fmt(liq)} BRLS</b> · taxa ${fmt(taxa, 18, 4)}${spread ? ` · lastro extra ${fmt(spread, 18, 4)}` : ""}<br>Limite de hoje com ${esc(t.simbolo)}: ${fmt(hoje)}`;
      } else {
        const v = lerValor($("#res-valor").value, 18);
        const [pago, taxa, spread] = await r.cotarResgate(t.endereco, v);
        out.innerHTML = `Você recebe <b>${fmt(pago, t.decimais)} ${esc(t.simbolo)}</b> · taxa ${fmt(taxa, 18, 4)}${spread ? ` · spread ${fmt(spread, 18, 4)}` : ""}`;
      }
    } catch {
      out.textContent = "";
    }
  };
  const maximo = ligarMaximo("#res-valor", async () => {
    const t = lastros[Number($("#res-lastro").value)];
    if (modo === "emitir") {
      const [bal, hoje] = await Promise.all([new E.Contract(t.endereco, ABIS.xBRL, S.provider).balanceOf(S.endereco), r.emissaoDisponivelNaJanela(t.endereco)]);
      const hojeLastro = t.decimais === 18 ? hoje : hoje / 10n ** BigInt(18 - t.decimais);
      const max = bal < hojeLastro ? bal : hojeLastro;
      return { max, decimais: t.decimais, simbolo: t.simbolo, texto: `Disponível: <b>${fmt(bal, t.decimais, 4)} ${esc(t.simbolo)}</b>${hojeLastro < bal ? ` · limite de hoje ${fmt(hojeLastro, t.decimais, 2)}` : ""}`, nota: "A taxa sai do BRLS que você recebe." };
    }
    const bal = await c("xBRL").balanceOf(S.endereco);
    const max = Number(fase) === 2 && janela < bal ? janela : bal;
    return { max, decimais: 18, simbolo: "BRLS", nota: "A taxa sai do valor que você recebe." };
  });
  $("#res-valor").addEventListener("input", cotar);
  $("#res-lastro").addEventListener("change", () => { cotar(); maximo?.(); });
};

TELAS.TANQUE = async () => {
  const est = await G.estadoTanque(S.provider, S.endereco);
  const temSwap = !!S.rede.uniswap;
  const candidatos = S.tokensInfo.filter((t) => t.principal || t.lastro || t.simbolo === "USDC");
  tela(`
    <h1>⛽ Tanque de gás</h1>
    <p class="mudo">Toda operação na Polygon paga uma pequena taxa em POL. O tanque guarda até ${TANQUE.alvoPol} POL para você nunca travar.</p>
    <div class="cartao">
      <div class="linha"><span>Nível</span><b>${fmt(est.saldo, 18, 3)} / ${TANQUE.alvoPol} POL</b></div>
      <div class="tanque" style="--n:${est.nivelPct}%"><i></i></div>
    </div>
    ${temSwap ? `
    <label class="linha" style="font-size:16px;color:var(--txt)"><span>Abastecer automaticamente abaixo de ${TANQUE.gatilhoPol} POL</span>
      <input type="checkbox" id="auto" style="width:auto" ${G.autoAtivo() ? "checked" : ""}></label>
    <label for="tq-token">Trocar por POL usando</label>
    <select id="tq-token">${candidatos.map((t, i) => `<option value="${i}">${esc(t.simbolo)}</option>`).join("")}</select>
    <button class="btn sec" data-acao="tq-cotar">Cotar até encher (${fmt(est.faltam, 18, 3)} POL)</button>
    <div id="tq-cot"></div>` : `<div class="aviso">Na rede de teste não há troca automática. Pegue POL grátis na <a href="${esc(S.rede.faucetPol || "#")}" target="_blank" rel="noopener">torneira oficial</a>.</div>`}
    <h2>Histórico</h2>
    ${G.historico().map((h) => `<div class="linha"><span>${new Date(h.quando).toLocaleString("pt-BR")}</span><a href="${esc(linkExplorer(S.chainId, "tx", h.hash))}" target="_blank" rel="noopener">${fmt(BigInt(h.pol), 18, 3)} POL</a></div>`).join("") || `<p class="mudo">Nenhum abastecimento ainda.</p>`}`);
  S.params.candidatos = candidatos;
  S.params.faltam = est.faltam;
  $("#auto")?.addEventListener("change", (ev) => {
    G.definirAuto(ev.target.checked);
    toast(ev.target.checked ? "Abastecimento automático ligado (slippage máx. 1%)" : "Abastecimento automático desligado");
  });
};

// ---------- Extrato ----------
const TOPICO_TRANSFER = E.id("Transfer(address,address,uint256)");

/** Lê todas as transferências ERC-20 que entraram ou saíram da carteira (emissões e queimas incluídas). */
async function lerExtrato() {
  const eu = E.zeroPadValue(S.endereco, 32);
  const tokens = new Map();
  for (const t of S.tokensInfo) if (t.endereco) tokens.set(t.endereco.toLowerCase(), t);
  if (S.imp?.xBRL) tokens.set(S.imp.xBRL.toLowerCase(), tokens.get(S.imp.xBRL.toLowerCase()) || { simbolo: "BRLS", decimais: 18, endereco: S.imp.xBRL });
  const enderecos = [...tokens.values()].map((t) => t.endereco);
  const atual = await S.provider.getBlockNumber();
  const inicio = Number(S.imp?.blocoInicial) || Math.max(0, atual - 500_000);
  const logs = [];
  for (const topicos of [[TOPICO_TRANSFER, eu], [TOPICO_TRANSFER, null, eu]]) {
    let de = inicio;
    let passo = 50_000;
    while (de <= atual) {
      const ate = Math.min(atual, de + passo - 1);
      try {
        logs.push(...(await S.provider.getLogs({ address: enderecos, topics: topicos, fromBlock: de, toBlock: ate })));
        de = ate + 1;
      } catch (e) {
        if (passo <= 500) throw e;
        passo = Math.floor(passo / 4);
      }
    }
  }
  const vistos = new Set();
  const itens = [];
  for (const l of logs) {
    const chave = `${l.transactionHash}:${l.index}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const t = tokens.get(l.address.toLowerCase());
    if (!t || l.topics.length !== 3) continue;
    const de = E.getAddress("0x" + l.topics[1].slice(26));
    const para = E.getAddress("0x" + l.topics[2].slice(26));
    itens.push({ t, de, para, valor: BigInt(l.data), bloco: l.blockNumber, idx: l.index, tx: l.transactionHash });
  }
  itens.sort((a, b) => b.bloco - a.bloco || b.idx - a.idx);
  const recentes = itens.slice(0, 100);
  const blocos = [...new Set(recentes.map((i) => i.bloco))];
  const datas = new Map();
  await Promise.all(blocos.map(async (b) => { try { datas.set(b, (await S.provider.getBlock(b)).timestamp); } catch { /* sem data */ } }));
  for (const i of recentes) i.em = datas.get(i.bloco) || 0;
  return { itens: recentes, total: itens.length };
}

function rotuloMov(i) {
  const eu = S.endereco.toLowerCase();
  const Z = E.ZeroAddress.toLowerCase();
  const nomes = {};
  if (S.imp) {
    nomes[S.imp.ReservaBRL.toLowerCase()] = "Reserva";
    nomes[S.imp.CofreCripto.toLowerCase()] = "Cofre cripto";
    nomes[S.imp.EscrowTrabalho.toLowerCase()] = "Trabalhos (contrato)";
  }
  nomes[CREATOR_TREASURY.toLowerCase()] = "Criador da rede";
  const nome = (a) => nomes[a.toLowerCase()] || curto(a);
  if (i.de.toLowerCase() === Z) return { icone: "🪙", titulo: "Emissão", detalhe: "BRLS criado para você", sinal: 1 };
  if (i.para.toLowerCase() === Z) return { icone: "🔥", titulo: "Queima", detalhe: "BRLS destruído", sinal: -1 };
  const ehXbrl = S.imp && i.t.endereco.toLowerCase() === S.imp.xBRL.toLowerCase();
  if (ehXbrl && i.de.toLowerCase() === eu && i.para.toLowerCase() === S.imp.ReservaBRL.toLowerCase()) return { icone: "🔥", titulo: "Resgate", detalhe: "BRLS devolvido à Reserva e queimado", sinal: -1 };
  if (ehXbrl && i.de.toLowerCase() === eu && i.para.toLowerCase() === S.imp.CofreCripto.toLowerCase()) return { icone: "🔥", titulo: "Dívida paga", detalhe: "BRLS pago ao cofre e queimado", sinal: -1 };
  if (i.para.toLowerCase() === eu) return { icone: "⬇️", titulo: "Recebido", detalhe: `de ${nome(i.de)}`, sinal: 1 };
  return { icone: "⬆️", titulo: "Enviado", detalhe: `para ${nome(i.para)}`, sinal: -1 };
}

TELAS.EXTRATO = async () => {
  if (!S.imp) return tela(`<h1>🧾 Extrato</h1><div class="aviso">Protocolo ainda não implantado nesta rede.</div>`);
  tela(`<h1>🧾 Extrato</h1><div class="cartao"><div class="giro"></div><p class="mudo">Lendo a blockchain…</p></div>`);
  const { itens, total } = await lerExtrato();
  const filtro = S.params.filtro || "todos";
  const lista = itens.filter((i) => filtro === "todos" || (filtro === "xbrl" ? i.t.simbolo === "BRLS" : i.t.simbolo !== "BRLS"));
  tela(`
    <h1>🧾 Extrato</h1>
    <p class="mudo">Tudo que entrou e saiu da sua carteira em moedas (emissões e queimas de BRLS incluídas). Mostrando as ${itens.length} mais recentes de ${total}.</p>
    <div class="seg" role="group"><button data-acao="ext-todos" aria-pressed="${filtro === "todos"}">Tudo</button><button data-acao="ext-xbrl" aria-pressed="${filtro === "xbrl"}">BRLS</button><button data-acao="ext-outras" aria-pressed="${filtro === "outras"}">Outras moedas</button></div>
    <div class="cartao">
      ${lista.map((i) => {
        const r = rotuloMov(i);
        const link = linkExplorer(S.chainId, "tx", i.tx);
        return `<div class="linha"><span>${r.icone} <b>${esc(r.titulo)}</b> · ${esc(i.t.simbolo)}<br><small class="mudo">${esc(r.detalhe)}${i.em ? " · " + esc(new Date(i.em * 1000).toLocaleString("pt-BR")) : ""}${link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener">comprovante</a>` : ""}</small></span><b style="color:${r.sinal > 0 ? "var(--esm3, #6EE7B7)" : "#F87171"}">${r.sinal > 0 ? "+" : "−"}${fmt(i.valor, i.t.decimais, 4)}</b></div>`;
      }).join("") || `<p class="mudo">Nenhuma movimentação ainda.</p>`}
    </div>
    <p class="mudo">Envios e recebimentos de POL (a moeda da taxa) não aparecem aqui: a Polygon não oferece essa lista sem um serviço externo. O saldo de POL está no Tanque.</p>
    <button class="btn sec" data-acao="ext-atualizar">↻ Atualizar</button>`);
};

// ---------- Cofre cripto ----------
const pct = (bps) => `${(Number(bps) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
const INFINITO = 2n ** 255n;

/** Lê o cofre inteiro: ativos, preços e a posição do usuário. */
async function lerCofre() {
  const k = c("CofreCripto");
  const n = Number(await k.totalAtivos());
  const ativos = [];
  for (let i = 0; i < n; i++) {
    const [a, pos, [preco, ok], [precoEmissao, okEmissao], [razao], livre] = await Promise.all([k.ativo(i), k.posicao(i, S.endereco), k.precoBrl(i), k.precoParaEmitir(i), k.razaoGarantia(i, S.endereco), k.emissaoDisponivel(i)]);
    const info = S.tokensInfo.find((t) => t.endereco.toLowerCase() === a.token.toLowerCase());
    const valorGarantia = ok ? (pos.colateral * preco) / 10n ** BigInt(a.decimais) : 0n;
    // Quanto ainda dá para emitir mantendo a garantia mínima (taxa de 0,5% entra na dívida)
    let podeEmitir = 0n;
    if (okEmissao) {
      const maxDivida = ((pos.colateral * precoEmissao) / 10n ** BigInt(a.decimais) * 10_000n) / BigInt(a.crEmissaoBps);
      if (maxDivida > pos.divida) podeEmitir = ((maxDivida - pos.divida) * 10_000n) / (10_000n + BigInt(COFRE.taxaEmissaoBps));
      if (podeEmitir > livre) podeEmitir = livre;
    }
    // Preço em que a posição pode ser liquidada
    const precoLiquidacao = pos.colateral > 0n && pos.divida > 0n ? (pos.divida * BigInt(a.crLiquidacaoBps) * 10n ** BigInt(a.decimais)) / (10_000n * pos.colateral) : 0n;
    ativos.push({ i, a, pos, preco, ok, okEmissao, razao, livre, info, valorGarantia, podeEmitir, precoLiquidacao, simbolo: info?.simbolo || `Cripto ${i}`, decimais: Number(a.decimais) });
  }
  return ativos;
}

TELAS.COFRE = async () => {
  if (!S.imp) return tela(`<h1>Cofre cripto</h1><div class="aviso">Protocolo ainda não implantado nesta rede.</div>`);
  tela(`<h1>🏦 Cofre cripto</h1><div class="cartao"><div class="giro"></div></div>`);
  const ativos = await lerCofre();
  const sel = Math.min(Number(S.params.ativo ?? 0), ativos.length - 1);
  const x = ativos[sel];
  const modo = S.params.modo || "depositar";
  const saldoTok = await erc20(x.a.token).balanceOf(S.endereco).catch(() => 0n);
  const saldoX = await c("xBRL").balanceOf(S.endereco);
  S.params.cofre = { x, saldoTok, saldoX };
  const saude = x.pos.divida === 0n ? "sem dívida" : x.razao >= INFINITO ? "—" : pct(x.razao);
  const perto = x.pos.divida > 0n && x.razao < BigInt(x.a.crLiquidacaoBps) + 2_000n;
  const MODOS = { depositar: "Depositar", emitir: "Emitir BRLS", quitar: "Pagar dívida", retirar: "Retirar" };
  tela(`
    <h1>🏦 Cofre cripto</h1>
    <p class="mudo">Deposite cripto como garantia e emita BRLS sem vender. A garantia continua sua: ninguém mexe nela enquanto a posição estiver saudável. Sem juros.</p>
    <div class="seg" role="group" aria-label="Cripto">${ativos.map((y) => `<button data-acao="cofre-ativo-${y.i}" aria-pressed="${y.i === sel}">${esc(y.simbolo)}</button>`).join("")}</div>
    <div class="cartao ${perto ? "" : "ouro"}">
      <div class="linha"><span>Preço de 1 ${esc(x.simbolo)}</span><b>${x.ok ? reais(x.preco) : "indisponível"}</b></div>
      <div class="linha"><span>Sua garantia</span><b>${fmt(x.pos.colateral, x.decimais, 4)} ${esc(x.simbolo)} ≈ ${reais(x.valorGarantia)}</b></div>
      <div class="linha"><span>Sua dívida</span><b>${fmt(x.pos.divida)} BRLS</b></div>
      <div class="linha"><span>Saúde (garantia ÷ dívida)</span><b>${esc(saude)}</b></div>
      ${x.precoLiquidacao ? `<div class="linha"><span>Liquidação se ${esc(x.simbolo)} cair a</span><b>${reais(x.precoLiquidacao)}</b></div>` : ""}
      <div class="linha"><span>Pode emitir agora</span><b>${fmt(x.podeEmitir)} BRLS</b></div>
      <p class="mudo">Emissão até ${pct(x.a.crEmissaoBps)} de garantia · liquidação abaixo de ${pct(x.a.crLiquidacaoBps)} · taxa única de 0,5% somada à dívida · ${x.a.tetoDivida >= 10n ** 30n ? "sem limite total" : `limite total deste cofre: ${fmt(x.a.tetoDivida, 18, 0)} BRLS`}</p>
    </div>
    ${perto ? `<div class="erro">⚠️ Sua posição está perto da liquidação. Pague parte da dívida ou deposite mais ${esc(x.simbolo)}.</div>` : ""}
    ${x.ok && x.okEmissao ? "" : `<div class="aviso">${x.ok ? "A Chainlink está atrasada ou diverge da Uniswap. Por segurança, emitir e retirar garantia ficam parados até as fontes voltarem a concordar." : "O preço está indisponível. Por segurança, emitir, retirar e liquidar ficam parados."} Depositar e pagar dívida continuam sempre livres.</div>`}
    <div class="seg" role="group" aria-label="Operação">${Object.entries(MODOS).map(([m, r]) => `<button data-acao="cofre-modo-${m}" aria-pressed="${m === modo}">${r}</button>`).join("")}</div>
    <label for="cf-valor">${modo === "depositar" || modo === "retirar" ? `Quantidade de ${esc(x.simbolo)}` : "Quantidade de BRLS"}</label>
    <input id="cf-valor" class="grande" inputmode="decimal" placeholder="0,00">
    <p class="mudo">${{ depositar: `Na carteira: ${fmt(saldoTok, x.decimais, 4)} ${esc(x.simbolo)}`, emitir: `Máximo agora: ${fmt(x.podeEmitir)} BRLS (deixe uma folga: se a cripto cair, a saúde cai)`, quitar: `Dívida: ${fmt(x.pos.divida)} · você tem ${fmt(saldoX)} BRLS`, retirar: `Depositado: ${fmt(x.pos.colateral, x.decimais, 4)} ${esc(x.simbolo)}` }[modo]}</p>
    ${modo === "quitar" && x.pos.divida > 0n ? `<button class="btn sec" data-acao="cofre-tudo">Pagar a dívida toda</button>` : ""}
    ${S.chainId !== 137 && modo === "depositar" ? `<button class="btn sec" data-acao="cofre-torneira">🚰 Pegar ${esc(x.simbolo)} de teste</button>` : ""}
    ${botaoSegurar({ depositar: "depositar", emitir: "emitir BRLS", quitar: "pagar a dívida", retirar: "retirar" }[modo], "cofre")}
    <details class="cartao"><summary><b>⚖️ Liquidar posições em risco</b></summary>
      <p class="mudo">Qualquer pessoa pode pagar a dívida de uma posição abaixo de ${pct(x.a.crLiquidacaoBps)} e receber a garantia equivalente + 10% de bônus. Isso protege o BRLS de todo mundo.</p>
      <button class="btn sec" data-acao="cofre-risco">🔎 Procurar posições em risco</button>
      <div id="cf-risco"></div>
    </details>`);
  ligarMaximo("#cf-valor", async () => {
    if (modo === "depositar") return { max: saldoTok, decimais: x.decimais, simbolo: x.simbolo };
    if (modo === "emitir") return { max: x.podeEmitir, decimais: 18, simbolo: "BRLS", texto: `Pode emitir: <b>${fmt(x.podeEmitir)} BRLS</b> (a taxa de 0,5% entra na dívida; deixe folga)` };
    if (modo === "quitar") { const m = x.pos.divida < saldoX ? x.pos.divida : saldoX; return { max: m, decimais: 18, simbolo: "BRLS", texto: `Dívida: <b>${fmt(x.pos.divida)}</b> · você tem ${fmt(saldoX)} BRLS` }; }
    return x.pos.divida === 0n
      ? { max: x.pos.colateral, decimais: x.decimais, simbolo: x.simbolo }
      : { max: 0n, decimais: x.decimais, simbolo: x.simbolo, texto: `Depositado: <b>${fmt(x.pos.colateral, x.decimais, 4)} ${esc(x.simbolo)}</b> · com dívida, retire só uma parte (a saúde precisa ficar acima de ${pct(x.a.crEmissaoBps)})`, semSaldo: "Pague a dívida para retirar tudo" };
  });
};

/** Lista contas com dívida no ativo atual e destaca as liquidáveis. */
async function procurarRisco() {
  const { x } = S.params.cofre;
  const k = c("CofreCripto");
  const out = $("#cf-risco");
  out.innerHTML = `<div class="giro"></div>`;
  const atual = await S.provider.getBlockNumber();
  const contas = new Set();
  let de = Number(S.imp.blocoInicial) || 0;
  let passo = 50_000;
  while (de <= atual) {
    const ate = Math.min(atual, de + passo - 1);
    try {
      for (const ev of await k.queryFilter(k.filters.Emitido(x.i), de, ate)) contas.add(ev.args.conta);
      de = ate + 1;
    } catch (e) {
      if (passo <= 500) throw e;
      passo = Math.floor(passo / 4);
    }
  }
  const linhas = [];
  for (const conta of [...contas].slice(0, 200)) {
    const [pos, [razao, ok]] = await Promise.all([k.posicao(x.i, conta), k.razaoGarantia(x.i, conta)]);
    if (pos.divida === 0n || !ok) continue;
    linhas.push({ conta, pos, razao, liquidavel: razao < BigInt(x.a.crLiquidacaoBps) });
  }
  linhas.sort((a, b) => (a.razao < b.razao ? -1 : 1));
  S.params.risco = linhas;
  out.innerHTML = linhas.length
    ? linhas.slice(0, 20).map((l, j) => `<div class="linha"><span>${esc(curto(l.conta))} · ${pct(l.razao)}</span>${l.liquidavel ? `<button class="btn perigo" style="width:auto;margin:0" data-acao="cofre-simular-${j}">Liquidar</button>` : `<span class="selo verde">saudável</span>`}</div>`).join("")
    : `<p class="mudo">Nenhuma posição com dívida.</p>`;
}

// ---------- Trabalhos ----------
/** Mostra os números que sustentam o nível (contas falsas não conseguem forjar tempo nem pessoas distintas). */
function resumoReputacao(rep) {
  const prox = REGRAS_NIVEL[rep.nivel + 1];
  return `<p class="mudo">${Number(rep.concluidos)} trabalhos · ${Number(rep.contrapartes)} ${Number(rep.contrapartes) === 1 ? "pessoa diferente" : "pessoas diferentes"} · ${fmt(rep.volume, 18, 0)} BRLS movimentados ·
    média ${rep.media.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ★ (${Number(rep.avaliacoes)} avaliadores) · ${Number(rep.disputas)} disputas · conta com ${rep.idadeDias} dias</p>
    ${prox ? `<p class="mudo">Próximo nível: ${prox.contrapartes} pessoas diferentes, ${prox.avaliacoes} avaliadores, R$ ${prox.volume.toLocaleString("pt-BR")} movimentados e ${prox.idade} dias de conta.</p>` : ""}`;
}

/** QR Code em SVG (gerado no aparelho, sem servidor). */
function qrSvg(texto) {
  const q = qrcode(0, "M");
  q.addData(texto);
  q.make();
  return `<div style="background:#fff;padding:10px;border-radius:12px;max-width:260px;margin:10px auto">${q.createSvgTag({ cellSize: 6, margin: 1, scalable: true })}</div>`;
}

/** Abre a câmera e lê um QR (Android/Chrome). Sem suporte: pede para digitar as palavras. */
async function escanearQR(alvo, aoLer = null) {
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
    toast("Este aparelho não lê QR aqui. Digite as palavras.");
    return;
  }
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  modal(`<h2>Aponte para o QR</h2><video id="cam" playsinline muted style="width:100%;border-radius:12px"></video><button class="btn sec" data-acao="fechar-scanner">Cancelar</button>`);
  const v = $("#cam");
  v.srcObject = stream;
  await v.play();
  S.scanner = { stream, ativo: true };
  const parar = () => {
    S.scanner.ativo = false;
    stream.getTracks().forEach((t) => t.stop());
  };
  while (S.scanner.ativo) {
    try {
      const r = await detector.detect(v);
      if (r[0]?.rawValue) {
        const lido = String(r[0].rawValue);
        if (aoLer) {
          parar();
          fecharModal();
          return aoLer(lido);
        }
        const end = lido.match(/0x[0-9a-fA-F]{40}/);
        $(alvo).value = alvo === "#env-para" ? (end ? end[0] : "") : normalizarCodigo(lido);
        $(alvo).dispatchEvent(new Event("change"));
        parar();
        // Leu: já mostra o próximo passo na hora, sem a pessoa ter que procurar o botão.
        const proximo = { "#tr-cod": ["confirmar com o código", "tr-codigo", "Isso libera o pagamento agora."], "#tr-chegada": ["confirmar que cheguei", "tr-chegada", "Isso registra que você chegou ao local."], "#tr-dev": ["confirmar a devolução", "tr-devolucao", "Isso devolve o pagamento ao cliente e a sua caução para você."] }[alvo];
        if (proximo) {
          modal(`<h2>✅ Código lido</h2><div class="codigo">${esc($(alvo).value)}</div><p>${esc(proximo[2])}</p>${botaoSegurar(proximo[0], proximo[1])}<button class="btn sec" data-acao="fechar-modal">Agora não</button>`);
        } else {
          fecharModal();
          toast(alvo === "#env-para" ? "Endereço lido ✅ Agora digite o valor." : "Código lido ✅");
          if (alvo === "#env-para") $("#env-valor")?.focus();
        }
        return;
      }
    } catch { /* quadro ilegível: tenta o próximo */ }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  parar();
}

const estrelasNivel = (n) => `<span class="nivel" title="Nível ${n}">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;

TELAS.TRABALHOS = async () => {
  if (!S.escrow) return tela(`<h1>Trabalhos</h1><div class="aviso">Protocolo ainda não implantado nesta rede.</div>`);
  const aba = S.params.aba || "meus";
  tela(`<h1>Trabalhos</h1><div class="cartao" id="sinc"><div class="giro"></div><p class="mudo" id="sinc-txt">Lendo a blockchain…</p></div>`);
  await S.escrow.sincronizar(({ bloco, atual }) => {
    const t = $("#sinc-txt");
    if (t) t.textContent = `Lendo a blockchain… bloco ${bloco.toLocaleString("pt-BR")} de ${atual.toLocaleString("pt-BR")}`;
  });
  const [{ meus, vagas, arbitragens, arquivados }, rep] = await Promise.all([S.escrow.listar(S.endereco), S.escrow.reputacao(S.endereco)]);
  const lista = { meus, vagas, arbitragens }[aba] || meus;
  S.trabalhosVivos = trabalhosVivos(meus);
  const card = (t) => {
    const m = ESCROW.modalidades[t.modalidade];
    const papel = t.cliente.toLowerCase() === S.endereco.toLowerCase() ? "Você contratou" : t.trabalhador.toLowerCase() === S.endereco.toLowerCase() ? "Você trabalha" : aba === "arbitragens" ? "Você é árbitro" : "Vaga aberta";
    const fim = { cancelado: "↩️ Cancelado, valor devolvido", concluido: "✅ Concluído e pago", resolvido: "⚖️ Disputa resolvida" }[t.fim];
    const [ic, ds] = iconeDesc(t.descricao, m);
    return `<button class="item ${t.encerrado ? "arquivado" : ""}" data-trabalho="${esc(t.id)}"><span class="ic">${ic}</span><span class="meio"><b>${esc(ds)}</b><span class="mudo">#${esc(t.id)} · ${t.avaliar ? "⭐ Concluído: toque para avaliar" : fim ? esc(fim) : `${esc(m.nome)} · ${esc(papel)}`}</span>${!t.encerrado && (aba === "meus") ? (() => { const f = fasesTrabalho(t, t.cliente.toLowerCase() === S.endereco.toLowerCase()); return `<span class="fase-item ${f.alerta ? "alerta" : ""}">${esc(f.texto)}</span>${barraFases(f, true)}`; })() : ""}</span><b>${fmt(t.valor)}</b></button>`;
  };
  tela(`
    <h1>Trabalhos</h1>
    <div class="cartao"><div class="linha"><span>Sua reputação</span><span>${estrelasNivel(rep.nivel)} <b>${esc(rep.nomeNivel)}</b></span></div>
      ${resumoReputacao(rep)}</div>
    <button class="btn prim" data-ir="TRABALHO_NOVO">+ Contratar alguém</button>
    <button class="btn sec" data-acao="oferecer-servico">🧰 Oferecer um serviço</button>
    ${S.imp?.Encaminhador ? `<button class="btn sec" data-acao="semgas-ler">📷 Ler pedido sem gás (de quem está sem POL)</button>` : ""}
    <div class="seg" role="group"><button data-acao="aba-meus" aria-pressed="${aba === "meus"}">Meus (${meus.length})</button><button data-acao="aba-vagas" aria-pressed="${aba === "vagas"}">Vagas (${vagas.length})</button>${arbitragens.length ? `<button data-acao="aba-arbitragens" aria-pressed="${aba === "arbitragens"}">⚖️ Árbitro (${arbitragens.length})</button>` : ""}</div>
    ${lista.map(card).join("") || `<p class="mudo">${aba === "meus" && arquivados.length ? "Nenhum trabalho em andamento." : "Nada por aqui ainda."}</p>`}
    ${aba === "meus" && arquivados.length ? `<details class="arquivados"><summary>📁 Arquivados (${arquivados.length}) <small class="mudo">cancelados e concluídos</small></summary>${arquivados.map(card).join("")}</details>` : ""}`);
};

// ---------- Ponto exato no mapa (mapa.js) ----------
function botaoPonto(titulo, p, acaoMapa) {
  return `<p class="rotulo-ponto">${esc(titulo)}</p><button type="button" class="ponto ${p ? "marcado" : ""}" data-acao="${esc(acaoMapa)}">${p
    ? `<span class="ic">📍</span><span class="meio"><b>${esc(p.endereco || "Ponto marcado no mapa")}</b><span class="mudo">${p.complemento ? esc(p.complemento) + " · " : ""}${esc(fmtCoord(p.lat, p.lon))} · toque para mudar</span></span>`
    : `<span class="ic">🗺️</span><span class="meio"><b>Marcar no mapa</b><span class="mudo">Procure o endereço ou use "Estou aqui" e ajuste o pino</span></span>`}</button>`;
}

async function marcarPontoCorrida(qual) {
  const de = qual === "de";
  const p = await escolherPonto({ titulo: de ? "🟢 Onde você vai embarcar?" : "🏁 Para onde você vai?", inicial: de ? S.corrida.dePonto : S.corrida.paraPonto, dica: de ? "Toque em \"Estou aqui\" ou procure o endereço. Arraste até o pino ficar onde o carro deve parar." : "Procure o endereço do destino e ajuste o pino." });
  if (!p) return;
  S.corrida[de ? "dePonto" : "paraPonto"] = p;
  if (p.bairro) S.corrida[de ? "de" : "para"] = p.bairro;
  render();
}

/** Abre um ponto no app de GPS. No APK (Tor) quem abre é a Caixa Forte; fora dele, o link normal. */
/** Links de fora (WhatsApp, Jitsi, Drive…) dentro do APK: quem abre é a Caixa Forte (o app não tem internet própria). */
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-externo]");
  if (!a || !REDE_PELA_PONTE) return;
  ev.preventDefault();
  window.parent.postMessage({ brls: 1, tipo: "abrir", url: a.dataset.externo }, "*");
  toast("Abrindo…");
}, true);

document.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-gps]");
  if (!a || !REDE_PELA_PONTE) return;
  ev.preventDefault();
  const [lat, lon] = a.dataset.gps.split(",").map(Number);
  window.parent.postMessage({ brls: 1, tipo: "gps", lat, lon, app: a.dataset.app }, "*");
  toast("Abrindo no GPS…");
}, true);

// =====================================================================
// Vitrine (vitrine.js): anúncios, lojas de comida, sacola e Pix ⇄ BRLS — sem contrato novo.
// Comprar/contratar = trabalho do EscrowTrabalho. Comida com entregador = DOIS trabalhos ligados:
//   A) produto, ENTREGA designada à loja, código C1 (o entregador entrega C1 à loja na retirada → loja recebe);
//   B) entrega, ENTREGA com vaga aberta, código C2 (o cliente dá C2 na porta → entregador recebe).
// =====================================================================
const vit = () => S.vitrine;
const refAnuncio = (a) => a.id.slice(0, 8);
const reaisTxt = (v) => `R$ ${precoBr(v)}`;

/** Cria um trabalho já pronto (usado pela vitrine). Devolve { p, codigo, chegada, chaveEnd }. */
function prepararTrabalho({ modalidade, trabalhador = E.ZeroAddress, valor, horas = 72, descricao, comCodigo = true, privado = "" }) {
  const palavras = valor >= E.parseEther("1000") ? 6 : 5;
  const codigo = modalidade === 1 || comCodigo ? gerarCodigoEntrega(palavras) : null;
  const codigoHash = codigo ? hashCodigo(S.imp.EscrowTrabalho, S.endereco, codigo) : E.ZeroHash;
  if (codigo) guardarCodigo(codigoHash, codigo);
  const chegada = modalidade === 0 ? gerarCodigoEntrega(palavras) : null;
  const chegadaHash = chegada ? hashChegada(S.imp.EscrowTrabalho, S.endereco, chegada) : E.ZeroHash;
  if (chegada) guardarCodigo(chegadaHash, chegada);
  const p = {
    modalidade, trabalhador, valor, prazo: BigInt(agora() + horas * 3600), etapas: 1, codigoHash, chegadaHash,
    arbitroCliente: E.ZeroAddress, desempateCriador: false, caucao: 0n, devolucaoHash: E.ZeroHash, descricao: String(descricao).slice(0, 280),
  };
  const chaveEnd = modalidade === 0 ? chegadaHash : codigoHash;
  if (privado) try { localStorage.setItem(`xbrl.endereco.${chaveEnd}`, privado); } catch { /* sem armazenamento */ }
  return { p, codigo, chegada, chaveEnd };
}

async function conferirSaldos(valor, kit = 0n) {
  const [saldoX, saldoPol] = await Promise.all([c("xBRL").balanceOf(S.endereco), S.provider.getBalance(S.endereco)]);
  if (saldoX < valor) throw new Error(`Você tem ${fmt(saldoX)} BRLS e precisa de ${fmt(valor)}. Compre BRLS com Pix na Vitrine (💱) ou na aba Reserva.`);
  if (saldoPol < kit + E.parseEther("0.03")) throw new Error(`Falta POL para a taxa da rede${kit ? ` e o gás de ${fmt(kit, 18, 2)} POL` : ""}. Abasteça na tela Tanque.`);
}

// ---------- Tela: Vitrine ----------
TELAS.VITRINE = async () => {
  if (!S.imp?.Mensageiro) return tela(`<h1>🛍️ Vitrine</h1><div class="aviso">A vitrine ainda não existe nesta rede.</div>`);
  S.vitrineFiltro ||= { cat: "comida", busca: "" };
  const f = S.vitrineFiltro;
  const sacola = lerSacola();
  tela(`
    <h1>🛍️ Vitrine</h1>
    <div class="cats" role="group" aria-label="Categorias">${CATEGORIAS.map((x) => `<button data-acao="vit-cat-${x.id}" aria-pressed="${x.id === f.cat}"><span>${x.icone}</span>${esc(x.nome)}</button>`).join("")}</div>
    <input id="vit-busca" type="search" placeholder="Procurar: pizza, bicicleta, diarista…" value="${esc(f.busca)}" aria-label="Procurar na vitrine">
    ${sacola.itens.length ? `<div class="grade sacola-atalho"><button class="btn prim" data-ir="SACOLA">🛍️ Ver sacola · ${sacola.itens.reduce((s, i) => s + i.qtd, 0)} ${sacola.itens.length === 1 && sacola.itens[0].qtd === 1 ? "item" : "itens"} · ${reaisTxt(totalSacola(sacola))}</button><button class="btn sec" data-acao="sac-limpar" aria-label="Limpar sacola">🗑️</button></div>` : ""}
    <div id="vit-lista"><div class="cartao"><div class="giro"></div><p class="mudo">Lendo a vitrine na blockchain…</p></div></div>
    <div class="grade duas"><button class="atalho" data-ir="ANUNCIAR"><span>➕</span>Anunciar</button><button class="atalho" data-ir="MEUS_ANUNCIOS"><span>🗂️</span>Meus anúncios e loja</button></div>
    <p class="mudo">Os anúncios ficam na blockchain: ninguém apaga nem censura. Só quem anunciou pode editar, pausar ou encerrar. O dinheiro de cada compra fica travado no contrato até a entrega (código).</p>`);
  $("#vit-busca")?.addEventListener("input", (ev) => { f.busca = ev.target.value; desenharVitrine(); });
  await vit().sincronizar().catch(() => {});
  desenharVitrine();
  vigiar("VITRINE", async () => { await vit().sincronizar(); desenharVitrine(); }, 20000);
};

function cartaoAnuncio(a) {
  const k = CAT[a.cat];
  const preco = a.cat === "pix" ? `${a.pix.lado === "vendo" ? "vende" : "compra"} BRLS` : a.preco ? reaisTxt(a.preco) : "a combinar";
  return `<button class="item anuncio" data-anuncio="${esc(a.chave)}"><span class="ic foto" data-foto="${esc(a.chave)}">${a.fotos?.length ? "" : k.icone}</span><span class="meio"><b>${esc(a.titulo)}</b><span class="mudo">${esc(a.bairro || "")}${a.status !== "ativo" ? ` · ${esc(STATUS[a.status])}` : ""}</span></span><b>${esc(preco)}</b></button>`;
}

function desenharVitrine() {
  const box = $("#vit-lista");
  if (!box) return;
  const f = S.vitrineFiltro;
  const q = f.busca.trim().toLowerCase();
  const casa = (a) => !q || `${a.titulo} ${a.desc} ${a.bairro} ${(a.specs || []).flat().join(" ")}`.toLowerCase().includes(q);
  let html = "";
  if (f.cat === "comida") {
    const lojas = vit().lojas().filter((l) => !q || `${l.nome} ${l.desc} ${l.bairro}`.toLowerCase().includes(q));
    html += lojas.length ? `<h2>Lojas</h2>${lojas.map((l) => `<button class="item loja" data-loja="${esc(l.de)}"><span class="ic foto" data-foto="${esc(l.chave)}">${l.fotos?.length ? "" : "🏪"}</span><span class="meio"><b>${esc(l.nome)}</b><span class="mudo">${esc(l.bairro)}${l.horario ? ` · ${esc(l.horario)}` : ""} · entrega ${l.taxa && Number(l.taxa) > 0 ? reaisTxt(l.taxa) : "grátis"}</span></span><b>›</b></button>`).join("")}` : "";
  }
  if (f.cat === "pix") {
    const ofertas = vit().anuncios({ cat: "pix" }).filter(casa);
    const vendem = ofertas.filter((a) => a.pix.lado === "vendo");
    const compram = ofertas.filter((a) => a.pix.lado === "compro");
    html += `<div class="ok">💱 <b>Pix ⇄ BRLS de pessoa para pessoa.</b> O BRLS fica travado no contrato até quem recebe o Pix confirmar. Comece com valores pequenos e prefira quem tem reputação.</div>
      <h2>Comprar BRLS com Pix</h2>${vendem.map(cartaoAnuncio).join("") || `<p class="mudo">Ninguém vendendo BRLS agora.</p>`}
      <h2>Vender BRLS e receber Pix</h2>${compram.map(cartaoAnuncio).join("") || `<p class="mudo">Ninguém comprando BRLS agora.</p>`}
      <button class="btn sec" data-acao="vit-anunciar-pix">💱 Quero ser um caixa (oferecer Pix ⇄ BRLS)</button>`;
  } else {
    const lista = vit().anuncios({ cat: f.cat }).filter(casa);
    html += `${f.cat === "comida" ? "<h2>Pratos</h2>" : ""}${lista.map(cartaoAnuncio).join("") || `<div class="cartao"><p class="mudo">Nada anunciado aqui ainda. Que tal ser o primeiro? Toque em ➕ Anunciar.</p></div>`}`;
    if (f.cat === "farmacia") html += `<p class="mudo">⚠️ Remédio que exige receita (tarja vermelha ou preta) não pode ser vendido aqui.</p>`;
  }
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
    carregarMiniaturas(box);
  }
}

async function carregarMiniaturas(raiz) {
  for (const el of $$("[data-foto]", raiz)) {
    const item = vit().item(el.dataset.foto);
    if (!item?.fotos?.length) continue;
    vit().fotos(item).then((urls) => { if (urls[0]) el.innerHTML = `<img src="${urls[0]}" alt="">`; }).catch(() => {});
  }
}

document.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-anuncio]");
  if (a) return ir("ANUNCIO", { chave: a.dataset.anuncio });
  const l = ev.target.closest("[data-loja]");
  if (l) return ir("LOJA", { conta: l.dataset.loja });
});

// ---------- Tela: um anúncio ----------
TELAS.ANUNCIO = async () => {
  const a = vit().item(S.params.chave);
  if (!a) return tela(`<h1>Anúncio</h1><div class="aviso">Anúncio não encontrado.</div><button class="btn sec" data-ir="VITRINE">Voltar</button>`);
  const meu = a.de.toLowerCase() === S.endereco.toLowerCase();
  const rep = await S.escrow.reputacao(a.de).catch(() => null);
  const k = CAT[a.cat];
  const pix = a.cat === "pix" ? a.pix : null;
  tela(`
    <div id="an-fotos" class="fotos"></div>
    <h1>${k.icone} ${esc(a.titulo)}</h1>
    ${a.status !== "ativo" ? `<div class="aviso">Este anúncio está <b>${esc(STATUS[a.status].toLowerCase())}</b>.</div>` : ""}
    ${pix ? `<div class="cartao"><div class="linha"><span>${pix.lado === "vendo" ? "Vende BRLS, recebe Pix" : "Compra BRLS, paga Pix"}</span><b>R$ ${precoBr(pix.min)} a ${precoBr(pix.max)}</b></div>
        <div class="linha"><span>Prêmio de quem ${pix.lado === "vendo" ? "vende" : "paga o Pix"}</span><b>${String(pix.premio).replace(".", ",")}%</b></div>
        ${pix.banco ? `<div class="linha"><span>Banco</span><span>${esc(pix.banco)}</span></div>` : ""}</div>`
      : `<p class="preco">${a.preco ? esc(reaisTxt(a.preco)) : "Preço a combinar"}</p>`}
    ${a.desc ? `<p style="white-space:pre-line">${esc(a.desc)}</p>` : ""}
    ${a.specs?.length ? `<div class="cartao specs">${a.specs.map(([n, v]) => `<div class="linha"><span>${esc(n)}</span><b>${esc(v)}</b></div>`).join("")}</div>` : ""}
    ${meu && (a.variacoes?.length || a.opcoes?.length) ? `<div class="cartao">${a.variacoes?.length ? `<b>${a.cat === "comida" ? "Sabores" : "Variações"}</b>${a.variacoes.map((o) => `<div class="linha"><span>${esc(o.nome)}</span><span>${Number(o.extra) ? esc(reaisTxt(o.extra)) : "—"}</span></div>`).join("")}` : ""}${a.opcoes?.length ? `<b>Adicionais</b>${a.opcoes.map((o) => `<div class="linha"><span>${esc(o.nome)}</span><span>${Number(o.extra) > 0 ? "+ " + esc(reaisTxt(o.extra)) : "sem custo"}</span></div>`).join("")}` : ""}</div>` : ""}
    <div class="cartao">
      <div class="linha"><span>Onde</span><span>${esc(a.bairro || "—")}</span></div>
      ${a.cat !== "pix" && a.cat !== "servicos" ? `<div class="linha"><span>Entrega</span><span>${esc(ENTREGAS[a.entrega])}</span></div>` : ""}
      ${a.servico ? `<div class="linha"><span>Serviço</span><span>${a.servico === "presencial" ? "No local" : "À distância"}</span></div>` : ""}
      <div class="linha"><span>Anunciante</span><span>${esc(curto(a.de))} ${rep ? `${estrelasNivel(rep.nivel)} <small class="mudo">${Number(rep.contrapartes)} ${Number(rep.contrapartes) === 1 ? "pessoa" : "pessoas"} · ${rep.idadeDias} dias</small>` : ""}</span></div>
    </div>
    <div id="an-acao"></div>
    ${meu ? `<h2>Seu anúncio</h2>
      <button class="btn sec" data-acao="an-editar">✏️ Editar</button>
      ${a.status === "ativo" ? `<button class="btn sec" data-acao="an-status-pausado">⏸️ Pausar</button>` : `<button class="btn sec" data-acao="an-status-ativo">▶️ Reativar</button>`}
      ${a.cat !== "pix" && a.cat !== "servicos" ? `<button class="btn sec" data-acao="an-status-vendido">✅ Marcar como vendido</button>` : ""}
      <button class="btn perigo" data-acao="an-status-encerrado">🗑️ Encerrar anúncio</button>
      <p class="mudo">O anúncio continua na blockchain, mas some da vitrine quando pausado, vendido ou encerrado.</p>` : ""}
    <button class="btn sec" data-ir="VITRINE">Voltar à vitrine</button>`);
  vit().fotos(a).then((urls) => { const b = $("#an-fotos"); if (b && urls.length) b.innerHTML = urls.map((u) => `<img src="${u}" alt="Foto do anúncio">`).join(""); }).catch(() => {});
  if (!meu && a.status === "ativo") desenharAcaoAnuncio(a);
};

function desenharAcaoAnuncio(a) {
  const box = $("#an-acao");
  if (a.cat === "pix") {
    const p = a.pix;
    box.innerHTML = p.lado === "vendo"
      ? `<div class="cartao"><h2 style="margin-top:0">Comprar BRLS com Pix</h2>
          <label for="pix-reais">Quanto você vai pagar no Pix (R$ ${precoBr(p.min)} a ${precoBr(p.max)})</label><input id="pix-reais" class="grande" inputmode="decimal" placeholder="0,00">
          <p class="mudo" id="pix-recebe">Você recebe em BRLS o valor menos ${String(p.premio).replace(".", ",")}% (o prêmio de quem vende).</p>
          <ol class="passos-mini"><li>Você pede. O vendedor trava os BRLS no contrato, para você.</li><li>Você paga o Pix na chave dele e toca em "Já paguei".</li><li>Ele confere e libera. Se ele sumir, você recebe sozinho em 3 dias.</li></ol>
          ${botaoSegurar("pedir para comprar", "pix-pedir")}</div>`
      : `<div class="cartao"><h2 style="margin-top:0">Vender BRLS e receber Pix</h2>
          <label for="pix-reais">Quantos reais você quer receber no Pix (R$ ${precoBr(p.min)} a ${precoBr(p.max)})</label><input id="pix-reais" class="grande" inputmode="decimal" placeholder="0,00">
          <label for="pix-minha-chave">Sua chave Pix (vai cifrada, só para ele)</label><input id="pix-minha-chave" maxlength="80" placeholder="De preferência uma chave aleatória">
          <p class="mudo" id="pix-recebe">Você trava em BRLS o valor mais ${String(p.premio).replace(".", ",")}% (o prêmio de quem paga o Pix).</p>
          <ol class="passos-mini"><li>Você trava os BRLS no contrato, para ele.</li><li>Ele aceita, faz o Pix e avisa.</li><li>Você confere no banco e libera. Só libere depois de ver o dinheiro na conta.</li></ol>
          ${botaoSegurar("travar BRLS e pedir o Pix", "pix-vender")}</div>`;
    $("#pix-reais")?.addEventListener("input", (ev) => {
      try {
        const r = Number(String(ev.target.value).replace(/\./g, "").replace(",", "."));
        const brls = p.lado === "vendo" ? r * (1 - p.premio / 100) : r * (1 + p.premio / 100);
        $("#pix-recebe").textContent = r > 0 ? (p.lado === "vendo" ? `Você recebe ${precoBr(brls.toFixed(2))} BRLS.` : `Você trava ${precoBr(brls.toFixed(2))} BRLS.`) : "";
      } catch { /* digitando */ }
    });
  } else if (a.cat === "comida") {
    box.innerHTML = `<div class="cartao">
      ${camposEscolha(a)}
      <label for="an-qtd">Quantidade</label><input id="an-qtd" inputmode="numeric" value="1">
      <label for="an-obs">Observação (opcional)</label><input id="an-obs" maxlength="40" placeholder="Ex.: sem cebola">
      <button class="btn prim" data-acao="an-sacola">🛍️ Adicionar à sacola</button></div>`;
  } else if (a.cat === "servicos") {
    box.innerHTML = `<div class="cartao"><h2 style="margin-top:0">Contratar</h2>
      ${a.servico === "presencial" ? botaoPonto("📍 Onde vai ser o serviço", S.params.ponto, "an-mapa") : ""}
      <label for="an-valor">Valor combinado (BRLS)</label><input id="an-valor" class="grande" inputmode="decimal" value="${a.preco ? esc(precoBr(a.preco)) : ""}">
      <label for="an-dias">Prazo (dias)</label><input id="an-dias" inputmode="numeric" value="7">
      ${botaoSegurar("travar o pagamento e contratar", "an-contratar")}
      <p class="mudo">O valor fica travado no contrato. ${a.servico === "presencial" ? "Na chegada, você confirma; no fim, libera o pagamento." : "Quando ficar pronto, você libera o pagamento."}</p></div>`;
  } else {
    box.innerHTML = `<div class="cartao"><h2 style="margin-top:0">Comprar</h2>
      ${camposEscolha(a)}
      <label for="an-qtd">Quantidade</label><input id="an-qtd" inputmode="numeric" value="1">
      ${a.entrega === "combinar" ? `<p class="mudo">Retirada ou entrega a combinar pela conversa cifrada, depois que o vendedor aceitar.</p>` : botaoPonto("📍 Onde entregar", S.params.ponto, "an-mapa")}
      ${botaoSegurar("travar o pagamento e comprar", "an-comprar")}
      <p class="mudo">🔒 O vendedor só recebe quando você der o <b>código de entrega</b>, na hora em que estiver com o produto na mão. Nunca passe o código antes.</p></div>`;
  }
  ligarSegurar(box);
  ligarMaximo("#an-valor", saldoBrls);
  if (a.cat === "pix" && a.pix.lado === "compro") {
    // Vender BRLS por Pix: o máximo em reais já desconta o prêmio do caixa (você trava reais × (1 + prêmio))
    ligarMaximo("#pix-reais", async () => {
      const b = await c("xBRL").balanceOf(S.endereco);
      let max = (b * 10000n) / BigInt(Math.round(10000 * (1 + a.pix.premio / 100)));
      const teto = lerValor(a.pix.max);
      if (max > teto) max = teto;
      return { max, decimais: 18, simbolo: "reais", texto: `Você tem <b>${fmt(b)} BRLS</b> · dá para receber até R$ ${fmt(max)}`, nota: `Já descontei o prêmio de ${String(a.pix.premio).replace(".", ",")}%.` };
    });
  }
}

async function comprarAnuncio(servico) {
  const a = vit().item(S.params.chave);
  const pt = S.params.ponto;
  const qtd = servico ? 1 : Math.max(1, Math.min(99, Number($("#an-qtd")?.value) || 1));
  const escolha = servico ? { variacao: "", adicionais: [], extra: "0" } : lerEscolhas(a);
  const valor = servico ? lerValor($("#an-valor").value) : lerValor((Number(a.preco || 0) + Number(escolha.extra)).toFixed(2)) * BigInt(qtd);
  if (valor === 0n) throw new Error("Informe o valor");
  const precisaPonto = servico ? a.servico === "presencial" : a.entrega !== "combinar";
  if (precisaPonto && !pt) throw new Error("Marque no mapa o endereço exato");
  const kit = E.parseEther("0.3");
  await conferirSaldos(valor, kit);
  const mod = servico ? (a.servico === "presencial" ? 0 : 2) : 1;
  const desc = `${servico ? "🧰" : "🛍️"} ${a.titulo}${textoEscolhas(escolha) ? ` (${textoEscolhas(escolha)})` : ""}${qtd > 1 ? ` ×${qtd}` : ""} · ref ${refAnuncio(a)}`;
  const privado = pt ? `${servico ? "Local do serviço" : "Entregar em"}: ${textoDoPonto(pt)}` : "";
  const horas = servico ? Math.max(1, Math.min(365, Number($("#an-dias").value) || 7)) * 24 : 72;
  const { p, codigo, chegada } = prepararTrabalho({ modalidade: mod, trabalhador: E.getAddress(a.de), valor, horas, descricao: desc, comCodigo: !servico, privado });
  await executar(servico ? "Contratar" : "Comprar", [passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, valor, "Autorizar BRLS"), { rotulo: "Travar pagamento", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(p, { ...o, value: kit }) }]);
  modal(`<h2>✅ Pagamento travado</h2><p>${servico ? "O profissional" : "O vendedor"} recebe um pedido no app. Quando ${servico ? "ele" : "ele"} aceitar, ${privado ? "envie o endereço na tela do trabalho (vai cifrado)" : "combinem pela conversa cifrada"}.</p>
    ${codigo ? `<p><b>🔑 Código de entrega</b> — dê <b>só</b> quando o produto estiver na sua mão:</p>${qrSvg(codigo)}<div class="codigo">${esc(codigo)}</div>` : ""}
    ${chegada ? `<p class="mudo">Quando o profissional chegar, confirme a chegada na tela do trabalho.</p>` : ""}
    <p class="mudo">Tudo fica salvo na tela do trabalho, em Trabalhos.</p><button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
  ir("TRABALHOS", { aba: "meus" });
}

// ---------- Tela: anunciar / editar ----------
const SUGESTOES_SPECS = {
  usados: ["Marca", "Modelo", "Estado", "Ano", "Tamanho", "Cor", "Garantia"],
  comida: ["Serve", "Peso", "Ingredientes"],
  mercado: ["Marca", "Peso/volume", "Validade"],
  farmacia: ["Marca", "Quantidade", "Validade"],
  servicos: ["Experiência", "Atende", "Horário", "Material incluso"],
};

TELAS.ANUNCIAR = async () => {
  const ed = S.params.chave ? vit().item(S.params.chave) : null;
  const cat = ed?.cat || S.params.cat || (S.vitrineFiltro?.cat ?? "usados");
  S.anuncio = { fotos: [], ...(S.anuncio?.chave === S.params.chave ? S.anuncio : {}), chave: S.params.chave || null };
  const a = ed ? { ...ed, pix: ed.pix && S.params.lado ? { ...ed.pix, lado: S.params.lado } : ed.pix } : { cat, specs: [], opcoes: [], entrega: cat === "comida" ? "propria" : "combinar", pix: { lado: S.params.lado || "vendo", min: "20", max: "500", premio: 1 } };
  const specs = a.specs.length ? a.specs : (SUGESTOES_SPECS[cat] || []).slice(0, 3).map((n) => [n, ""]);
  tela(`
    <h1>${ed ? "✏️ Editar anúncio" : "➕ Anunciar"}</h1>
    <label for="na-cat">Categoria</label><select id="na-cat">${CATEGORIAS.map((x) => `<option value="${x.id}" ${x.id === cat ? "selected" : ""}>${x.icone} ${esc(x.nome)}</option>`).join("")}</select>
    ${cat === "pix" ? `
      <div class="seg" role="group"><button data-acao="na-pix-vendo" aria-pressed="${a.pix.lado === "vendo"}">Vendo BRLS (recebo Pix)</button><button data-acao="na-pix-compro" aria-pressed="${a.pix.lado === "compro"}">Compro BRLS (pago Pix)</button></div>
      <input type="hidden" id="na-pix-lado" value="${esc(a.pix.lado)}">
      <label for="na-titulo">Título</label><input id="na-titulo" maxlength="80" value="${esc(a.titulo || (a.pix.lado === "vendo" ? "Vendo BRLS no Pix, atendo rápido" : "Compro BRLS, pago no Pix"))}">
      <div class="grade duas"><div><label for="na-min">Mínimo (R$)</label><input id="na-min" inputmode="decimal" value="${esc(precoBr(a.pix.min))}"></div><div><label for="na-max">Máximo (R$)</label><input id="na-max" inputmode="decimal" value="${esc(precoBr(a.pix.max))}"></div></div>
      <label for="na-premio">Seu prêmio (%)</label><input id="na-premio" inputmode="decimal" value="${esc(String(a.pix.premio).replace(".", ","))}">
      ${a.pix.lado === "vendo" ? `<label for="na-chave">Sua chave Pix ALEATÓRIA (fica pública)</label><input id="na-chave" maxlength="80" placeholder="ex.: 1f3c…-…" value="${esc(a.pix.chave || "")}">
      <p class="mudo">Use uma chave aleatória, nunca CPF ou telefone: ela aparece para todos.</p>` : ""}
      <label for="na-banco">Banco (opcional)</label><input id="na-banco" maxlength="40" value="${esc(a.pix.banco || "")}">
      <div class="aviso">⚠️ Quem vende BRLS só libera depois de ver o Pix <b>na conta</b> (não acredite em print). Golpistas pedem estorno do Pix depois: prefira quem tem reputação e comece pequeno.</div>`
    : `
      <label for="na-titulo">Título</label><input id="na-titulo" maxlength="80" placeholder="${cat === "comida" ? "Ex.: X-Burger da casa" : cat === "servicos" ? "Ex.: Diarista, faxina completa" : "Ex.: Bicicleta aro 29, 21 marchas"}" value="${esc(a.titulo || "")}">
      <label for="na-preco">Preço (R$/BRLS)${cat === "servicos" ? " — deixe vazio se for a combinar" : ""}</label><input id="na-preco" class="grande" inputmode="decimal" placeholder="0,00" value="${a.preco ? esc(precoBr(a.preco)) : ""}">
      <label for="na-desc">Descrição</label><textarea id="na-desc" maxlength="900" placeholder="Conte tudo: estado, o que vem junto, defeitos, como funciona…">${esc(a.desc || "")}</textarea>
      <h2>Especificações</h2><div id="na-specs">${specs.map(([n, v]) => linhaSpec(n, v)).join("")}</div>
      <button class="btn sec" data-acao="na-spec-mais">+ Especificação</button>
      ${cat !== "servicos" ? `<h2>${cat === "comida" ? "Sabores" : "Variações"} <small class="mudo">(o cliente escolhe uma)</small></h2>
      <p class="mudo">${cat === "comida" ? "Ex.: pastel de carne, queijo, frango, pizza, banana; caldo com limão ou sem limão. Diferença de preço é opcional." : "Ex.: tamanho P, M, G; cor azul ou preta. Diferença de preço é opcional."}</p>
      <div id="na-vars">${(a.variacoes?.length ? a.variacoes : []).map((o) => linhaVar(o.nome, o.extra)).join("")}</div><button class="btn sec" data-acao="na-var-mais">+ ${cat === "comida" ? "Sabor" : "Variação"}</button>
      <h2>Adicionais <small class="mudo">(opcional, o cliente marca quantos quiser)</small></h2><div id="na-opcoes">${(a.opcoes?.length ? a.opcoes : []).map((o) => linhaOpcao(o.nome, o.extra)).join("")}</div><button class="btn sec" data-acao="na-opcao-mais">+ Adicional (ex.: bacon + R$ 4,00)</button>` : ""}
      ${cat === "servicos" ? `<label for="na-servico">Como é o serviço</label><select id="na-servico"><option value="presencial" ${a.servico !== "remoto" ? "selected" : ""}>No local (presencial)</option><option value="remoto" ${a.servico === "remoto" ? "selected" : ""}>À distância</option></select>`
        : `<label for="na-entrega">Entrega</label><select id="na-entrega">${Object.entries(ENTREGAS).filter(([k]) => k !== "entregador").map(([k, n]) => `<option value="${k}" ${k === a.entrega ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
          <label for="na-taxa">Taxa de entrega (R$, se você entrega)</label><input id="na-taxa" inputmode="decimal" placeholder="0,00" value="${Number(a.taxaEntrega) ? esc(precoBr(a.taxaEntrega)) : ""}">
          ${cat === "comida" ? `<p class="mudo">Não precisa criar loja. Se criar o perfil de loja (com entregador da rede, horário e foto), vale o que estiver no perfil.</p>` : ""}`}
      <h2>Fotos (até 3)</h2><input id="na-fotos" type="file" accept="image/*" multiple><div id="na-prev" class="fotos mini"></div>
      <p class="mudo">As fotos são diminuídas no celular para caber na blockchain.${ed?.fotos?.length ? " Sem escolher fotos novas, as atuais continuam." : ""}</p>`}
    <label for="na-bairro">Bairro e cidade (público)</label><input id="na-bairro" maxlength="40" placeholder="Ex.: Savassi, Belo Horizonte" value="${esc(a.bairro || "")}">
    <button class="btn sec" data-acao="na-bairro-mapa">🗺️ Pegar o bairro pelo mapa</button>
    ${cat === "farmacia" ? `<div class="aviso">Proibido anunciar remédio que exige receita (tarja vermelha ou preta).</div>` : ""}
    ${botaoSegurar(ed ? "publicar a nova versão" : "publicar o anúncio", "na-publicar")}
    <p class="mudo">Publicar custa uma pequena taxa da rede (centavos de POL). Fica na blockchain para sempre; você pode editar, pausar ou encerrar quando quiser.</p>
    <button class="btn sec" data-ir="VITRINE">Cancelar</button>`);
  $("#na-cat").addEventListener("change", (ev) => ir("ANUNCIAR", { ...S.params, cat: ev.target.value }));
  $("#na-fotos")?.addEventListener("change", (ev) => {
    S.anuncio.fotos = [...ev.target.files].slice(0, MAX_FOTOS);
    $("#na-prev").innerHTML = S.anuncio.fotos.map((f) => `<img src="${URL.createObjectURL(f)}" alt="">`).join("");
  });
};

const linhaSpec = (n = "", v = "") => `<div class="spec"><input class="spec-n" maxlength="30" placeholder="Nome" value="${esc(n)}"><input class="spec-v" maxlength="80" placeholder="Valor" value="${esc(v)}"></div>`;
const linhaVar = (n = "", v = "") => `<div class="spec"><input class="var-n" maxlength="40" placeholder="Ex.: Carne" value="${esc(n)}"><input class="var-v" inputmode="decimal" placeholder="+ R$ (opcional)" value="${v && Number(v) ? esc(precoBr(v)) : ""}"></div>`;
const linhaOpcao = (n = "", v = "") => `<div class="spec"><input class="op-n" maxlength="40" placeholder="Opção" value="${esc(n)}"><input class="op-v" inputmode="decimal" placeholder="+ R$" value="${v && Number(v) > 0 ? esc(precoBr(v)) : ""}"></div>`;
const valorDecimal = (txt) => {
  const s = String(txt || "").trim();
  if (!s) return null;
  return E.formatUnits(lerValor(s), 18).replace(/\.0$/, "").replace(/(\.\d\d)\d+$/, "$1");
};

async function publicarAnuncio() {
  const ed = S.params.chave ? vit().item(S.params.chave) : null;
  const cat = $("#na-cat").value;
  const ler = (id) => ($(`#${id}`)?.value || "").trim();
  const o = { t: "a", id: ed?.id || novoId(), cat, titulo: ler("na-titulo"), bairro: ler("na-bairro"), status: ed?.status === "vendido" || ed?.status === "encerrado" ? "ativo" : ed?.status || "ativo" };
  if (o.titulo.length < 3) throw new Error("Escreva um título");
  if (o.bairro.length < 3) throw new Error("Informe o bairro e a cidade");
  if (cat === "pix") {
    const lado = ler("na-pix-lado") || "vendo";
    o.pix = { lado, min: valorDecimal(ler("na-min")) || "10", max: valorDecimal(ler("na-max")) || "500", premio: Number(ler("na-premio").replace(",", ".")) || 0, chave: ler("na-chave"), banco: ler("na-banco") };
    if (lado === "vendo" && o.pix.chave.length < 8) throw new Error("Informe sua chave Pix aleatória");
    if (Number(o.pix.min) > Number(o.pix.max)) throw new Error("O mínimo é maior que o máximo");
  } else {
    o.preco = valorDecimal(ler("na-preco"));
    if (cat !== "servicos" && !o.preco) throw new Error("Informe o preço");
    o.desc = ler("na-desc");
    o.specs = $$("#na-specs .spec").map((d) => [d.querySelector(".spec-n").value, d.querySelector(".spec-v").value]);
    o.opcoes = $$("#na-opcoes .spec").map((d) => ({ nome: d.querySelector(".op-n").value, extra: valorDecimal(d.querySelector(".op-v").value) || "0" }));
    o.variacoes = $$("#na-vars .spec").map((d) => ({ nome: d.querySelector(".var-n").value, extra: valorDecimal(d.querySelector(".var-v").value) || "0" }));
    o.entrega = ler("na-entrega") || "combinar";
    o.taxaEntrega = o.entrega === "propria" ? valorDecimal(ler("na-taxa")) || "0" : "0";
    if (cat === "servicos") o.servico = ler("na-servico") || "presencial";
  }
  let itens;
  const novas = S.anuncio?.fotos || [];
  if (novas.length || !ed?.fotos?.length) itens = await montarItens(o, novas);
  else {
    // Mantém as fotos atuais: reenvia os mesmos pedaços
    await vit().fotos(ed);
    const pedacos = vit().fotosMem.get(ed.tx) || [];
    itens = [codificar({ ...o, fotos: ed.fotos }), ...pedacos];
  }
  await publicarItens(ed ? "Publicar nova versão" : "Publicar anúncio", itens);
  S.anuncio = null;
  await vit().sincronizar().catch(() => {});
  ir("ANUNCIO", { chave: `${S.endereco.toLowerCase()}:${o.id}` });
}

/** Envia itens para o canal público da vitrine (Mensageiro). */
async function publicarItens(titulo, itens) {
  const m = c("Mensageiro", true);
  const args = [conversaVitrine(), itens.map(() => S.endereco), itens, "0x"];
  const r = await executar(titulo, [{ rotulo: "Publicar na blockchain", fn: (o) => m.enviar(...args, o) }]);
  return r;
}

async function mudarStatus(status) {
  const a = vit().item(S.params.chave);
  await publicarItens(STATUS[status] === "Ativo" ? "Reativar anúncio" : `${STATUS[status]}`, [codificar({ t: "s", id: a.id, status })]);
  await vit().sincronizar().catch(() => {});
  render();
}

// ---------- Tela: meus anúncios e loja ----------
TELAS.MEUS_ANUNCIOS = async () => {
  await vit().sincronizar().catch(() => {});
  const meus = vit().anuncios({ de: S.endereco, todos: true });
  const loja = vit().loja(S.endereco);
  await S.escrow.sincronizar().catch(() => {});
  const { meus: trabalhos } = await S.escrow.listar(S.endereco);
  const pedidos = trabalhos.filter((t) => t.trabalhador?.toLowerCase() === S.endereco.toLowerCase() && /^(🍔|🛍️|🧰|💱)/u.test(t.descricao));
  tela(`
    <h1>🗂️ Meus anúncios e loja</h1>
    <div id="pix-pedidos"></div>
    ${pedidos.length ? `<h2>Pedidos para você</h2>${pedidos.map((t) => `<button class="item" data-trabalho="${esc(t.id)}"><span class="ic">${esc([...t.descricao][0])}</span><span class="meio"><b>${esc(t.descricao.slice(2))}</b><span class="mudo">#${esc(t.id)} · toque para ver</span></span><b>${fmt(t.valor)}</b></button>`).join("")}` : ""}
    ${meus.some((a) => a.cat === "pix") ? `<button class="btn sec" data-acao="pix-colar-pedido">📋 Colar um pedido Pix recebido por mensagem</button>` : ""}
    <div id="vit-correio"></div>
    <button class="btn ${lojaOnline() ? "perigo" : "prim"}" data-acao="loja-online">${lojaOnline() ? "🔕 Parar de receber pedidos em segundo plano" : "🔔 Receber pedidos com aviso (também com o app em segundo plano)"}</button>
    <h2>🏪 Sua loja ${loja ? `<small class="mudo">${esc(STATUS[loja.status])}</small>` : ""}</h2>
    <p class="mudo">Para vender comida com cardápio, crie o perfil da loja. Seus pratos (categoria Comida) aparecem nela.</p>
    <button class="btn sec" data-ir="LOJA_EDITAR">${loja ? "✏️ Editar a loja" : "🏪 Criar minha loja"}</button>
    ${loja ? `<button class="btn sec" data-loja="${esc(loja.de)}">👀 Ver como os clientes veem</button>` : ""}
    <h2>Anúncios (${meus.length})</h2>
    ${meus.map(cartaoAnuncio).join("") || `<p class="mudo">Você ainda não anunciou nada.</p>`}
    <button class="btn prim" data-ir="ANUNCIAR">➕ Novo anúncio</button>`);
  carregarMiniaturas($("#tela"));
  const atualizarPix = async () => {
    await mostrarPedidosPix($("#pix-pedidos"));
    // Comprador sem POL aceitando o Pix (pedido sem gás): aparece aqui para você enviar por ele
    await S.escrow.sincronizar();
    const { meus: ms } = await S.escrow.listar(S.endereco);
    const minhasPix = ms.filter((t) => t.cliente.toLowerCase() === S.endereco.toLowerCase() && /^(💱|🛍️|🧰|🍔)/u.test(t.descricao));
    const det = (await Promise.all(minhasPix.slice(0, 6).map((t) => S.escrow.detalhe(t.id).catch(() => null)))).filter(Boolean);
    await mostrarCorreio($("#vit-correio"), det, null);
  };
  atualizarPix().catch(() => {});
  vigiar("MEUS_ANUNCIOS", atualizarPix, 15000);
};

// ---------- Loja (perfil) ----------
TELAS.LOJA_EDITAR = async () => {
  const l = vit().loja(S.endereco) || { nome: "", desc: "", horario: "", bairro: "", taxa: "0", entrega: "propria", status: "ativo" };
  S.lojaPonto ||= l.lat != null ? { lat: l.lat, lon: l.lon, endereco: l.endereco } : null;
  tela(`
    <h1>🏪 ${l.nome ? "Editar a loja" : "Criar minha loja"}</h1>
    <label for="lj-nome">Nome da loja</label><input id="lj-nome" maxlength="60" value="${esc(l.nome)}" placeholder="Ex.: Pastelândia">
    <label for="lj-desc">Sobre a loja</label><textarea id="lj-desc" maxlength="400" placeholder="O que vende, diferenciais">${esc(l.desc)}</textarea>
    <label for="lj-horario">Horário</label><input id="lj-horario" maxlength="80" value="${esc(l.horario)}" placeholder="Ex.: todos os dias, 11h às 23h">
    ${botaoPonto("📍 Endereço de retirada (público, para os entregadores)", S.lojaPonto, "lj-mapa")}
    <label for="lj-bairro">Bairro e cidade (público)</label><input id="lj-bairro" maxlength="40" value="${esc(l.bairro)}">
    <label for="lj-entrega">Quem entrega</label><select id="lj-entrega"><option value="propria" ${l.entrega === "propria" ? "selected" : ""}>A própria loja</option><option value="entregador" ${l.entrega === "entregador" ? "selected" : ""}>Entregador da rede BRLS (carro, moto ou bicicleta)</option></select>
    <label for="lj-taxa">Taxa de entrega (R$)</label><input id="lj-taxa" inputmode="decimal" value="${esc(precoBr(l.taxa))}">
    <p class="mudo">Com entregador da rede, a taxa vai inteira para quem entregar.</p>
    <label for="lj-status">Situação</label><select id="lj-status"><option value="ativo" ${l.status === "ativo" ? "selected" : ""}>Aberta (aparece na vitrine)</option><option value="pausado" ${l.status === "pausado" ? "selected" : ""}>Fechada agora</option></select>
    <h2>Foto da fachada ou logo</h2><input id="lj-foto" type="file" accept="image/*">
    ${botaoSegurar("publicar a loja", "lj-publicar")}
    <button class="btn sec" data-ir="MEUS_ANUNCIOS">Voltar</button>`);
  $("#lj-foto").addEventListener("change", (ev) => { S.lojaFoto = ev.target.files[0] || null; });
};

async function publicarLoja() {
  const ler = (id) => ($(`#${id}`)?.value || "").trim();
  const ant = vit().loja(S.endereco);
  const pt = S.lojaPonto;
  const o = { t: "l", id: "perfil", nome: ler("lj-nome"), desc: ler("lj-desc"), horario: ler("lj-horario"), bairro: ler("lj-bairro"), taxa: valorDecimal(ler("lj-taxa")) || "0", entrega: ler("lj-entrega"), status: ler("lj-status") };
  if (o.nome.length < 2) throw new Error("Dê um nome à loja");
  if (o.bairro.length < 3) throw new Error("Informe o bairro e a cidade");
  if (o.entrega === "entregador" && !pt) throw new Error("Com entregador da rede, marque no mapa o endereço de retirada");
  if (o.entrega === "entregador" && Number(o.taxa) < 1) throw new Error("Com entregador da rede, a taxa de entrega precisa ser de pelo menos R$ 1,00 (é o pagamento dele)");
  if (pt) Object.assign(o, { lat: pt.lat, lon: pt.lon, endereco: [pt.endereco, pt.complemento].filter(Boolean).join(", ") });
  let itens;
  if (S.lojaFoto || !ant?.fotos?.length) itens = await montarItens(o, S.lojaFoto ? [S.lojaFoto] : []);
  else {
    await vit().fotos(ant);
    itens = [codificar({ ...o, fotos: ant.fotos }), ...(vit().fotosMem.get(ant.tx) || [])];
  }
  await publicarItens("Publicar a loja", itens);
  S.lojaFoto = null;
  await vit().sincronizar().catch(() => {});
  ir("MEUS_ANUNCIOS");
}

TELAS.LOJA = async () => {
  await vit().sincronizar().catch(() => {});
  const l = lojaDe(S.params.conta);
  if (!l) return tela(`<h1>Loja</h1><div class="aviso">Esta pessoa não tem nada à venda agora.</div><button class="btn sec" data-ir="VITRINE">Voltar</button>`);
  const pratos = vit().anuncios({ cat: "comida", de: l.de });
  const rep = await S.escrow.reputacao(l.de).catch(() => null);
  const sacola = lerSacola();
  tela(`
    <div id="lj-fotos" class="fotos"></div>
    <h1>🏪 ${esc(l.nome)}</h1>
    <p class="mudo">${esc(l.bairro)}${l.horario ? ` · ${esc(l.horario)}` : ""} · ${rep ? `${estrelasNivel(rep.nivel)} ${esc(rep.nomeNivel)}` : ""}</p>
    ${l.status !== "ativo" ? `<div class="aviso">A loja está fechada agora.</div>` : ""}
    ${l.desc ? `<p style="white-space:pre-line">${esc(l.desc)}</p>` : ""}
    <div class="cartao"><div class="linha"><span>Entrega</span><b>${l.entrega === "entregador" ? "Entregador da rede" : l.entrega === "combinar" ? "Retirar ou combinar" : "O vendedor entrega"}${l.entrega === "combinar" ? "" : ` · ${Number(l.taxa) > 0 ? esc(reaisTxt(l.taxa)) : "grátis"}`}</b></div></div>
    <h2>Cardápio</h2>${pratos.map(cartaoAnuncio).join("") || `<p class="mudo">Cardápio vazio.</p>`}
    ${sacola.itens.length && sacola.loja?.toLowerCase() === l.de.toLowerCase() ? `<button class="btn prim" data-ir="SACOLA">🛍️ Ver sacola · ${esc(reaisTxt(totalSacola(sacola)))}</button>` : ""}
    <button class="btn sec" data-ir="VITRINE">Voltar à vitrine</button>`);
  carregarMiniaturas($("#tela"));
  vit().fotos(l).then((urls) => { const b = $("#lj-fotos"); if (b && urls.length) b.innerHTML = `<img src="${urls[0]}" alt="Foto da loja">`; }).catch(() => {});
};

/** Loja de quem vende: o perfil publicado ou, se a pessoa não criou loja, uma montada pelos anúncios dela. */
function lojaDe(conta) {
  if (!conta) return null;
  const real = vit().loja(conta);
  if (real) return real;
  const itens = vit().anuncios({ cat: "comida", de: conta });
  if (!itens.length) return null;
  const propria = itens.filter((a) => a.entrega === "propria");
  return {
    t: "l", virtual: true, de: conta, chave: `${conta.toLowerCase()}:perfil`, nome: `Vendedor ${curto(conta)}`, desc: "", horario: "", bairro: itens[0].bairro,
    status: "ativo", fotos: [], entrega: propria.length ? "propria" : "combinar",
    taxa: propria.length ? Math.max(...propria.map((a) => Number(a.taxaEntrega || 0))).toFixed(2) : "0",
  };
}

/** Preço de um item com o sabor e os adicionais escolhidos. */
const precoItem = (i) => Number(i.preco || 0) + Number(i.extra || 0);
function lerEscolhas(a) {
  let extra = 0;
  let variacao = "";
  if (a.variacoes?.length) {
    const v = a.variacoes[Number($('input[name="an-var"]:checked')?.value)];
    if (!v) throw new Error(a.cat === "comida" ? "Escolha o sabor" : "Escolha uma opção");
    variacao = v.nome;
    extra += Number(v.extra || 0);
  }
  const adicionais = $$('input[name="an-add"]:checked').map((x) => a.opcoes[Number(x.value)]).filter(Boolean);
  extra += adicionais.reduce((t, o) => t + Number(o.extra || 0), 0);
  return { variacao, adicionais: adicionais.map((o) => o.nome), extra: extra.toFixed(2) };
}
const textoEscolhas = (i) => [i.variacao, ...(i.adicionais || [])].filter(Boolean).join(", ");

function camposEscolha(a) {
  return `${a.variacoes?.length ? `<fieldset class="escolhas"><legend>${a.cat === "comida" ? "Sabor" : "Opção"} <small class="mudo">(escolha uma)</small></legend>${a.variacoes.map((v, i) => `<label class="check"><input type="radio" name="an-var" value="${i}"> ${esc(v.nome)}${Number(v.extra) ? ` <small class="mudo">${Number(v.extra) > 0 ? "+" : "−"} ${esc(reaisTxt(Math.abs(Number(v.extra)).toFixed(2)))}</small>` : ""}</label>`).join("")}</fieldset>` : ""}
    ${a.opcoes?.length ? `<fieldset class="escolhas"><legend>Adicionais <small class="mudo">(opcional)</small></legend>${a.opcoes.map((o, i) => `<label class="check"><input type="checkbox" name="an-add" value="${i}"> ${esc(o.nome)}${Number(o.extra) > 0 ? ` <small class="mudo">+ ${esc(reaisTxt(o.extra))}</small>` : ""}</label>`).join("")}</fieldset>` : ""}`;
}

// ---------- Sacola (comida) ----------
const CHAVE_SACOLA = "xbrl.sacola";
function lerSacola() {
  try { const s = JSON.parse(localStorage.getItem(CHAVE_SACOLA) || "null"); if (s && Array.isArray(s.itens)) return s; } catch { /* vazia */ }
  return { loja: null, itens: [] };
}
const gravarSacola = (s) => { try { localStorage.setItem(CHAVE_SACOLA, JSON.stringify(s)); } catch { /* sem armazenamento */ } };
const totalSacola = (s) => s.itens.reduce((t, i) => t + precoItem(i) * i.qtd, 0).toFixed(2);

function adicionarNaSacola() {
  const a = vit().item(S.params.chave);
  const s = lerSacola();
  if (s.loja && s.loja.toLowerCase() !== a.de.toLowerCase() && s.itens.length) {
    if (!confirm("A sacola tem itens de outra loja. Esvaziar e começar nesta?")) return;
    s.itens = [];
  }
  const esc2 = lerEscolhas(a);
  s.loja = a.de;
  s.itens.push({ chave: a.chave, titulo: a.titulo, preco: a.preco, qtd: Math.max(1, Math.min(50, Number($("#an-qtd")?.value) || 1)), ...esc2, obs: ($("#an-obs")?.value || "").trim().slice(0, 40) });
  gravarSacola(s);
  toast("🛍️ Na sacola!");
  ir("LOJA", { conta: a.de });
}

TELAS.SACOLA = async () => {
  const s = lerSacola();
  await vit().sincronizar().catch(() => {});
  const l = s.loja ? lojaDe(s.loja) : null;
  if (!s.itens.length || !l) return tela(`<h1>🛍️ Sacola</h1><p class="mudo">Sua sacola está vazia.</p><button class="btn sec" data-ir="VITRINE">Ver a vitrine</button>`);
  const taxa = l.entrega === "combinar" ? 0 : Number(l.taxa || 0);
  const subtotal = Number(totalSacola(s));
  tela(`
    <h1>🛍️ Sacola · ${esc(l.nome)}</h1>
    <div class="cartao">${s.itens.map((i, n) => `<div class="linha"><span>${i.qtd}× ${esc(i.titulo)}${textoEscolhas(i) || i.opcao ? ` <small class="mudo">(${esc(textoEscolhas(i) || i.opcao)})</small>` : ""}${i.obs ? ` <small class="mudo">· ${esc(i.obs)}</small>` : ""}</span><span>${esc(reaisTxt((precoItem(i) * i.qtd).toFixed(2)))} <button class="mini-x" data-acao="sac-tirar" data-n="${n}" aria-label="Tirar">✕</button></span></div>`).join("")}
      <div class="linha"><span>Entrega (${l.entrega === "entregador" ? "entregador da rede" : l.entrega === "combinar" ? "retirar ou combinar" : "o vendedor entrega"})</span><span>${l.entrega === "combinar" ? "—" : taxa > 0 ? esc(reaisTxt(taxa.toFixed(2))) : "grátis"}</span></div>
      <div class="linha"><b>Total</b><b>${esc(reaisTxt((subtotal + taxa).toFixed(2)))}</b></div></div>
    ${l.entrega === "combinar" ? `<p class="mudo">📦 Retirada ou entrega combinada com o vendedor pela conversa cifrada, depois que ele aceitar o pedido.</p>` : botaoPonto("📍 Onde entregar", S.sacolaPonto, "sac-mapa")}
    ${l.entrega === "entregador" ? `<label for="sac-veiculo">Entregador de</label><select id="sac-veiculo"><option value="">Qualquer veículo</option><option value="🚲 bicicleta">Bicicleta</option><option value="🏍️ moto">Moto</option><option value="🚗 carro">Carro</option></select>` : ""}
    ${botaoSegurar("travar o pagamento e pedir", "sac-pedir")}
    <p class="mudo">🔒 O dinheiro fica travado no contrato. ${l.entrega === "entregador" ? "A loja recebe quando o entregador retira o pedido; o entregador recebe quando você der o código na porta." : "A loja recebe quando você der o código na porta, com a comida na mão."}</p>
    <button class="btn perigo" data-acao="sac-limpar">🗑️ Limpar sacola</button>`);
};

async function fazerPedidoComida() {
  const s = lerSacola();
  const l = lojaDe(s.loja);
  if (!l || l.status !== "ativo") throw new Error("A loja está fechada agora");
  const combinar = l.entrega === "combinar";
  const pt = S.sacolaPonto;
  if (!pt && !combinar) throw new Error("Marque no mapa onde entregar");
  const subtotal = lerValor(totalSacola(s));
  const taxa = combinar ? 0n : lerValor(l.taxa || "0");
  const comEntregador = l.entrega === "entregador";
  const kitLoja = E.parseEther("0.3");
  const kitEntregador = comEntregador ? E.parseEther("0.3") : 0n;
  const total = subtotal + taxa;
  await conferirSaldos(total, kitLoja + kitEntregador);
  const resumo = s.itens.map((i) => `${i.qtd}× ${i.titulo}${textoEscolhas(i) || i.opcao ? ` (${textoEscolhas(i) || i.opcao})` : ""}${i.obs ? ` [${i.obs}]` : ""}`).join(", ");
  const destino = pt ? textoDoPonto(pt) : "a combinar pela conversa";
  if (!comEntregador) {
    const { p, codigo } = prepararTrabalho({ modalidade: 1, trabalhador: E.getAddress(l.de), valor: total, horas: 6, descricao: `🍔 Pedido ${l.nome}: ${resumo}`, privado: `🛍️ ${resumo}\n🏁 ${combinar ? "Retirada/entrega: a combinar" : `Entregar em: ${destino}`}` });
    await executar("Fazer pedido", [passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, total, "Autorizar BRLS"), { rotulo: "Travar pagamento", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(p, { ...o, value: kitLoja }) }]);
    gravarSacola({ loja: null, itens: [] });
    modal(`<h2>✅ Pedido feito</h2><p>${combinar ? "O vendedor vê o pedido e aceita. Depois, combinem a retirada ou a entrega pela 💬 conversa do pedido." : "A loja vê o pedido e aceita. Depois, envie o endereço na tela do pedido (vai cifrado)."}</p><p><b>🔑 Código de entrega</b> — dê ao entregador <b>só com a comida na mão</b>:</p>${qrSvg(codigo)}<div class="codigo">${esc(codigo)}</div><button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
    return ir("TRABALHOS", { aba: "meus" });
  }
  // Dois trabalhos: A (produto → loja, código de retirada C1) e B (entrega → entregador, código de entrega C2)
  const A = prepararTrabalho({ modalidade: 1, trabalhador: E.getAddress(l.de), valor: subtotal, horas: 6, descricao: `🍔 Pedido ${l.nome}: ${resumo} · entregador da rede`, privado: `🛍️ ${resumo}\n🛵 Um entregador da rede vai retirar e mostrar o código de retirada.` });
  const veiculo = ($("#sac-veiculo")?.value || "").trim();
  const lojaPt = l.lat != null ? `${l.endereco || l.bairro}\n📍 ${fmtCoord(l.lat, l.lon)}` : l.bairro;
  const B = prepararTrabalho({
    modalidade: 1, valor: taxa, horas: 6,
    descricao: `🛵 Entrega: ${l.bairro} → ${pt.bairro || "a combinar"}${veiculo ? ` · ${veiculo}` : ""} · ${l.nome}`,
    privado: `🏪 Retirada: ${l.nome} — ${lojaPt}\n🔑 Código de retirada (dê à loja ao pegar o pedido): ${A.codigo}\n🛍️ ${resumo}\n🏁 Entrega: ${destino}`,
  });
  const valorB = B.p.valor;
  await conferirSaldos(subtotal + valorB, kitLoja + kitEntregador);
  await executar("Fazer pedido", [
    passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, subtotal + valorB, "Autorizar BRLS"),
    { rotulo: "Travar o pagamento da loja", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(A.p, { ...o, value: kitLoja }) },
    { rotulo: "Chamar entregador", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(B.p, { ...o, value: kitEntregador }) },
  ]);
  gravarSacola({ loja: null, itens: [] });
  modal(`<h2>✅ Pedido feito</h2><p>A loja aceita o pedido e um entregador pega a entrega. Quando o entregador aceitar, toque em <b>"Enviar endereço"</b> na tela da entrega: ele recebe (cifrado) o endereço da loja, o código de retirada e o seu endereço.</p>
    <p><b>🔑 Código de entrega</b> — dê ao entregador <b>só com a comida na mão</b>:</p>${qrSvg(B.codigo)}<div class="codigo">${esc(B.codigo)}</div><button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
  ir("TRABALHOS", { aba: "meus" });
}

// ---------- Pix ⇄ BRLS ----------
const PREFIXO_P2P = "brlsp2p:";
/** Comprador sem BRLS (e sem POL) pede ao vendedor: mensagem assinada pelo avisador. */
async function pedirCompraPix() {
  const a = vit().item(S.params.chave);
  const reais = lerValor($("#pix-reais").value);
  const min = lerValor(a.pix.min);
  const max = lerValor(a.pix.max);
  if (reais < min || reais > max) throw new Error(`O valor precisa ficar entre R$ ${precoBr(a.pix.min)} e R$ ${precoBr(a.pix.max)}`);
  const pedido = { v: 1, anuncio: a.chave, comprador: S.endereco, reais: E.formatUnits(reais, 18), rede: S.chainId, em: agora() };
  const msg = JSON.stringify(pedido);
  const sig = await S.carteira.signMessage(msg);
  const texto = PREFIXO_P2P + btoa(unescape(encodeURIComponent(JSON.stringify({ msg, sig }))));
  modal(`<div class="giro"></div><h2>Pedindo…</h2><p class="mudo">Mandando o pedido para o app do vendedor.</p>`);
  const ok = await CO.postarTopico(CO.topicoDe(S.chainId, a.de, "pix"), texto).catch(() => false);
  S.pedidoPix = texto;
  modal(`<h2>${ok ? "📨 Pedido enviado" : "⚠️ O avisador não respondeu"}</h2>
    <p>${ok ? "O vendedor recebe o aviso no app. Quando ele aceitar, os BRLS ficam travados para você e aparece um trabalho <b>💱 Pix → BRLS</b> em Trabalhos." : "Mande o pedido para o vendedor por outro caminho (WhatsApp, por exemplo): ele abre em Vitrine → Meus anúncios → Ler pedido."}</p>
    <p class="mudo">Ainda <b>não</b> faça o Pix: espere os BRLS estarem travados para você.</p>
    <button class="btn sec" data-acao="pix-copiar-pedido">📋 Copiar o pedido</button>
    <button class="btn prim" data-acao="fechar-modal">Ok</button>`);
}

/** Vendedor: lê os pedidos de compra que chegaram e mostra para aceitar ou recusar. */
async function mostrarPedidosPix(box) {
  if (!box) return;
  const meus = vit().anuncios({ cat: "pix", de: S.endereco, todos: true });
  if (!meus.length) return;
  const textos = await CO.lerTopico(CO.topicoDe(S.chainId, S.endereco, "pix"), "6h", PREFIXO_P2P).catch(() => []);
  const itens = [];
  for (const t of [...textos, ...(S.pedidosPixLocais || [])]) {
    if (CO.jaResolvido(t)) continue;
    const p = lerPedidoPix(t);
    if (p) itens.push(p);
  }
  S.pedidosPix = new Map(itens.map((p) => [p.k, p]));
  const html = itens.map((p) => `<div class="cartao correio destaque"><h2 style="margin-top:0">💱 Pedido de compra: R$ ${precoBr(p.pedido.reais)}</h2>
      <div class="linha"><span>Comprador</span><span>${esc(curto(p.pedido.comprador))}</span></div>
      <div class="linha"><span>Você trava</span><b>${precoBr(p.brls)} BRLS</b></div>
      <p class="mudo">Aceitando, os BRLS ficam travados no contrato para ele. Ele faz o Pix na sua chave e avisa. <b>Só libere depois de ver o dinheiro na sua conta.</b></p>
      ${botaoSegurar("aceitar e travar os BRLS", `pixok:${p.k}`)}<button class="btn sec" data-acao="pix-recusar" data-k="${esc(p.k)}">Recusar</button></div>`).join("");
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
    ligarSegurar(box);
    if (html) avisarNovoPedido("💱 Pedido de compra de BRLS!");
  }
}

function lerPedidoPix(texto) {
  try {
    const { msg, sig } = JSON.parse(decodeURIComponent(escape(atob(texto.slice(PREFIXO_P2P.length)))));
    const pedido = JSON.parse(msg);
    if (E.verifyMessage(msg, sig).toLowerCase() !== String(pedido.comprador).toLowerCase()) return null;
    if (Number(pedido.rede) !== Number(S.chainId) || agora() - Number(pedido.em) > 6 * 3600) return null;
    const a = vit().item(pedido.anuncio);
    if (!a || a.de.toLowerCase() !== S.endereco.toLowerCase() || a.cat !== "pix" || a.pix.lado !== "vendo") return null;
    const reais = E.parseUnits(String(pedido.reais), 18);
    if (reais < E.parseUnits(a.pix.min, 18) || reais > E.parseUnits(a.pix.max, 18)) return null;
    const brls = (Number(pedido.reais) * (1 - a.pix.premio / 100)).toFixed(2);
    return { texto, pedido, a, brls, k: E.id(texto).slice(2, 14) };
  } catch {
    return null;
  }
}

async function aceitarPedidoPix(k) {
  const p = S.pedidosPix?.get(k);
  if (!p) throw new Error("Esse pedido não está mais aqui. Atualize a tela.");
  const valor = lerValor(p.brls);
  const kit = E.parseEther("0.3");
  await conferirSaldos(valor, kit);
  const desc = `💱 Pix → BRLS: pague R$ ${precoBr(p.pedido.reais)} na chave ${p.a.pix.chave}${p.a.pix.banco ? ` (${p.a.pix.banco})` : ""} · ref ${refAnuncio(p.a)}`;
  const { p: prm } = prepararTrabalho({ modalidade: 2, trabalhador: E.getAddress(p.pedido.comprador), valor, horas: 24, descricao: desc, comCodigo: false });
  await executar("Aceitar pedido Pix", [passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, valor, "Autorizar BRLS"), { rotulo: "Travar BRLS para o comprador", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(prm, { ...o, value: kit }) }]);
  CO.resolver(p.texto);
  render();
}

/** Quem tem BRLS e quer Pix: trava os BRLS para quem compra BRLS (anúncio "compro"). */
async function venderBrlsPorPix() {
  const a = vit().item(S.params.chave);
  const reais = lerValor($("#pix-reais").value);
  if (reais < lerValor(a.pix.min) || reais > lerValor(a.pix.max)) throw new Error(`O valor precisa ficar entre R$ ${precoBr(a.pix.min)} e R$ ${precoBr(a.pix.max)}`);
  const chave = ($("#pix-minha-chave").value || "").trim();
  if (chave.length < 5) throw new Error("Informe a sua chave Pix");
  const brls = (Number(E.formatUnits(reais, 18)) * (1 + a.pix.premio / 100)).toFixed(2);
  const valor = lerValor(brls);
  await conferirSaldos(valor);
  const reaisTxt2 = precoBr(E.formatUnits(reais, 18));
  const { p, codigo } = prepararTrabalho({ modalidade: 2, trabalhador: E.getAddress(a.de), valor, horas: 24, descricao: `💱 BRLS → Pix: me pague R$ ${reaisTxt2} · ref ${refAnuncio(a)}`, comCodigo: true, privado: `💱 Pague R$ ${reaisTxt2} no Pix:\n🔑 Chave: ${chave}` });
  await executar("Vender BRLS por Pix", [passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, valor, "Autorizar BRLS"), { rotulo: "Travar BRLS", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(p, o) }]);
  modal(`<h2>✅ BRLS travados</h2><p>Quando ${esc(curto(a.de))} aceitar, toque em <b>"Enviar endereço"</b> na tela do trabalho: sua chave Pix vai cifrada só para ele.</p>
    <p>Depois que <b>o dinheiro aparecer na sua conta</b>, toque em "Pagar" (liberar). Não libere por print.</p>
    <p class="mudo">Código de liberação (só se quiser entregar em mãos): ${esc(codigo)}</p><button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
  ir("TRABALHOS", { aba: "meus" });
}

// ---------- Corrida no modelo da 99 (trabalho presencial; ver corrida.js) ----------
const minhasCorridas = (meus) => meus.filter((t) => lerCorrida(t.descricao) && !t.encerrado);
function cartaoCorrida(t, souPassageiro) {
  const c = lerCorrida(t.descricao);
  const extra = [c.nomeCategorias, c.pessoas > 1 ? `${c.pessoas} pessoas` : "", c.km != null ? `${String(c.km).replace(".", ",")} km` : "", c.expresso ? "⚡" : "", c.agendada ? `⏰ ${horaCurta(c.agendada)}` : ""].filter(Boolean).join(" · ");
  return `<button class="item corrida" data-trabalho="${esc(t.id)}"><span class="ic">${c.icone}</span><span class="meio"><b>${esc(c.de)} → ${esc(c.para)}</b><span class="mudo">${souPassageiro ? "Você pediu" : "Você dirige"} · ${esc(extra)}</span></span><b>${fmt(t.valor)}</b></button>`;
}
const horaCurta = (ts) => new Date(ts * 1000).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const brNum = (v, c = 2) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });
const lerFavoritos = () => { try { return JSON.parse(localStorage.getItem("xbrl.favoritos") || "[]"); } catch { return []; } };
const gravarFavoritos = (l) => { try { localStorage.setItem("xbrl.favoritos", JSON.stringify(l.slice(-20))); } catch { /* ok */ } };

/** Texto curto do perfil do motorista (modelo, cor, placa). */
function linhaMotorista(conta) {
  const m = vit()?.motorista(conta);
  if (!m) return `<span class="mudo">Sem perfil de veículo publicado</span>`;
  return `<b>${esc(m.apelido || curto(conta))}</b> · ${esc(VEICULOS[m.veiculo]?.icone || "🚗")} ${esc(m.modelo)} ${esc(m.cor)} · placa <b class="placa">${esc(m.placa)}</b>`;
}

TELAS.CORRIDA = async () => {
  if (!S.escrow) return tela(`<h1>Corrida</h1><div class="aviso">Protocolo ainda não implantado nesta rede.</div>`);
  S.corrida ||= { categorias: ["pop"], pessoas: 1, validade: 2 };
  const r = S.corrida;
  const favs = lerFavoritos();
  tela(`
    <h1>🚗 Corrida</h1>
    <div id="corridas-ativas"><div class="cartao"><div class="giro"></div><p class="mudo">Lendo suas corridas…</p></div></div>
    <div class="cartao">
      <h2 style="margin-top:0">Para onde vamos?</h2>
      ${botaoPonto("🟢 Embarque", r.dePonto, "cor-mapa-de")}
      <label for="cor-de">Bairro do embarque (é o que os motoristas veem)</label><input id="cor-de" maxlength="40" placeholder="Ex.: Savassi, Belo Horizonte" value="${esc(r.de || "")}">
      ${botaoPonto("🏁 Destino", r.paraPonto, "cor-mapa-para")}
      <label for="cor-para">Bairro do destino (é o que os motoristas veem)</label><input id="cor-para" maxlength="40" placeholder="Ex.: Centro, Belo Horizonte" value="${esc(r.para || "")}">
      <div id="cor-rota" class="mudo" aria-live="polite"></div>
      <div id="cor-cats" class="cats-corrida" role="group" aria-label="Categorias"></div>
      <p class="mudo">Escolha uma ou mais categorias: quem aceitar primeiro busca você.</p>
      <label class="check"><input type="checkbox" id="cor-expresso" ${r.expresso ? "checked" : ""}> ⚡ Expresso: paga um pouco mais e aparece primeiro para os motoristas</label>
      <label for="cor-pessoas">Quantas pessoas</label><select id="cor-pessoas">${[1, 2, 3, 4].map((n) => `<option ${n === r.pessoas ? "selected" : ""}>${n}</option>`).join("")}</select>
      <label for="cor-obs">Observação (opcional, pública)</label><input id="cor-obs" maxlength="60" placeholder="Ex.: mala grande, pet pequeno" value="${esc(r.obs || "")}">
      <label for="cor-valor">Quanto você paga (BRLS)</label><input id="cor-valor" class="grande" inputmode="decimal" placeholder="0,00" value="${esc(r.valor || "")}">
      <p class="mudo" id="cor-sugestao">Marque embarque e destino para ver o preço sugerido.</p>
      <details><summary>Mais opções</summary>
        <label for="cor-agendar">⏰ Agendar (deixe vazio para agora)</label><input id="cor-agendar" type="datetime-local" value="${esc(r.agendar || "")}">
        <label for="cor-validade">O pedido fica aberto por</label><select id="cor-validade">${VALIDADES_HORAS.map((h) => `<option value="${h}" ${h === r.validade ? "selected" : ""}>${h} hora${h > 1 ? "s" : ""}</option>`).join("")}</select>
        ${favs.length ? `<label for="cor-fav">⭐ Chamar direto um motorista favorito</label><select id="cor-fav"><option value="">Não: aberto para todos</option>${favs.map((f) => `<option value="${esc(f.conta)}" ${f.conta === r.favorito ? "selected" : ""}>${esc(f.nome || curto(f.conta))}</option>`).join("")}</select>` : ""}
        <label for="cor-kit">⛽ Gás para o motorista (POL)</label><input id="cor-kit" inputmode="decimal" value="${esc(r.kit ?? "0,3")}">
        <p class="mudo">Chega ao motorista quando você aprovar ele, para ele nunca travar por falta de taxa. Se ninguém fizer a corrida, volta para você.</p>
        <button class="btn sec" data-ir="TARIFAS">⚙️ Ajustar as tarifas sugeridas</button>
      </details>
      <div class="ok">🔒 Os pontos exatos <b>não</b> vão para a blockchain: os motoristas veem só o bairro e um ponto aproximado (~1 km). O endereço exato vai cifrado ao motorista que você aprovar.</div>
      ${botaoSegurar("travar o pagamento e pedir", "pedir-corrida")}
      <p class="mudo">O valor fica travado no contrato até o fim da corrida. Se ninguém aceitar no prazo, você pega de volta. Taxa de 0,1% só quando o motorista recebe.</p>
    </div>
    <div class="grade duas"><button class="atalho" data-ir="MOTORISTA"><span>🟢</span>Sou motorista</button><button class="atalho" data-ir="GANHOS"><span>📊</span>Meus ganhos</button></div>`);
  for (const [id, k] of [["cor-de", "de"], ["cor-para", "para"], ["cor-obs", "obs"], ["cor-kit", "kit"], ["cor-agendar", "agendar"]]) {
    $(`#${id}`)?.addEventListener("input", (ev) => (r[k] = ev.target.value));
  }
  $("#cor-valor").addEventListener("input", (ev) => { r.valor = ev.target.value; r.valorEditado = true; });
  ligarMaximo("#cor-valor", saldoBrls);
  $("#cor-pessoas").addEventListener("change", (ev) => (r.pessoas = Number(ev.target.value)));
  $("#cor-validade").addEventListener("change", (ev) => (r.validade = Number(ev.target.value)));
  $("#cor-fav")?.addEventListener("change", (ev) => (r.favorito = ev.target.value));
  $("#cor-expresso").addEventListener("change", (ev) => { r.expresso = ev.target.checked; desenharPrecos(); });
  desenharPrecos();
  if (r.dePonto && r.paraPonto && !r.rota) calcularRota();
  vit()?.sincronizar().catch(() => {});
  atualizarCorridasAtivas();
  vigiar("CORRIDA", atualizarCorridasAtivas, 12000);
};

async function calcularRota() {
  const r = S.corrida;
  if (!r.dePonto || !r.paraPonto) return;
  const pedido = `${r.dePonto.lat},${r.dePonto.lon};${r.paraPonto.lat},${r.paraPonto.lon}`;
  r.rotaPedido = pedido;
  const box = $("#cor-rota");
  if (box) box.textContent = "Calculando o caminho pela rua…";
  const rota = await rotaPelaRua(r.dePonto, r.paraPonto);
  if (r.rotaPedido !== pedido) return;
  r.rota = rota;
  desenharPrecos();
}

function desenharPrecos() {
  const r = S.corrida;
  const box = $("#cor-cats");
  if (!box) return;
  const t = tarifas();
  const rota = r.rota;
  const rb = $("#cor-rota");
  if (rb) rb.innerHTML = rota ? `🛣️ <b>${brNum(rota.km, 1)} km</b> ${rota.fonte === "rua" ? "pela rua" : "(estimativa: o serviço de rotas não respondeu)"} · cerca de <b>${Math.max(1, Math.round(rota.min))} min</b>` : "";
  box.innerHTML = ["moto", "pop", "plus"].map((k) => {
    const v = VEICULOS[k];
    const preco = rota ? precoSugerido(k, rota.km, rota.min, r.expresso, t) : null;
    const on = r.categorias.includes(k);
    return `<button data-acao="cor-cat-${k}" aria-pressed="${on}"><span class="ic">${v.icone}</span><b>${v.nome}</b><span>${preco ? `R$ ${brNum(preco)}` : "—"}</span><small class="mudo">${k === "moto" ? "1 pessoa" : k === "plus" ? "mais conforto" : "até 4 pessoas"}</small></button>`;
  }).join("");
  ligarSegurar(box);
  const sug = $("#cor-sugestao");
  if (!rota || !r.categorias.length) { if (sug && !r.categorias.length) sug.textContent = "Escolha pelo menos uma categoria."; return; }
  const sugerido = Math.max(...r.categorias.map((k) => Number(precoSugerido(k, rota.km, rota.min, r.expresso, t)))).toFixed(2);
  if (sug) sug.textContent = `Sugestão: R$ ${brNum(sugerido)}${r.categorias.length > 1 ? " (o preço da categoria mais cara escolhida: vale para quem aceitar)" : ""}. Você pode mudar: preço fechado, não muda no caminho.`;
  const campo = $("#cor-valor");
  if (campo && !r.valorEditado) { campo.value = brNum(sugerido); r.valor = campo.value; }
}

async function atualizarCorridasAtivas() {
  const box = $("#corridas-ativas");
  if (!box) return;
  await S.escrow.sincronizar();
  const { meus } = await S.escrow.listar(S.endereco);
  if (!$("#corridas-ativas")) return;
  const eu = S.endereco.toLowerCase();
  const det = (await Promise.all(minhasCorridas(meus).slice(0, 5).map((r) => S.escrow.detalhe(r.id).then((t) => ({ r, t })).catch(() => null)))).filter((x) => x && x.t.estado < 4);
  const itens = det.map(({ r, t }) => {
    const souP = t.cliente.toLowerCase() === eu;
    return `<div class="cartao corrida-ativa">${cartaoCorrida({ ...r, valor: t.valor }, souP)}<p class="passo-corrida">${esc(passoCorrida(t, souP).texto)}</p></div>`;
  }).join("");
  const html = itens ? `<h2>Em andamento</h2><div id="cor-correio"></div><div id="cor-contra"></div>${itens}` : "";
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
  // Motorista sem POL querendo a corrida, ou a outra parte pedindo para você enviar por ela
  await mostrarCorreio($("#cor-correio"), det.map((x) => x.t), null);
  if (det.length) telaAcesa(true);
  // Contrapropostas de motoristas para os seus pedidos abertos
  await mostrarContrapropostas($("#cor-contra"), det.filter(({ t }) => t.cliente.toLowerCase() === eu && t.estado === 0 && !t.pendenteAprovacao).map((x) => x.t));
}

/** Repete `fn` a cada `ms` enquanto a tela `nome` estiver aberta e o app visível (sem redesenhar a tela toda). */
function vigiar(nome, fn, ms) {
  clearInterval(S.vigia);
  S.vigiaFn = async () => { if (S.tela === nome) await fn(); };
  S.vigia = setInterval(() => {
    if (S.tela !== nome) return clearInterval(S.vigia);
    if (document.hidden || $("#modal")?.hidden === false) return;
    fn().catch(() => {});
  }, ms);
}

// ---------- Motorista online ----------
const CHAVE_FILTROS = "xbrl.motorista.filtros";
const lerFiltros = () => { try { return { veiculo: "todos", raio: 10, minKm: 0, ...JSON.parse(localStorage.getItem(CHAVE_FILTROS) || "{}") }; } catch { return { veiculo: "todos", raio: 10, minKm: 0 }; } };

TELAS.MOTORISTA = async () => {
  if (!S.escrow) return tela(`<h1>Motorista</h1><div class="aviso">Protocolo ainda não implantado nesta rede.</div>`);
  S.motorista ||= { online: (() => { try { return localStorage.getItem("xbrl.motorista.online") === "1"; } catch { return false; } })(), vistos: null, aqui: null };
  const m = S.motorista;
  await vit()?.sincronizar().catch(() => {});
  const perfil = vit()?.motorista(S.endereco);
  const f = lerFiltros();
  if (perfil && f.veiculo === "todos") f.veiculo = perfil.veiculo;
  const rep = await S.escrow.reputacao(S.endereco);
  tela(`
    <h1>🚗 Motorista</h1>
    ${perfil ? `<div class="cartao"><div class="linha"><span>${linhaMotorista(S.endereco)}</span><button class="btn sec mini" data-ir="MEU_CARRO">Editar</button></div>
      <div class="linha"><span>Sua reputação</span><span>${estrelasNivel(rep.nivel)} <b>${esc(rep.nomeNivel)}</b></span></div></div>`
      : `<div class="aviso">🚘 <b>Cadastre seu veículo</b> (modelo, cor e placa). Os passageiros conferem antes de aprovar e antes de entrar.</div><button class="btn prim" data-ir="MEU_CARRO">🚘 Cadastrar meu veículo</button>`}
    <button class="btn ${m.online ? "perigo" : "prim"}" data-acao="mot-online">${m.online ? "🔴 Ficar offline" : "🟢 Ficar online"}</button>
    <details class="cartao"><summary><b>Filtros</b> <small class="mudo">${esc(f.veiculo === "todos" ? "todas as categorias" : VEICULOS[f.veiculo].nome)} · até ${f.raio ? f.raio + " km" : "qualquer distância"} · mínimo R$ ${brNum(f.minKm)}/km</small></summary>
      <label for="mf-veiculo">Categoria</label><select id="mf-veiculo"><option value="todos">Todas</option>${["moto", "pop", "plus"].map((k) => `<option value="${k}" ${k === f.veiculo ? "selected" : ""}>${VEICULOS[k].icone} ${VEICULOS[k].nome}</option>`).join("")}</select>
      <label for="mf-raio">Distância máxima até o embarque</label><select id="mf-raio">${[2, 5, 10, 20, 0].map((k) => `<option value="${k}" ${k === Number(f.raio) ? "selected" : ""}>${k ? k + " km" : "Qualquer"}</option>`).join("")}</select>
      <label for="mf-minkm">Ganho mínimo por km (R$)</label><input id="mf-minkm" inputmode="decimal" value="${esc(brNum(f.minKm))}">
      <button class="btn sec" data-acao="mot-filtros">Salvar filtros</button></details>
    <p class="mudo" id="mot-status">${m.online ? "Online: procurando pedidos…" : "Você está offline. Fique online para receber pedidos (com som e vibração)."}</p>
    <div id="mot-lista"></div>
    <div id="mot-minhas"></div>
    <div class="aviso">O passageiro paga o que está escrito, preço fechado, e o dinheiro já está travado no contrato. Você recebe no destino com o código do passageiro. Achou o valor baixo? Abra o pedido e faça uma contraproposta.</div>
    <p class="mudo">⛽ Sem POL? Pode aceitar assim mesmo: o pedido vai direto para o app do passageiro, ele aceita você e paga a taxa. O gás da corrida chega para você na hora.</p>
    <button class="btn sec" data-ir="GANHOS">📊 Meus ganhos</button>`);
  if (m.online) {
    telaAcesa(true);
    atualizarPedidos();
    vigiar("MOTORISTA", atualizarPedidos, 10000);
  } else atualizarPedidos(true);
};

function minhaPosicao() {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }), () => ok(null), { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  });
}

async function atualizarPedidos(soMinhas = false) {
  if (!$("#mot-lista")) return;
  await S.escrow.sincronizar();
  const { meus, vagas } = await S.escrow.listar(S.endereco);
  const minhas = minhasCorridas(meus).filter((t) => t.cliente.toLowerCase() !== S.endereco.toLowerCase());
  const mb = $("#mot-minhas");
  if (mb) mb.innerHTML = minhas.length ? `<h2>Suas corridas</h2>${minhas.map((t) => cartaoCorrida(t, false)).join("")}` : "";
  const box = $("#mot-lista");
  if (!box || soMinhas || !S.motorista.online) { if (box) box.innerHTML = ""; return; }
  const m = S.motorista;
  if (!m.aqui || Date.now() - (m.aquiEm || 0) > 60000) { m.aqui = (await minhaPosicao()) || m.aqui; m.aquiEm = Date.now(); }
  const f = lerFiltros();
  const perfil = vit()?.motorista(S.endereco);
  const veiculo = f.veiculo === "todos" && perfil ? perfil.veiculo : f.veiculo;
  const agoraS = agora();
  const pedidos = vagas.map((t) => ({ t, c: lerCorrida(t.descricao) })).filter(({ c }) => c && (veiculo === "todos" || c.categorias.includes(veiculo) || (veiculo === "plus" && c.categorias.includes("pop"))))
    .map((x) => ({ ...x, ate: m.aqui && x.c.aprox ? distanciaKm(m.aqui, x.c.aprox) * 1.35 : null, porKm: x.c.km ? Number(E.formatUnits(x.t.valor, 18)) / x.c.km : null }))
    .filter((x) => !f.raio || x.ate == null || x.ate <= Number(f.raio))
    .filter((x) => !Number(f.minKm) || x.porKm == null || x.porKm >= Number(f.minKm))
    .filter((x) => !x.c.agendada || x.c.agendada - agoraS < 6 * 3600)
    .sort((a, b) => (b.c.expresso - a.c.expresso) || ((a.ate ?? 99) - (b.ate ?? 99)));
  const ids = new Set(pedidos.map((x) => String(x.t.id)));
  const novos = m.vistos ? [...ids].filter((id) => !m.vistos.has(id)) : [];
  m.vistos = ids;
  if (novos.length) avisarNovoPedido();
  const html = pedidos.map(({ t, c, ate, porKm }) => `<button class="item corrida ${c.expresso ? "expresso" : ""}" data-trabalho="${esc(t.id)}"><span class="ic">${c.icone}</span><span class="meio"><b>${esc(c.de)} → ${esc(c.para)}</b><span class="mudo">${[ate != null ? `🧭 ~${brNum(ate, 1)} km até o embarque` : "", c.km != null ? `${brNum(c.km, 1)} km de viagem` : "", porKm ? `R$ ${brNum(porKm)}/km` : "", c.pessoas > 1 ? `${c.pessoas} pessoas` : "", c.expresso ? "⚡ Expresso" : "", c.agendada ? `⏰ ${horaCurta(c.agendada)}` : "", c.obs].filter(Boolean).map(esc).join(" · ")}</span></span><b>${fmt(t.valor)}</b></button>`).join("")
    || `<div class="cartao"><p class="mudo">Nenhum pedido no seu filtro agora. Assim que alguém pedir, aparece aqui com som.</p></div>`;
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
  const st = $("#mot-status");
  if (st) st.textContent = `Online · atualizado às ${new Date().toLocaleTimeString("pt-BR")} · ${pedidos.length} pedido${pedidos.length === 1 ? "" : "s"}${m.aqui ? "" : " · sem sua localização, a distância até o embarque não aparece"}.`;
}

function avisarNovoPedido(texto = "🚗 Pedido de corrida novo!") {
  try { navigator.vibrate?.([120, 60, 120]); } catch { /* sem vibração */ }
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
    o.connect(g).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.35);
  } catch { /* sem som */ }
  toast(texto);
}

// ---------- Pedir ----------
async function pedirCorrida() {
  const r = S.corrida;
  const ler = (id) => ($(`#${id}`)?.value || "").trim();
  const de = ler("cor-de"), para = ler("cor-para");
  if (!r.dePonto || !r.paraPonto) throw new Error("Marque no mapa o ponto exato do embarque e do destino: é o que o motorista usa no GPS (só o motorista aprovado vê)");
  if (de.length < 3 || para.length < 3) throw new Error("Informe o bairro de embarque e o de destino");
  if (!r.categorias.length) throw new Error("Escolha pelo menos uma categoria");
  if (!r.rota) r.rota = await rotaPelaRua(r.dePonto, r.paraPonto);
  const valor = lerValor(ler("cor-valor"), 18);
  if (valor === 0n) throw new Error("Informe quanto você paga pela corrida");
  const [saldoX, saldoPol] = await Promise.all([c("xBRL").balanceOf(S.endereco), S.provider.getBalance(S.endereco)]);
  if (saldoX < valor) throw new Error(`Você tem ${fmt(saldoX)} BRLS e a corrida é ${fmt(valor)}. Compre BRLS com Pix na Vitrine (💱) e tente de novo.`);
  const kit = S.imp.Encaminhador ? lerValor(ler("cor-kit") || "0", 18) : 0n;
  if (kit > E.parseEther("5")) throw new Error("O gás para o motorista pode ser no máximo 5 POL");
  if (saldoPol < kit + E.parseEther("0.05")) throw new Error(`Você tem ${fmt(saldoPol, 18, 3)} POL: não dá para deixar ${fmt(kit, 18, 3)} de gás e ainda pagar a taxa. Diminua o gás em "Mais opções".`);
  let agendada = null;
  if (r.agendar) {
    agendada = Math.floor(new Date(r.agendar).getTime() / 1000);
    if (!Number.isFinite(agendada) || agendada < agora() + 10 * 60) throw new Error("Agende para pelo menos 10 minutos a partir de agora");
    if (agendada > agora() + 30 * 86400) throw new Error("Agende para no máximo 30 dias");
  }
  const horas = VALIDADES_HORAS.includes(Number(r.validade)) ? Number(r.validade) : 2;
  const favorito = r.favorito && E.isAddress(r.favorito) ? E.getAddress(r.favorito) : E.ZeroAddress;
  const descricao = descricaoCorrida({ categorias: r.categorias, de, para, pessoas: r.pessoas, obs: ler("cor-obs"), aprox: { lat: r.dePonto.lat, lon: r.dePonto.lon }, km: r.rota.km, min: r.rota.min, expresso: r.expresso, agendada });
  const { p, codigo } = novaCorrida({ trabalhador: favorito, valor, prazo: (agendada || agora()) + horas * 3600 + Math.max(3600, Math.round(r.rota.min * 3 * 60)), descricao, privado: enderecoCorrida(r.dePonto, r.paraPonto) });
  await executar("Pedir corrida", [passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, valor, "Autorizar BRLS"), { rotulo: "Travar pagamento", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(p, { ...o, value: kit }) }]);
  S.corrida = { categorias: r.categorias, pessoas: 1, validade: r.validade };
  pedirAvisos();
  corridaViva().then(() => atualizarPlantao()).catch(() => {});
  modal(`<h2>✅ Corrida pedida</h2>
    <p>O pagamento está travado. ${favorito !== E.ZeroAddress ? "Seu motorista favorito recebe o pedido." : "Deixe o app aberto: quando um motorista quiser, você vê o carro, a placa e a reputação e aprova."}</p>
    <p><b>🔑 Código do destino</b> — mostre ao motorista <b>só quando chegar</b>. Com ele, o motorista recebe:</p>${qrSvg(codigo)}<div class="codigo">${esc(codigo)}</div>
    <p class="mudo">O código também fica salvo na tela da corrida.</p><button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
  ir("CORRIDA");
}

/** Monta o trabalho de uma corrida (códigos guardados no aparelho). */
function novaCorrida({ trabalhador, valor, prazo, descricao, privado }) {
  const palavras = valor >= E.parseEther("1000") ? 6 : 5;
  const codigo = gerarCodigoEntrega(palavras); // mostrado ao motorista no destino
  const codigoHash = hashCodigo(S.imp.EscrowTrabalho, S.endereco, codigo);
  guardarCodigo(codigoHash, codigo);
  const chegada = gerarCodigoEntrega(palavras); // exigido pelo contrato; na corrida o passageiro confirma o embarque com um toque
  const chegadaHash = hashChegada(S.imp.EscrowTrabalho, S.endereco, chegada);
  guardarCodigo(chegadaHash, chegada);
  try { localStorage.setItem(`xbrl.endereco.${chegadaHash}`, privado); } catch { /* sem armazenamento */ }
  const p = { modalidade: 0, trabalhador, valor, prazo: BigInt(prazo), etapas: 1, codigoHash, chegadaHash, arbitroCliente: E.ZeroAddress, desempateCriador: false, caucao: 0n, devolucaoHash: E.ZeroHash, descricao };
  return { p, codigo, chegadaHash };
}

// ---------- Contraproposta (motorista → passageiro, assinada, pelo avisador) ----------
async function enviarContraproposta() {
  const t = S.params.t;
  const valor = lerValor($("#tr-contra").value);
  if (valor <= t.valor) throw new Error("A contraproposta precisa ser maior que o valor oferecido");
  const msg = JSON.stringify({ v: 1, t: "contra", id: String(t.id), valor: E.formatUnits(valor, 18), motorista: S.endereco, rede: S.chainId, em: agora() });
  const sig = await S.carteira.signMessage(msg);
  const ok = await CO.postarTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), PREFIXO_CONTRA + btoa(unescape(encodeURIComponent(JSON.stringify({ msg, sig })))));
  toast(ok ? "Contraproposta enviada ao passageiro" : "O avisador não respondeu. Tente de novo.");
}

function lerContra(texto, t) {
  try {
    const { msg, sig } = JSON.parse(decodeURIComponent(escape(atob(texto.slice(PREFIXO_CONTRA.length)))));
    const o = JSON.parse(msg);
    if (o.t !== "contra" || String(o.id) !== String(t.id) || Number(o.rede) !== Number(S.chainId) || agora() - Number(o.em) > 1800) return null;
    if (E.verifyMessage(msg, sig).toLowerCase() !== String(o.motorista).toLowerCase()) return null;
    const valor = E.parseUnits(String(o.valor), 18);
    if (valor <= t.valor || valor > t.valor * 3n) return null;
    return { texto, motorista: E.getAddress(o.motorista), valor, k: E.id(texto).slice(2, 14), t };
  } catch {
    return null;
  }
}

async function mostrarContrapropostas(box, abertas) {
  if (!box) return;
  const itens = [];
  for (const t of abertas) {
    const textos = await CO.lerTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), "1h", PREFIXO_CONTRA).catch(() => []);
    for (const x of textos) { if (!CO.jaResolvido(x)) { const c2 = lerContra(x, t); if (c2) itens.push(c2); } }
  }
  S.contras = new Map(itens.map((x) => [x.k, x]));
  if (itens.length) await vit()?.sincronizar().catch(() => {}); // carro e placa de quem propôs
  const reps = await Promise.all(itens.map((x) => S.escrow.reputacao(x.motorista).catch(() => null)));
  const html = itens.map((x, i) => `<div class="cartao correio destaque"><h2 style="margin-top:0">💬 Contraproposta: R$ ${brNum(E.formatUnits(x.valor, 18))}</h2>
      <p>${linhaMotorista(x.motorista)} ${reps[i] ? estrelasNivel(reps[i].nivel) : ""}</p>
      <p class="mudo">Você ofereceu R$ ${fmt(x.t.valor)}. Aceitando, o pedido antigo é cancelado (o dinheiro volta) e um novo, de R$ ${brNum(E.formatUnits(x.valor, 18))}, vai direto para este motorista.</p>
      ${botaoSegurar("aceitar a contraproposta", `contra:${x.k}`)}<button class="btn sec" data-acao="contra-recusar" data-k="${esc(x.k)}">Recusar</button></div>`).join("");
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
    ligarSegurar(box);
    if (html) avisarNovoPedido("💬 Um motorista fez uma contraproposta");
  }
}

async function aceitarContraproposta(k) {
  const x = S.contras?.get(k);
  if (!x) throw new Error("Essa contraproposta não está mais aqui. Atualize a tela.");
  const antigo = await S.escrow.detalhe(x.t.id);
  if (antigo.estado !== 0 || antigo.pendenteAprovacao) throw new Error("O pedido já mudou (alguém aceitou). Atualize a tela.");
  const resumo = S.escrow.resumoTrabalhos().get(String(x.t.id));
  const privado = (() => { try { return localStorage.getItem(`xbrl.endereco.${antigo.chegadaHash}`) || ""; } catch { return ""; } })();
  const { p, codigo } = novaCorrida({ trabalhador: x.motorista, valor: x.valor, prazo: Math.max(Number(antigo.prazo), agora() + 3 * 3600), descricao: resumo.descricao, privado });
  const kit = antigo.kitGas || 0n;
  await executar("Aceitar contraproposta", [
    passoEscrow("Cancelar o pedido antigo", "cancelar", [BigInt(x.t.id)]),
    passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, x.valor, "Autorizar BRLS"),
    { rotulo: "Travar o novo valor para o motorista", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(p, { ...o, value: kit }) },
  ]);
  CO.resolver(x.texto);
  modal(`<h2>✅ Combinado</h2><p>O motorista recebe o pedido e aceita. Depois, envie o endereço exato na tela da corrida.</p><p><b>🔑 Novo código do destino</b>:</p>${qrSvg(codigo)}<div class="codigo">${esc(codigo)}</div><button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
  ir("CORRIDA");
}

// ---------- Cancelar depois do aceite, sem depender de resposta ----------
// O passageiro ASSINA (de graça) a proposta "X% ao motorista" e manda pelo avisador. O motorista:
//   - aceita: o app dele abre o cancelamento, envia a proposta assinada do passageiro e propõe o mesmo X%
//     (propostas iguais → o contrato divide na hora; com 0%, ele só desiste e tudo volta);
//   - recusa ou some: nada trava. Quando o prazo do contrato vence, o passageiro pega 100% de volta
//     sozinho (reembolsarPorPrazo). O motorista se protege marcando a corrida como feita ao chegar.
const PREFIXO_CANCEL = "brlscancel:";
const PREFIXO_CANCEL_NAO = "brlscancelnao:";
const chaveCancel = (id) => `xbrl.cancel.${S.chainId}.${id}`;

async function pedirCancelamento(t, bps) {
  const passo = passoEscrow(`Propor ${bps / 100}% ao motorista`, "proporAcordo", [BigInt(t.id), bps]);
  const texto = await SG.assinar(S.carteira, S.provider, S.imp.Encaminhador, [passo.chamada]);
  const ok = await CO.postarTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), PREFIXO_CANCEL + JSON.stringify({ bps, texto }));
  try { localStorage.setItem(chaveCancel(t.id), JSON.stringify({ bps, em: agora() })); } catch { /* ok */ }
  modal(`<h2>${ok ? "📨 Pedido de cancelamento enviado" : "⚠️ O avisador não respondeu"}</h2>
    <p>${ok ? `O motorista vê no app e aceita ou recusa. Aceitando, ele recebe ${bps / 100}% e o resto volta para você na hora.` : "Tente de novo em instantes."}</p>
    <p><b>Se ele não responder</b>, nada trava: a partir de <b>${esc(horaCurta(Number(t.prazo)))}</b> você pega <b>100%</b> de volta com um toque, nesta tela.</p>
    <button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
  render();
}

async function lerPedidoCancelamento(t) {
  const textos = await CO.lerTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), "3h", PREFIXO_CANCEL).catch(() => []);
  for (const x of textos.reverse()) {
    try {
      if (CO.jaResolvido(x)) continue;
      const { bps, texto } = JSON.parse(x.slice(PREFIXO_CANCEL.length));
      const d = SG.decodificar(texto);
      if (d.pedidos.length !== 1 || d.pedidos[0].from.toLowerCase() !== t.cliente.toLowerCase()) continue;
      const f = new E.Interface(ABIS.EscrowTrabalho).parseTransaction({ data: d.pedidos[0].data });
      if (f.name !== "proporAcordo" || String(f.args[0]) !== String(t.id) || Number(f.args[1]) !== Number(bps)) continue;
      await SG.conferir(S.provider, S.imp, d);
      return { x, bps: Number(bps), d };
    } catch { /* inválido ou vencido */ }
  }
  return null;
}

async function aceitarCancelamento(t) {
  const p = await lerPedidoCancelamento(t);
  if (!p) throw new Error("O pedido de cancelamento venceu ou já foi usado.");
  if (p.bps === 0) await executar("Aceitar o cancelamento", [passoEscrow("Desistir (tudo volta ao passageiro)", "desistir", [BigInt(t.id)])]);
  else {
    await executar("Aceitar o cancelamento", [
      passoEscrow("Abrir o cancelamento", "abrirDisputa", [BigInt(t.id)]),
      ...SG.passosParaEnviar(S.carteira, S.imp, p.d),
      passoEscrow(`Aceitar ${p.bps / 100}%`, "proporAcordo", [BigInt(t.id), p.bps]),
    ]);
  }
  CO.resolver(p.x);
}

async function recusarCancelamento(t) {
  const p = await lerPedidoCancelamento(t);
  if (p) CO.resolver(p.x);
  const msg = JSON.stringify({ id: String(t.id), em: agora() });
  const sig = await S.carteira.signMessage(msg);
  await CO.postarTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), PREFIXO_CANCEL_NAO + JSON.stringify({ msg, sig })).catch(() => {});
  toast("Você recusou. A corrida continua.");
  render();
}

/** Passageiro: o motorista recusou o cancelamento? */
async function motoristaRecusou(t) {
  const textos = await CO.lerTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), "3h", PREFIXO_CANCEL_NAO).catch(() => []);
  return textos.some((x) => {
    try { const { msg, sig } = JSON.parse(x.slice(PREFIXO_CANCEL_NAO.length)); return JSON.parse(msg).id === String(t.id) && E.verifyMessage(msg, sig).toLowerCase() === t.trabalhador.toLowerCase(); } catch { return false; }
  });
}

/** Mostra, na tela da corrida, o estado do cancelamento (para os dois lados). */
async function mostrarCancelamento(t, souCliente) {
  const box = $("#cor-cancel");
  if (!box || t.estado !== 1) return;
  let html = "";
  if (souCliente) {
    let pend = null;
    try { pend = JSON.parse(localStorage.getItem(chaveCancel(t.id)) || "null"); } catch { /* ok */ }
    if (pend) {
      const recusou = await motoristaRecusou(t);
      const relogio = Number((await S.provider.getBlock("latest"))?.timestamp || agora()); // relógio da blockchain
      const venceu = relogio > Number(t.prazo);
      html = `<div class="cartao correio ${venceu ? "destaque" : ""}"><h2 style="margin-top:0">${recusou ? "O motorista recusou o cancelamento" : `Cancelamento pedido (${pend.bps / 100}% ao motorista)`}</h2>
        <p>${venceu ? "O prazo do contrato venceu: pegue os 100% de volta agora." : recusou ? "Ele quer fazer a corrida. Se mesmo assim ele não vier," : "Aguardando o motorista responder. Se ele não responder,"}${venceu ? "" : ` a partir de <b>${esc(horaCurta(Number(t.prazo)))}</b> você pega <b>100%</b> de volta aqui.`}</p>
        ${venceu ? botaoSegurar("pegar meu dinheiro de volta", "tr-reembolsarPorPrazo") : ""}</div>`;
    }
  } else {
    const p = await lerPedidoCancelamento(t);
    if (p) {
      html = `<div class="cartao correio destaque"><h2 style="margin-top:0">O passageiro quer cancelar</h2>
        <p>Ele propõe <b>${p.bps / 100}%</b> do valor para você (R$ ${fmt((t.valor * BigInt(p.bps)) / 10000n)})${p.bps ? "" : ": tudo volta para ele"}. Aceitando, o contrato divide na hora.</p>
        ${botaoSegurar("aceitar o cancelamento", "cor-cancel-aceitar")}<button class="btn sec" data-acao="cor-cancel-recusar">Recusar e continuar a corrida</button></div>`;
    }
    if (t.chegou && Number(t.prazo) - agora() < 45 * 60) {
      html += `<div class="aviso">⏰ O prazo do contrato vence às <b>${esc(horaCurta(Number(t.prazo)))}</b>. Ao chegar, receba o código; se o passageiro não mostrar, toque em "marcar a corrida como feita" antes disso.</div>`;
    }
  }
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; ligarSegurar(box); if (html && !souCliente && html.includes("quer cancelar")) avisarNovoPedido("O passageiro pediu para cancelar"); }
}

// ---------- Na corrida: posição do motorista (cifrada só para o passageiro) ----------
const PREFIXO_LOC = "brlsloc:";
async function enviarMinhaPosicao(t) {
  if (S.ultimaPosEnviada && Date.now() - S.ultimaPosEnviada < 20000) return;
  const pos = await minhaPosicao();
  if (!pos) return;
  const pub = await S.chat.chaveDe(t.cliente, t.txCriacao ? [t.txCriacao] : []);
  if (!pub) return;
  const cif = await cifrarChat(S.carteira, pub, JSON.stringify({ lat: Number(pos.lat.toFixed(5)), lon: Number(pos.lon.toFixed(5)), em: agora() }));
  S.ultimaPosEnviada = Date.now();
  await CO.postarTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), PREFIXO_LOC + cif).catch(() => {});
}

async function mostrarMotoristaNoMapa(t, embarque) {
  const box = $("#cor-mapa");
  if (!box) return;
  const textos = await CO.lerTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), "15m", PREFIXO_LOC).catch(() => []);
  if (!textos.length) return;
  const pub = await S.chat.chaveDe(t.trabalhador, t.txAceite ? [t.txAceite] : []);
  if (!pub) return;
  let ultima = null;
  for (const x of textos.slice(-5)) {
    try {
      const d = JSON.parse((await decifrarChat(S.carteira, pub, x.slice(PREFIXO_LOC.length))).texto);
      if (!ultima || d.em > ultima.em) ultima = d;
    } catch { /* não é para mim */ }
  }
  if (!ultima) return;
  const pontos = [{ lat: ultima.lat, lon: ultima.lon, icone: "🚗", rotulo: "Motorista" }];
  if (embarque && !t.chegou) pontos.push({ ...embarque, icone: "🟢", rotulo: "Embarque" });
  mapaFixo(box, pontos);
  const info = $("#cor-eta");
  if (info) {
    const min = embarque && !t.chegou ? Math.max(1, Math.round(((distanciaKm(ultima, embarque) * 1.35) / 24) * 60)) : null;
    info.textContent = `${min ? `Motorista a ~${min} min do embarque · ` : ""}posição de ${new Date(ultima.em * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  }
}

async function compartilharCorrida() {
  const t = S.params.t;
  const cor = lerCorrida(S.escrow.resumoTrabalhos().get(String(t.id))?.descricao);
  const m = vit()?.motorista(t.trabalhador);
  const texto = `🚗 Estou numa corrida pelo BRLS\nDe: ${cor.de}\nPara: ${cor.para}\nMotorista: ${m?.apelido || curto(t.trabalhador)}${m ? `\nVeículo: ${m.modelo} ${m.cor} · placa ${m.placa}` : ""}\nCarteira do motorista: ${t.trabalhador}\nSaída: ${new Date().toLocaleString("pt-BR")}`;
  if (navigator.share) { try { await navigator.share({ text: texto }); return; } catch { /* cancelou */ } }
  await navigator.clipboard.writeText(texto);
  toast("Dados da corrida copiados: cole no WhatsApp de alguém de confiança.");
}

// ---------- Perfil do veículo, tarifas e ganhos ----------
TELAS.MEU_CARRO = async () => {
  await vit()?.sincronizar().catch(() => {});
  const m = vit()?.motorista(S.endereco) || { apelido: "", veiculo: "pop", modelo: "", cor: "", placa: "" };
  tela(`
    <h1>🚘 Meu veículo</h1>
    <p class="mudo">Fica público na vitrine, como na 99: o passageiro confere carro, cor e placa antes de aprovar e antes de entrar.</p>
    <label for="mc-apelido">Seu nome ou apelido</label><input id="mc-apelido" maxlength="30" value="${esc(m.apelido)}">
    <label for="mc-veiculo">Categoria</label><select id="mc-veiculo">${["moto", "pop", "plus"].map((k) => `<option value="${k}" ${k === m.veiculo ? "selected" : ""}>${VEICULOS[k].icone} ${VEICULOS[k].nome}</option>`).join("")}</select>
    <label for="mc-modelo">Modelo</label><input id="mc-modelo" maxlength="40" placeholder="Ex.: Onix 2020" value="${esc(m.modelo)}">
    <label for="mc-cor">Cor</label><input id="mc-cor" maxlength="20" placeholder="Ex.: prata" value="${esc(m.cor)}">
    <label for="mc-placa">Placa</label><input id="mc-placa" maxlength="10" autocapitalize="characters" placeholder="ABC1D23" value="${esc(m.placa)}">
    <label for="mc-foto">Sua foto (opcional, ajuda o passageiro a reconhecer você)</label><input id="mc-foto" type="file" accept="image/*">
    ${botaoSegurar("publicar meu veículo", "mc-publicar")}
    <button class="btn sec" data-ir="MOTORISTA">Voltar</button>`);
  $("#mc-foto").addEventListener("change", (ev) => { S.carroFoto = ev.target.files[0] || null; });
};

async function publicarCarro() {
  const ler = (id) => ($(`#${id}`)?.value || "").trim();
  const o = { t: "m", id: "motorista", apelido: ler("mc-apelido"), veiculo: ler("mc-veiculo"), modelo: ler("mc-modelo"), cor: ler("mc-cor"), placa: ler("mc-placa").toUpperCase().replace(/[^A-Z0-9]/g, ""), status: "ativo" };
  if (o.apelido.length < 2 || o.modelo.length < 2 || o.cor.length < 2) throw new Error("Preencha nome, modelo e cor");
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(o.placa)) throw new Error("Placa inválida (ex.: ABC1D23 ou ABC1234)");
  const ant = vit().motorista(S.endereco);
  let itens;
  if (S.carroFoto || !ant?.fotos?.length) itens = await montarItens(o, S.carroFoto ? [S.carroFoto] : []);
  else { await vit().fotos(ant); itens = [codificar({ ...o, fotos: ant.fotos }), ...(vit().fotosMem.get(ant.tx) || [])]; }
  await publicarItens("Publicar meu veículo", itens);
  S.carroFoto = null;
  await vit().sincronizar().catch(() => {});
  ir("MOTORISTA");
}

TELAS.TARIFAS = async () => {
  const t = tarifas();
  const campo = (k, f) => `<input id="tf-${k}-${f}" inputmode="decimal" value="${esc(brNum(t[k][f]))}" aria-label="${VEICULOS[k].nome} ${f}">`;
  tela(`
    <h1>⚙️ Tarifas sugeridas</h1>
    <p class="mudo">É só a sugestão que aparece ao pedir: quem pede sempre pode mudar o preço. Fica salvo neste aparelho.</p>
    <div class="cartao tarifas"><div class="tf-linha tf-cab"><span></span><b>Base</b><b>Por km</b><b>Por min</b></div>
      ${["moto", "pop", "plus"].map((k) => `<div class="tf-linha"><b>${VEICULOS[k].icone} ${VEICULOS[k].nome}</b>${campo(k, "base")}${campo(k, "km")}${campo(k, "min")}</div>`).join("")}</div>
    <label for="tf-expresso">⚡ Expresso: quanto a mais (%)</label><input id="tf-expresso" inputmode="decimal" value="${esc(brNum(t.expresso, 0))}">
    <label for="tf-minimo">Preço mínimo de uma corrida (R$)</label><input id="tf-minimo" inputmode="decimal" value="${esc(brNum(t.minimo))}">
    <p class="mudo" id="tf-exemplo"></p>
    <button class="btn prim" data-acao="tf-salvar">Salvar tarifas</button>
    <button class="btn sec" data-acao="tf-padrao">Voltar às tarifas padrão</button>
    <button class="btn sec" data-ir="CORRIDA">Voltar</button>`);
  const exemplo = () => {
    try {
      const nt = lerTarifasDaTela();
      $("#tf-exemplo").textContent = `Exemplo: 8 km em 20 min = Moto R$ ${brNum(precoSugerido("moto", 8, 20, false, nt))} · Pop R$ ${brNum(precoSugerido("pop", 8, 20, false, nt))} · Plus R$ ${brNum(precoSugerido("plus", 8, 20, false, nt))}`;
    } catch { /* digitando */ }
  };
  $$(".tarifas input, #tf-expresso, #tf-minimo").forEach((i) => i.addEventListener("input", exemplo));
  exemplo();
};
function lerTarifasDaTela() {
  const n = (id) => { const v = Number(String($(`#${id}`).value).replace(/\./g, "").replace(",", ".")); if (!Number.isFinite(v) || v < 0) throw new Error("Valor inválido nas tarifas"); return v; };
  const t = { expresso: n("tf-expresso"), minimo: n("tf-minimo") };
  for (const k of ["moto", "pop", "plus"]) t[k] = { base: n(`tf-${k}-base`), km: n(`tf-${k}-km`), min: n(`tf-${k}-min`) };
  return t;
}

TELAS.GANHOS = async () => {
  tela(`<h1>📊 Meus ganhos</h1><div class="cartao"><div class="giro"></div><p class="mudo">Somando suas corridas…</p></div>`);
  await S.escrow.sincronizar();
  const eu = S.endereco.toLowerCase();
  const feitas = [...S.escrow.resumoTrabalhos().values()].filter((t) => t.fim === "concluido" && t.trabalhador?.toLowerCase() === eu && lerCorrida(t.descricao)).slice(-200);
  const blocos = new Map();
  for (const t of feitas) {
    const b = t.historico.find((h) => h.nome === "TrabalhoConcluido")?.bloco ?? t.bloco;
    if (!blocos.has(b)) blocos.set(b, S.provider.getBlock(b).then((x) => Number(x?.timestamp || 0)).catch(() => 0));
  }
  const linhas = await Promise.all(feitas.map(async (t) => {
    const b = t.historico.find((h) => h.nome === "TrabalhoConcluido")?.bloco ?? t.bloco;
    const c2 = lerCorrida(t.descricao);
    return { em: await blocos.get(b), valor: Number(E.formatUnits(t.valor, 18)) * 0.999, km: c2.km || 0, t, c: c2 };
  }));
  const agoraS = agora();
  const inicioHoje = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const soma = (l) => ({ n: l.length, v: l.reduce((s, x) => s + x.valor, 0), km: l.reduce((s, x) => s + x.km, 0) });
  const hoje = soma(linhas.filter((x) => x.em >= inicioHoje));
  const semana = soma(linhas.filter((x) => x.em >= agoraS - 7 * 86400));
  const total = soma(linhas);
  const bloco = (nome, s) => `<div class="linha"><span>${nome}</span><span><b>R$ ${brNum(s.v)}</b> <small class="mudo">${s.n} corrida${s.n === 1 ? "" : "s"}${s.km ? ` · ${brNum(s.km, 1)} km · R$ ${brNum(s.v / s.km)}/km` : ""}</small></span></div>`;
  tela(`
    <h1>📊 Meus ganhos</h1>
    <div class="cartao">${bloco("Hoje", hoje)}${bloco("Últimos 7 dias", semana)}${bloco("Total", total)}</div>
    <p class="mudo">Já sem a taxa de 0,1% do protocolo. Gorjetas chegam direto na carteira (veja o Extrato).</p>
    <h2>Últimas corridas</h2>${linhas.slice(-15).reverse().map((x) => `<div class="linha"><span>${esc(x.c.de)} → ${esc(x.c.para)}<br><small class="mudo">${x.em ? esc(horaCurta(x.em)) : ""}${x.km ? ` · ${brNum(x.km, 1)} km` : ""}</small></span><b>R$ ${brNum(x.valor)}</b></div>`).join("") || `<p class="mudo">Nenhuma corrida concluída ainda.</p>`}
    <button class="btn sec" data-ir="MOTORISTA">Voltar</button>`);
};

TELAS.TRABALHO_NOVO = () => {
  const m = Number(S.params.modalidade ?? 0);
  tela(`
    <h1>Contratar</h1>
    <div class="grade duas">${ESCROW.modalidades.map((x) => `<button class="atalho" data-acao="mod-${x.id}" aria-pressed="${x.id === m}" style="${x.id === m ? "border-color:var(--o400);background:rgba(212,175,55,.14)" : ""}"><span>${x.icone}</span>${esc(x.nome)}</button>`).join("")}</div>
    <p class="mudo">${esc(ESCROW.modalidades[m].resumo)}</p>
    <label for="tn-desc">O que precisa ser feito (título)</label><input id="tn-desc" maxlength="100" placeholder="Ex.: Pintar a sala de 12 m²">
    <label for="tn-detalhes">📝 Detalhes do trabalho (aparece para todos)</label><textarea id="tn-detalhes" rows="5" maxlength="600" placeholder="Conte tudo o que a pessoa precisa saber: o que fazer, tamanho, materiais, horário, o que está incluso, como você quer receber o resultado…"></textarea>
    <p class="mudo">Não coloque telefone nem endereço aqui: isso vai abaixo, só para quem for fazer.</p>
    ${m === 0 || m === 1 ? `<label for="tn-regiao">📍 Bairro e cidade ${m === 1 ? "da entrega" : "do serviço"} (obrigatório, aparece para todos)</label><input id="tn-regiao" maxlength="36" placeholder="Ex.: Savassi, Belo Horizonte">
    <label for="tn-endereco">🏠 Endereço completo (obrigatório)</label><input id="tn-endereco" maxlength="200" placeholder="Rua, número, complemento, referência">
    <button type="button" class="btn sec" data-acao="tn-mapa">🗺️ Marcar o ponto exato no mapa</button>
    <p class="mudo" id="tn-ponto">${S.params.ponto ? `📍 Ponto marcado: ${esc(fmtCoord(S.params.ponto.lat, S.params.ponto.lon))}` : "Recomendado: com o ponto no mapa, a pessoa abre direto no GPS dela."}</p>
    <p class="mudo">Por segurança, o endereço completo não fica público: só a pessoa aceita vê, pela conversa cifrada do trabalho.</p>` : ""}
    <details class="cartao" open><summary><b>📞 Contato direto (só para quem for fazer)</b></summary>
      <p class="mudo">Vai cifrado, só para a pessoa confirmada no trabalho. Assim vocês conversam pelo WhatsApp sem gastar mensagem na blockchain.</p>
      <label for="tn-whats">Seu WhatsApp (opcional)</label><input id="tn-whats" inputmode="tel" autocomplete="tel" placeholder="(31) 99999-9999" value="${esc(meuWhatsSalvo() ? whatsBonito(meuWhatsSalvo()) : "")}">
      ${m === 2 || m === 3 ? `<label class="linha" style="color:var(--txt)"><span>🎥 Criar uma sala no Jitsi Meet para as reuniões (grátis, sem cadastro)</span><input type="checkbox" id="tn-jitsi" style="width:auto" checked></label>` : ""}
      <label for="tn-links">${m === 2 || m === 3 ? "Links do trabalho (Google Drive, documentos, referências)" : "Links (opcional: fotos, referências)"}</label><textarea id="tn-links" rows="2" autocapitalize="none" spellcheck="false" placeholder="Um link por linha, começando com https://"></textarea>
      <label for="tn-priv">Detalhes só para quem for fazer (opcional)</label><textarea id="tn-priv" rows="3" maxlength="1000" placeholder="Ex.: senha do portão, nome de quem vai receber, instruções particulares…"></textarea>
    </details>
    <label for="tn-kit">⛽ Gás para o trabalhador (POL)</label><input id="tn-kit" inputmode="decimal" value="1">
    <p class="mudo">Vai junto com o pagamento e chega na carteira de quem for trabalhar, para a pessoa nunca travar por falta de taxa: 1 POL dá para dezenas de operações. Se ninguém aceitar, volta para você. Pode diminuir ou deixar 0.</p>
    <label for="tn-valor">Pagamento (BRLS)</label><input id="tn-valor" class="grande" inputmode="decimal" placeholder="0,00">
    <label for="tn-prazo">Prazo (dias)</label><input id="tn-prazo" inputmode="numeric" value="7">
    ${m === 3 ? `<label for="tn-etapas">Número de etapas (2 a 50)</label><input id="tn-etapas" inputmode="numeric" value="3">` : ""}
    <label for="tn-trab">Trabalhador (opcional: vazio = vaga aberta)</label><input id="tn-trab" autocomplete="off" autocapitalize="none" placeholder="0x…">
    ${m === 0 ? `<div class="ok">Vamos gerar um <b>código de chegada</b> (palavras + QR). Deixe no local ou mostre na porta: o trabalhador só comprova que chegou com ele.</div>` : ""}
    ${m === 1 ? `<div class="ok">Vamos gerar um <b>código de entrega</b> (palavras + QR). Passe só para quem vai receber: o entregador só entrega a mercadoria quando recebe o código, e o pagamento sai na hora. Sem código, sem entrega: não existe "entreguei e não me deram o código".</div>
      <label class="linha" style="color:var(--txt)"><span>Exigir caução do entregador (recomendado para mercadoria de valor)</span><input type="checkbox" id="tn-caucao-on" style="width:auto" checked></label>
      <label for="tn-caucao">Caução (mín. ${ESCROW.caucaoMinima} BRLS, de preferência o valor da mercadoria)</label><input id="tn-caucao" inputmode="decimal" value="${ESCROW.caucaoMinima}">
      <p class="mudo">A caução fica travada até o fim. Com o código de entrega, volta para o entregador. Se ele trouxer a mercadoria de volta, você dá o <b>código de devolução</b> e ele recupera a caução. Se ele sumir com a mercadoria, a caução fica com você.</p>` : m !== 3 ? `<label class="linha" style="color:var(--txt)"><span>Exigir código para liberar o pagamento</span><input type="checkbox" id="tn-cod" style="width:auto"></label>` : ""}
    ${m !== 1 ? `<details class="cartao"><summary><b>⚖️ Árbitros em caso de disputa (opcional)</b></summary>
      <p class="mudo">Você indica uma pessoa de confiança; o trabalhador indica outra ao aceitar. Se houver disputa, os dois árbitros propõem uma divisão: se concordarem, ela é executada na hora. Sem acordo em 30 dias, vale a média das propostas.</p>
      <label for="tn-arb">Seu árbitro (endereço 0x…)</label><input id="tn-arb" autocomplete="off" autocapitalize="none" placeholder="0x… (vazio = sem árbitros)">
      <label class="linha" style="color:var(--txt)"><span>Aceito o criador da rede como desempate (só entre as propostas dos árbitros, depois de 3 dias)</span><input type="checkbox" id="tn-desempate" style="width:auto"></label>
    </details>` : ""}
    ${botaoSegurar("travar o pagamento", "criar-trabalho")}
    <p class="mudo">O valor fica travado no contrato, não com a gente. Taxa de 0,1% só quando o trabalhador recebe.</p>`);
  ligarMaximo("#tn-valor", async () => ({ ...(await saldoBrls()), nota: "A taxa de 0,1% sai do pagamento do trabalhador, não do seu saldo." }));
  ligarMaximo("#tn-kit", async () => {
    const pol = await S.provider.getBalance(S.endereco);
    let max = pol - (await custoGas(900_000));
    if (max > E.parseEther("5")) max = E.parseEther("5");
    return { max, decimais: 18, simbolo: "POL", texto: `Você tem <b>${fmt(pol, 18, 3)} POL</b> (máx. 5 para o gás do trabalhador)`, nota: "Já descontei a taxa da rede." };
  });
};

TELAS.TRABALHO = async () => {
  const id = S.params.id;
  const t = await S.escrow.detalhe(id);
  const resumo = S.escrow.resumoTrabalhos().get(String(id));
  const m = ESCROW.modalidades[t.modalidade];
  const cor = t.modalidade === 0 ? lerCorrida(resumo?.descricao) : null; // corrida de carro/moto
  if (cor) await vit()?.sincronizar().catch(() => {}); // perfil do motorista (carro, cor, placa)
  if (cor && t.estado < 4) telaAcesa(true);
  // Na corrida o passageiro confirma o embarque com um toque (o código de chegada fica guardado)
  const acoes = S.escrow.acoesPossiveis(t, S.endereco).filter((a) => !(cor && a === "confirmarChegada"));
  const [rc, rt] = await Promise.all([S.escrow.reputacao(t.cliente), t.trabalhador !== E.ZeroAddress ? S.escrow.reputacao(t.trabalhador) : null]);
  const souCliente = t.cliente.toLowerCase() === S.endereco.toLowerCase();
  const ativo = t.estado < 4; // 4 = concluído, 5 = cancelado: arquivado, sem códigos nem QR
  const codigo = ativo && souCliente && t.codigoHash !== E.ZeroHash ? codigoGuardado(t.codigoHash) : null;
  const chegada = ativo && !cor && souCliente && t.chegadaHash !== E.ZeroHash && !t.chegou ? codigoGuardado(t.chegadaHash) : null;
  const devolucao = ativo && souCliente && t.caucaoTravada ? codigoGuardado(t.devolucaoHash) : null;
  const meuPol = await S.provider.getBalance(S.endereco).catch(() => 10n ** 18n);
  const semPol = meuPol < 10n ** 16n && !!S.imp.Encaminhador;
  const chaveEnd = t.modalidade === 0 ? t.chegadaHash : t.codigoHash;
  let enderecoGuardado = null;
  let enderecoEnviado = false;
  try {
    enderecoGuardado = localStorage.getItem(`xbrl.endereco.${chaveEnd}`);
    enderecoEnviado = localStorage.getItem(`xbrl.endereco.enviado.${chaveEnd}`) === "1";
  } catch { /* sem armazenamento */ }
  const pedirEndereco = souCliente && enderecoGuardado && !enderecoEnviado && t.estado === 1 && t.trabalhador !== E.ZeroAddress;
  const z = E.ZeroAddress;
  const temArbitros = t.arbitroCliente !== z;
  const souParte = souCliente || t.trabalhador.toLowerCase() === S.endereco.toLowerCase();
  const souArbitro = temArbitros && [t.arbitroCliente, t.arbitroTrabalhador].some((a) => a.toLowerCase() === S.endereco.toLowerCase());
  const propArb = (v) => (v ? `${(v - 1) / 100}%` : "—");
  // Intervalo do desempate do criador (entre as propostas dos árbitros)
  const lim = temArbitros && t.propostaArbCliente && t.propostaArbTrabalhador
    ? [Math.min(t.propostaArbCliente, t.propostaArbTrabalhador) - 1, Math.max(t.propostaArbCliente, t.propostaArbTrabalhador) - 1]
    : [0, 10_000];
  S.params.t = { ...t, descricao: resumo?.descricao, txCriacao: resumo?.txCriacao, txAceite: resumo?.txAceite };
  const ROTULOS = {
    aceitar: "aceitar o trabalho", cancelar: "cancelar e reaver o valor", marcarEntregue: "marcar como entregue",
    liberar: t.modalidade === 3 && t.etapasPagas + 1 < t.etapas ? `liberar a etapa ${t.etapasPagas + 1}` : "aprovar e pagar", reivindicar: "receber (prazo de revisão vencido)",
    desistir: "desistir (devolve ao cliente)", aprovarCandidato: "aprovar este trabalhador", recusarCandidato: "recusar o candidato",
    retirarCandidatura: "retirar minha candidatura", abrirDisputa: "abrir disputa", reembolsarPorPrazo: t.caucaoTravada ? "reaver pagamento + caução (entregador não apareceu)" : "reaver (prazo vencido)",
    resolverPorTempo: t.propostaArbCliente && t.propostaArbTrabalhador ? "executar a média dos árbitros" : "executar divisão 50/50",
    chegadaPeloCliente: "confirmar que o trabalhador chegou",
  };
  const NOME = cor ? { cliente: "Passageiro", trab: "Motorista", candidato: "Motorista candidato" } : { cliente: "Cliente", trab: "Trabalhador", candidato: "Candidato" };
  const pixT = /^💱/u.test(resumo?.descricao || "");
  if (pixT) {
    Object.assign(NOME, { cliente: "Quem recebe o Pix", trab: "Quem faz o Pix", candidato: "Candidato" });
    Object.assign(ROTULOS, { aceitar: "aceitar", marcarEntregue: "avisar: já fiz o Pix", liberar: "recebi o Pix na conta: liberar os BRLS", reivindicar: "receber os BRLS (prazo vencido)", desistir: "desistir (devolve os BRLS)" });
  }
  if (cor) Object.assign(ROTULOS, {
    aceitar: "quero fazer esta corrida", cancelar: "cancelar a corrida e reaver o valor", aprovarCandidato: "aprovar este motorista",
    recusarCandidato: "recusar este motorista", retirarCandidatura: "desistir da corrida", chegadaPeloCliente: "confirmar: entrei no veículo",
    liberar: "pagar o motorista agora", desistir: "desistir da corrida (devolve ao passageiro)",
    marcarEntregue: "marcar a corrida como feita (recebe em 3 dias se o passageiro não pagar antes)",
  });
  tela(`
    ${cor ? `<h1>${cor.icone} Corrida: ${esc(cor.de)} → ${esc(cor.para)}</h1>
    <p class="mudo">#${esc(t.id)} · ${esc(cor.nomeCategorias)}${cor.km != null ? ` · ${brNum(cor.km, 1)} km` : ""}${cor.expresso ? " · ⚡ Expresso" : ""}${cor.agendada ? ` · ⏰ ${esc(horaCurta(cor.agendada))}` : ""}${cor.pessoas > 1 ? ` · ${cor.pessoas} pessoas` : ""}${cor.obs ? ` · ${esc(cor.obs)}` : ""} · <span class="selo">${esc(t.estadoNome)}</span></p>
    <div class="ok passo-corrida">${esc(passoCorrida(t, souCliente).texto)}</div>${blocoCorrida(t, souCliente)}` : `<h1>${iconeDesc(resumo?.descricao, m).map((x, i) => (i ? esc(x) : x)).join(" ")}</h1>
    <p class="mudo">#${esc(t.id)} · ${esc(m.nome)} · <span class="selo">${esc(t.estadoNome)}</span></p>`}
    ${barraFases(fasesTrabalho(t, souCliente, { comChegada: resumo?.comChegada }))}
    ${detalhesDesc(resumo?.descricao) ? `<div class="cartao detalhes"><h2 style="margin-top:0">📝 Detalhes</h2><p>${comLinks(esc(detalhesDesc(resumo?.descricao)))}</p></div>` : ""}
    ${!ativo ? `<div class="ok">📁 <b>Arquivado.</b> ${t.estado === 5 ? "Cancelado: o valor travado voltou para a carteira de quem contratou." : "Concluído: o pagamento já foi feito."} Os códigos deste trabalho não valem mais.</div>` : ""}
    <div class="cartao">
      <div class="linha"><span>Valor</span><b>${fmt(t.valor)} BRLS</b></div>
      <div class="linha"><span>Já pago</span><b>${fmt(t.pago)} BRLS</b></div>
      ${t.etapas > 1 ? `<div class="linha"><span>Etapas pagas</span><b>${t.etapasPagas} de ${t.etapas}</b></div>` : ""}
      <div class="linha"><span>Prazo</span><b>${new Date(t.prazo * 1000).toLocaleString("pt-BR")}</b></div>
      <div class="linha"><span>${NOME.cliente}</span><span>${esc(curto(t.cliente))} ${estrelasNivel(rc.nivel)} <small class="mudo">${Number(rc.contrapartes)} ${Number(rc.contrapartes) === 1 ? "pessoa" : "pessoas"} · ${rc.idadeDias} dias</small></span></div>
      <div class="linha"><span>${t.pendenteAprovacao ? NOME.candidato : NOME.trab}</span><span>${t.trabalhador === E.ZeroAddress ? (cor ? "procurando motorista" : "vaga aberta") : `${esc(curto(t.trabalhador))} ${estrelasNivel(rt.nivel)} ${rt ? `<small class="mudo">${Number(rt.contrapartes)} ${Number(rt.contrapartes) === 1 ? "pessoa" : "pessoas"} · ${rt.idadeDias} dias</small>` : ""}`}</span></div>
      ${t.pendenteAprovacao ? `<div class="linha"><span>Situação</span><b>aguardando o cliente aprovar</b></div>` : ""}
      ${t.modalidade === 0 ? `<div class="linha"><span>${cor ? "Embarque" : "Chegada"}</span>${t.chegou ? `<span class="selo verde">${cor ? "passageiro embarcou" : "confirmada com código"}</span>` : "<b>aguardando</b>"}</div>` : ""}
      ${t.estado === 2 ? `<div class="linha"><span>Pagamento automático em</span><b>${new Date((t.entregueEm + ESCROW.prazoRevisaoDias * 86400) * 1000).toLocaleString("pt-BR")}</b></div>` : ""}
      ${t.estado === 3 ? `<div class="linha"><span>Propostas (ao trabalhador)</span><b>cliente ${t.propostaCliente ? (t.propostaCliente - 1) / 100 + "%" : "—"} · trabalhador ${t.propostaTrabalhador ? (t.propostaTrabalhador - 1) / 100 + "%" : "—"}</b></div>` : ""}
      ${t.kitGas > 0n ? `<div class="linha"><span>⛽ Gás para o trabalhador</span><b>${fmt(t.kitGas, 18, 3)} POL (chega quando o trabalho for confirmado)</b></div>` : ""}
      ${t.caucao > 0n ? `<div class="linha"><span>Caução do entregador</span><b>${fmt(t.caucao)} BRLS ${t.caucaoTravada ? "· travada" : ""}</b></div>` : ""}
      ${temArbitros ? `<div class="linha"><span>Árbitro do cliente</span><span>${esc(curto(t.arbitroCliente))}</span></div>
        <div class="linha"><span>Árbitro do trabalhador</span><span>${t.arbitroTrabalhador !== z ? esc(curto(t.arbitroTrabalhador)) : "indicado ao aceitar"}</span></div>
        ${t.estado === 3 ? `<div class="linha"><span>Propostas dos árbitros</span><b>${propArb(t.propostaArbCliente)} · ${propArb(t.propostaArbTrabalhador)}</b></div>` : ""}` : ""}
      ${t.desempateCriador ? `<div class="linha"><span>Desempate</span><b>criador da rede (opcional)</b></div>` : ""}
    </div>
    ${semPol ? `<div class="aviso">⛽ Você está sem POL. Tudo bem: ao tocar numa ação, você assina de graça e o pedido vai <b>direto para o app ${souCliente ? `do ${NOME.trab.toLowerCase()}` : `do ${NOME.cliente.toLowerCase()}`}</b>, que aceita ou recusa e paga a taxa (centavos).</div>` : ""}
    <div id="correio"></div>
    ${!souCliente && t.trabalhador.toLowerCase() === S.endereco.toLowerCase() && t.estado === 1 ? `<div id="rota"></div>` : ""}
    ${S.imp.Encaminhador && !souCliente ? "" : S.imp.Encaminhador ? `<button class="btn sec" data-acao="semgas-ler">📷 Ler pedido sem gás da outra pessoa</button>` : ""}
    ${pedirEndereco ? `<div class="aviso">📍 <b>Falta um passo:</b> ${pixT ? "envie sua chave Pix para quem aceitou." : "envie o endereço completo para quem aceitou, senão a pessoa não sabe aonde ir."}<br><small style="white-space:pre-line">${esc(enderecoGuardado)}</small></div>${botoesGps(enderecoGuardado, rotulosPontos(enderecoGuardado))}<button class="btn prim" data-acao="enviar-endereco">${pixT ? "🔑 Enviar sua chave Pix (cifrada)" : "📍 Enviar endereço (cifrado)"}</button>` : ""}
    ${ativo && souCliente && enderecoGuardado && enderecoEnviado ? `<p class="mudo" style="white-space:pre-line">📍 Endereço enviado pela conversa:
${esc(enderecoGuardado)}</p>${botoesGps(enderecoGuardado, rotulosPontos(enderecoGuardado))}` : ""}
    ${(souParte || souArbitro || (t.desempateCriador && S.endereco.toLowerCase() === CREATOR_TREASURY.toLowerCase())) && t.trabalhador !== z ? `<button class="btn sec" data-acao="abrir-chat">💬 Conversar com ${souCliente ? `o ${NOME.trab.toLowerCase()}` : souArbitro ? "as partes" : `o ${NOME.cliente.toLowerCase()}`}</button>` : ""}
    ${ativo && souParte && t.trabalhador !== z && t.estado >= 1 && t.estado <= 3 ? blocoContato(t, souCliente) : ""}
    ${chegada ? `<h2>📍 Código de chegada</h2><p class="mudo">Deixe no local ou mostre ao trabalhador quando ele chegar.</p>${qrSvg(chegada)}<div class="codigo">${esc(chegada)}</div>` : ""}
    ${codigo ? `<h2>🔑 ${cor ? "Código do destino" : `Código de ${t.modalidade === 1 ? "entrega" : "liberação"}`}</h2><p class="mudo">${cor ? "Mostre ao motorista <b>só quando chegar ao destino</b>. Com ele, o motorista recebe na hora." : "Entregue só a quem recebe, na hora da entrega."}</p>${qrSvg(codigo)}<div class="codigo">${esc(codigo)}</div>` : ""}
    ${devolucao ? `<details class="cartao"><summary><b>↩️ Código de devolução</b> (só se a mercadoria voltar para você)</summary><p class="mudo">Entregue ao entregador <b>somente</b> quando ele devolver a mercadoria em suas mãos. Com ele, você recebe o pagamento de volta e ele recupera a caução.</p>${qrSvg(devolucao)}<div class="codigo">${esc(devolucao)}</div></details>` : ""}
    ${acoes.includes("aceitar") && temArbitros ? `<label for="tr-arb">Seu árbitro para disputas (endereço 0x… de alguém de sua confiança)</label><input id="tr-arb" autocomplete="off" autocapitalize="none" placeholder="0x…">` : ""}
    ${acoes.includes("aceitar") && t.caucao > 0n ? `<div class="aviso">Ao aceitar, ${fmt(t.caucao)} BRLS da sua carteira ficam travados como caução. Eles voltam quando você usar o código de entrega (ou o de devolução, se trouxer a mercadoria de volta). <b>Nunca entregue nem devolva a mercadoria sem receber o código.</b></div>` : ""}
    ${acoes.includes("confirmarChegada") ? `<label for="tr-chegada">Cheguei: código de chegada que está no local</label><input id="tr-chegada" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="palavras do código"><button class="btn sec" data-acao="scan-chegada">📷 Escanear QR</button>${botaoSegurar("confirmar que cheguei", "tr-chegada")}` : ""}
    ${acoes.includes("confirmarComCodigo") && !(cor && souCliente) ? `<label for="tr-cod">${cor ? "Chegou ao destino? Peça o código ao passageiro" : `Código de ${t.modalidade === 1 ? "entrega" : "liberação"}`}</label><input id="tr-cod" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="palavras do código"><button class="btn sec" data-acao="scan-codigo">📷 Escanear QR</button>${botaoSegurar("confirmar com o código", "tr-codigo")}` : ""}
    ${acoes.includes("confirmarDevolucao") && !souCliente ? `<details class="cartao"><summary><b>↩️ Devolver a mercadoria</b></summary><p class="mudo">Só devolva na mão do cliente e em troca do código de devolução. Com o código, você recupera a caução.</p><label for="tr-dev">Código de devolução</label><input id="tr-dev" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="palavras do código"><button class="btn sec" data-acao="scan-devolucao">📷 Escanear QR</button>${botaoSegurar("confirmar a devolução", "tr-devolucao")}</details>` : ""}
    ${acoes.includes("arbitrar") ? `<h2>⚖️ Sua proposta como árbitro</h2><label for="tr-arbitrar">Quanto do restante vai ao trabalhador? <b id="tr-arbitrar-v">50%</b></label><input type="range" id="tr-arbitrar" min="0" max="100" value="50">${botaoSegurar("enviar proposta de árbitro", "tr-arbitrar")}<p class="mudo">Se o outro árbitro propuser o mesmo número, a divisão acontece na hora.</p>` : ""}
    ${acoes.includes("desempatar") ? `<h2>⚖️ Desempate do criador</h2><label for="tr-desempate">Ao trabalhador: <b id="tr-desempate-v">${Math.round((lim[0] + lim[1]) / 200)}%</b> (entre ${lim[0] / 100}% e ${lim[1] / 100}%)</label><input type="range" id="tr-desempate" min="${Math.ceil(lim[0] / 100)}" max="${Math.floor(lim[1] / 100)}" value="${Math.round((lim[0] + lim[1]) / 200)}">${botaoSegurar("desempatar", "tr-desempatar")}` : ""}
    ${acoes.includes("proporAcordo") ? `<label for="tr-acordo">Proposta: quanto do restante vai ao trabalhador? <b id="tr-acordo-v">50%</b></label><input type="range" id="tr-acordo" min="0" max="100" value="50">${botaoSegurar("propor acordo", "tr-acordo")}` : ""}
    ${acoes.includes("avaliar") ? `<h2>Avalie a outra parte</h2><div class="estrelas" role="group" aria-label="Estrelas">${[1, 2, 3, 4, 5].map((n) => `<button data-estrela="${n}" aria-label="${n} estrelas">★</button>`).join("")}</div>${botaoSegurar("enviar avaliação", "tr-avaliar")}` : ""}
    ${acoes.filter((a) => ROTULOS[a]).map((a) => (["abrirDisputa", "desistir", "cancelar", "recusarCandidato"].includes(a) ? `<button class="btn perigo segurar" data-confirmar="tr-${a}"><i>👉 Deslize para ${esc(ROTULOS[a])}</i></button>` : botaoSegurar(ROTULOS[a], `tr-${a}`))).join("")}
    ${acoes.length === 0 ? `<p class="mudo">Nenhuma ação disponível para você agora.</p>` : ""}
    <button class="btn sec" data-ir="TRABALHOS">Voltar</button>`);
  for (const n of ["acordo", "arbitrar", "desempate"]) $(`#tr-${n}`)?.addEventListener("input", (ev) => ($(`#tr-${n}-v`).textContent = `${ev.target.value}%`));
  // Ao vivo: pedidos sem gás da outra parte e mudanças do trabalho (sem redesenhar o que a pessoa digita)
  const foto = fotoTrabalho(t);
  const vivo = async () => {
    const agora = await S.escrow.detalhe(id).catch(() => null);
    if (!agora || S.tela !== "TRABALHO" || String(S.params.id) !== String(id)) return;
    const digitando = document.activeElement?.matches?.("input,textarea,select");
    if (fotoTrabalho(agora) !== foto && !digitando) return render();
    await mostrarCorreio($("#correio"), [agora], cor);
    if (cor) corridaViva().catch(() => {}); // mantém lembrada (para voltar depois de fechar o app)
    if (cor && agora.estado === 1) await mostrarCancelamento(agora, souCliente);
    if (cor && agora.estado === 1) {
      if (agora.trabalhador.toLowerCase() === S.endereco.toLowerCase()) await enviarMinhaPosicao(agora);
      else if (souCliente) await mostrarMotoristaNoMapa(agora, coordenadasNoTexto(enderecoGuardado || "")[0]);
    }
  };
  const mot = t.trabalhador !== E.ZeroAddress ? t.trabalhador : t.candidato;
  const perfilMot = cor && mot ? vit()?.motorista(mot) : null;
  if (perfilMot?.fotos?.length) vit().fotos(perfilMot).then((u) => { const b = $("#cor-foto-mot"); if (b && u[0]) b.innerHTML = `<img src="${u[0]}" alt="Foto do motorista">`; }).catch(() => {});
  if ($("#rota")) carregarRota(t);
  if ($("#contato") && S.chat) {
    // Contato: chega cifrado pelo avisador; o meu é reenviado a cada 6 h (o avisador guarda por 12 h)
    const f = lerFicha(t.id);
    if (f.postadoEm && Date.now() - f.postadoEm > 6 * 3600_000) enviarContato(S.params.t, true).catch(() => {});
    else if (!f.postadoEm && f.auto) enviarContato(S.params.t, true).then((ok) => ok && toast("📤 Seu contato foi para a outra parte")).catch(() => {});
    receberContato(S.params.t).then((novo) => { if (novo && S.tela === "TRABALHO" && String(S.params.id) === String(t.id)) { $("#contato").outerHTML = blocoContato(S.params.t, souCliente); toast("📞 Chegou o contato da outra pessoa"); } }).catch(() => {});
  }
  if ($("#cor-gorjeta-v")) ligarMaximo("#cor-gorjeta-v", saldoBrls);
  vivo().catch(() => {});
  vigiar("TRABALHO", vivo, 12000);
};

/** Partes da corrida na tela do trabalho: motorista, mapa, segurança, cancelamento, contraproposta, gorjeta. */
function blocoCorrida(t, souCliente) {
  const z = E.ZeroAddress;
  const mot = t.trabalhador !== z ? t.trabalhador : t.candidato && t.candidato !== z ? t.candidato : null;
  const p = [];
  if (mot && souCliente) {
    p.push(`<div class="cartao motorista"><p class="mudo" style="margin:0">${t.pendenteAprovacao ? "🙋 Quer fazer sua corrida:" : "🚗 Seu motorista:"}</p><div id="cor-foto-mot" class="fotos mini"></div><p>${linhaMotorista(mot)}</p>${t.estado === 1 && !t.chegou ? `<p class="aviso" style="margin:0">Confira o carro e a placa antes de entrar.</p>` : ""}</div>`);
  }
  if (t.estado === 1) {
    if (souCliente) p.push(`<div id="cor-mapa"></div><p class="mudo" id="cor-eta">${t.chegou ? "" : "A posição do motorista aparece aqui quando ele estiver a caminho (cifrada, só você vê)."}</p>`);
    p.push(`<div class="grade duas"><button class="btn sec" data-acao="cor-compartilhar">📤 Compartilhar corrida</button><a class="btn perigo" href="tel:190">🚨 Emergência 190</a></div>`);
    p.push(`<div id="cor-cancel"></div>`);
    if (souCliente) p.push(`<button class="btn sec" data-acao="cor-cancelar">Cancelar a corrida</button>`);
  }
  if (t.estado === 3 && !souCliente && t.propostaCliente) {
    const bps = Number(t.propostaCliente) - 1;
    p.push(`<div class="cartao correio destaque"><h2 style="margin-top:0">O passageiro pediu para cancelar</h2><p>Ele propõe <b>${bps / 100}%</b> do valor para você (R$ ${fmt((t.valor * BigInt(bps)) / 10000n)}). Aceitando, o contrato divide na hora.</p>${botaoSegurar("aceitar o cancelamento", "cor-acordo-aceitar")}<p class="mudo">Não concorda? Faça outra proposta abaixo; sem acordo, em 30 dias divide meio a meio.</p></div>`);
  }
  if (t.estado === 0 && !souCliente && !t.pendenteAprovacao && t.trabalhador === z) {
    const sug = (Number(E.formatUnits(t.valor, 18)) * 1.2).toFixed(2);
    p.push(`<details class="cartao"><summary><b>💬 Achou baixo? Faça uma contraproposta</b></summary><label for="tr-contra">Seu preço (R$)</label><input id="tr-contra" inputmode="decimal" value="${esc(brNum(sug))}"><button class="btn sec" data-acao="tr-contra-enviar">Enviar contraproposta</button><p class="mudo">O passageiro vê no app e decide. Se aceitar, a corrida vem direto para você.</p></details>`);
  }
  if (t.estado === 4 && souCliente && t.trabalhador !== z) {
    const fav = lerFavoritos().some((f) => f.conta.toLowerCase() === t.trabalhador.toLowerCase());
    p.push(`<div class="cartao"><h2 style="margin-top:0">💛 Gorjeta (opcional)</h2><input id="cor-gorjeta-v" inputmode="decimal" placeholder="0,00">${botaoSegurar("enviar a gorjeta", "cor-gorjeta")}${fav ? `<p class="mudo">⭐ Este motorista já é seu favorito.</p>` : `<button class="btn sec" data-acao="cor-favoritar">⭐ Favoritar este motorista</button>`}</div>`);
  }
  return p.join("");
}

/** Detalhes públicos do trabalho: tudo depois da 1ª linha da descrição. */
const detalhesDesc = (d) => String(d || "").split("\n").slice(1).join("\n").trim();

// ---------- Contato direto: WhatsApp, sala do Jitsi, links (Drive etc.) ----------
// Nada disso vai para a blockchain em texto claro: vai CIFRADO (ECDH da conversa) pelo avisador, de graça,
// e fica guardado no aparelho de cada um. Alternativa permanente: mandar pela conversa cifrada (custa gás).
const PREFIXO_CONTATO = "brlscontato:";
const chaveFicha = (id) => `xbrl.contato.${S.chainId}.${S.imp?.EscrowTrabalho}.${id}`;
function lerFicha(id) { try { return JSON.parse(localStorage.getItem(chaveFicha(id)) || "null") || { meu: {}, deles: {} }; } catch { return { meu: {}, deles: {} }; } }
function gravarFicha(id, f) { try { localStorage.setItem(chaveFicha(id), JSON.stringify(f)); } catch { /* sem armazenamento */ } }
const meuWhatsSalvo = () => { try { return localStorage.getItem("xbrl.meu.whatsapp") || ""; } catch { return ""; } };
/** Número de WhatsApp só com dígitos, com o 55 do Brasil se faltar. "" se não parece um número. */
function normalizarWhats(txt) {
  let d = String(txt || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return d.length >= 12 && d.length <= 15 ? d : "";
}
const whatsBonito = (d) => (d.startsWith("55") && d.length >= 12 ? `+55 (${d.slice(2, 4)}) ${d.slice(4, -4)}-${d.slice(-4)}` : `+${d}`);
/** Link que abre a conversa no WhatsApp (Android e iPhone). A ligação é um toque lá dentro. */
const linkWhats = (num, texto) => `https://wa.me/${num}?text=${encodeURIComponent(texto)}`;
function linkSeguro(u) {
  try { const x = new URL(String(u).trim()); return x.protocol === "https:" && x.href.length <= 400 ? x.href : ""; } catch { return ""; }
}
function iconeLink(u) {
  const h = (() => { try { return new URL(u).hostname; } catch { return ""; } })();
  if (/(^|\.)meet\.jit\.si$|jitsi/.test(h)) return ["🎥", "Sala de vídeo (Jitsi)"];
  if (/drive\.google|docs\.google/.test(h)) return ["📁", "Google Drive"];
  if (/meet\.google|zoom\.us|teams\./.test(h)) return ["🎥", "Sala de vídeo"];
  if (/dropbox|onedrive|1drv|wetransfer/.test(h)) return ["📁", "Arquivos"];
  if (/github|gitlab|figma|notion|canva|trello/.test(h)) return ["🧩", h.replace(/^www\./, "")];
  return ["🔗", h.replace(/^www\./, "")];
}
function novaSalaJitsi(id) {
  const r = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `https://meet.jit.si/BRLS-${id}-${r}`;
}
/** Botão de link externo. No APK, quem abre é a Caixa Forte (data-externo). */
const botaoLink = (u, rotulo, classe = "btn sec") => `<a class="${classe}" href="${esc(u)}" target="_blank" rel="noopener noreferrer" data-externo="${esc(u)}">${rotulo}</a>`;
/** Transforma https://… em links clicáveis num texto JÁ escapado. */
const comLinks = (html) => html.replace(/https:\/\/[^\s<>"'`]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer" data-externo="${u}">${u}</a>`);

/** A outra parte do trabalho (endereço e tx onde a chave pública dela aparece). */
function outraParte(t) {
  const souCliente = t.cliente.toLowerCase() === S.endereco.toLowerCase();
  return souCliente ? { conta: t.trabalhador, txs: t.txAceite ? [t.txAceite] : [] } : { conta: t.cliente, txs: t.txCriacao ? [t.txCriacao] : [] };
}
/** Manda o meu contato cifrado para a outra parte, pelo avisador (de graça). */
async function enviarContato(t, silencioso = false) {
  const f = lerFicha(t.id);
  if (!f.meu.wa && !(f.meu.links || []).length && !f.meu.det) { if (!silencioso) throw new Error("Preencha o WhatsApp ou um link antes de compartilhar"); return false; }
  const o = outraParte(t);
  const pub = await S.chat.chaveDe(o.conta, o.txs);
  if (!pub) { if (!silencioso) throw new Error("Ainda não achei a chave da outra pessoa. Use \"Enviar pela conversa cifrada\"."); return false; }
  const cif = await cifrarChat(S.carteira, pub, JSON.stringify({ ...f.meu, em: agora() }));
  const ok = await CO.postarTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), PREFIXO_CONTATO + cif).then(() => true).catch(() => false);
  if (!ok) { if (!silencioso) throw new Error("O avisador não respondeu. Use \"Enviar pela conversa cifrada\"."); return false; }
  f.postadoEm = Date.now();
  gravarFicha(t.id, f);
  return true;
}
/** Lê o contato da outra parte (avisador, cifrado) e guarda no aparelho. */
async function receberContato(t) {
  const textos = await CO.lerTopico(CO.topico(S.chainId, S.imp.EscrowTrabalho, t.id), "12h", PREFIXO_CONTATO).catch(() => []);
  if (!textos.length) return false;
  const o = outraParte(t);
  const pub = await S.chat.chaveDe(o.conta, o.txs);
  if (!pub) return false;
  const f = lerFicha(t.id);
  let mudou = false;
  for (const x of textos) {
    try {
      const d = JSON.parse((await decifrarChat(S.carteira, pub, x.slice(PREFIXO_CONTATO.length))).texto);
      if (!(d.em > (f.deles.em || 0))) continue;
      f.deles = { wa: normalizarWhats(d.wa), links: (Array.isArray(d.links) ? d.links : []).map((l) => ({ t: String(l.t || "").slice(0, 40), u: linkSeguro(l.u) })).filter((l) => l.u).slice(0, 8), det: String(d.det || "").slice(0, 1000), em: Number(d.em) };
      mudou = true;
    } catch { /* não é para mim */ }
  }
  if (mudou) gravarFicha(t.id, f);
  return mudou;
}
/** Cartão "Contato direto" no trabalho (depois que alguém foi confirmado). */
function blocoContato(t, souCliente) {
  const f = lerFicha(t.id);
  const remoto = t.modalidade === 2 || t.modalidade === 3;
  const quem = souCliente ? "quem vai fazer" : "quem contratou";
  const nome = souCliente ? "o trabalhador" : "o contratante";
  const msgWa = `Olá! Aqui é ${souCliente ? "quem contratou" : "quem vai fazer"} o trabalho #${t.id} no BRLS.`;
  const deles = f.deles || {};
  const recebido = deles.wa || (deles.links || []).length || deles.det;
  const meuWa = f.meu.wa || meuWhatsSalvo();
  const meusLinks = f.meu.links || [];
  return `<div class="cartao contato" id="contato">
    <h2 style="margin-top:0">📞 Falar direto com ${esc(nome)}</h2>
    ${recebido ? `
      ${deles.wa ? `${botaoLink(linkWhats(deles.wa, msgWa), `💬 Chamar no WhatsApp · ${esc(whatsBonito(deles.wa))}`, "btn prim whats")}<p class="mudo">Abre a conversa no WhatsApp (Android e iPhone). Para ligar, é só tocar no telefone lá dentro.</p>` : ""}
      ${(deles.links || []).map((l) => { const [ic, r] = iconeLink(l.u); return botaoLink(l.u, `${ic} ${esc(l.t || r)}`); }).join("")}
      ${deles.det ? `<p class="detalhes-priv">${comLinks(esc(deles.det))}</p>` : ""}`
    : `<p class="mudo">Quando ${esc(nome)} compartilhar o WhatsApp ou um link, ele aparece aqui.</p>`}
    <details ${f.postadoEm ? "" : "open"}><summary><b>${f.postadoEm ? "✅ Você já compartilhou o seu contato" : "Compartilhe o seu contato"}</b></summary>
      <label for="ct-wa">Seu WhatsApp (só ${esc(quem)} vê)</label><input id="ct-wa" inputmode="tel" autocomplete="tel" placeholder="(31) 99999-9999" value="${esc(meuWa ? whatsBonito(normalizarWhats(meuWa) || meuWa) : "")}">
      <label class="linha" style="color:var(--txt)"><span>Lembrar o meu WhatsApp neste aparelho</span><input type="checkbox" id="ct-lembrar" style="width:auto" ${meuWhatsSalvo() ? "checked" : ""}></label>
      <p class="rotulo-ponto">${remoto ? "Sala de reunião e arquivos" : "Links (opcional)"}</p>
      ${remoto ? `<p class="mudo">Sugestão: faça as reuniões no <b>Jitsi Meet</b>: grátis, sem cadastro, funciona no navegador e no app. Um toque cria a sala deste trabalho.</p>` : ""}
      <div id="ct-links">${meusLinks.map((l, i) => { const [ic, r] = iconeLink(l.u); return `<div class="linha"><span>${ic} ${esc(l.t || r)}</span><button type="button" class="btn sec mini" data-acao="ct-tirar-${i}">Tirar</button></div>`; }).join("")}</div>
      <button type="button" class="btn sec" data-acao="ct-jitsi">🎥 Criar sala no Jitsi</button>
      <div class="grade duas"><input id="ct-link" inputmode="url" autocapitalize="none" spellcheck="false" placeholder="https://drive.google.com/…"><button type="button" class="btn sec" data-acao="ct-add-link">+ Link</button></div>
      <label for="ct-det">Recado/detalhes só para ${esc(quem)} (opcional)</label><textarea id="ct-det" rows="3" maxlength="1000" placeholder="Ex.: horário, ponto de referência, o que levar…">${esc(f.meu.det || "")}</textarea>
      <button type="button" class="btn prim" data-acao="ct-compartilhar">📤 Compartilhar com ${esc(nome)} (cifrado, grátis)</button>
      <button type="button" class="btn sec" data-acao="ct-pela-conversa">🔒 Enviar pela conversa cifrada (fica guardado para sempre, custa a taxa)</button>
    </details>
  </div>`;
}
/** Lê o formulário de contato para a ficha (sem enviar). */
function guardarFormContato(t) {
  const f = lerFicha(t.id);
  const bruto = $("#ct-wa")?.value || "";
  const wa = normalizarWhats(bruto);
  if (bruto.trim() && !wa) throw new Error("WhatsApp inválido: use DDD + número, ex.: (31) 99999-9999");
  f.meu.wa = wa;
  f.meu.det = ($("#ct-det")?.value || "").trim().slice(0, 1000);
  gravarFicha(t.id, f);
  try { if ($("#ct-lembrar")?.checked && wa) localStorage.setItem("xbrl.meu.whatsapp", wa); else if (!$("#ct-lembrar")?.checked) localStorage.removeItem("xbrl.meu.whatsapp"); } catch { /* ok */ }
  return f;
}

const fotoTrabalho = (t) => [t.estado, t.trabalhador, t.candidato, t.chegou, t.encerrado, t.pendenteAprovacao].join("|");

/** Rótulos dos pontos de um texto de endereço (corrida: embarque e destino). */
const rotulosPontos = (texto) => {
  const t = String(texto || "");
  if (t.includes("Embarque:")) return ["🟢 Embarque", "🏁 Destino"];
  if (t.includes("Retirada:")) return ["🏪 Retirada na loja", "🏁 Entrega no cliente"];
  return ["📍 Local"];
};
/** Ícone e texto de um trabalho: se a descrição já começa com emoji (vitrine, corrida), usa o dela. Só a 1ª linha (o resto são os detalhes). */
function iconeDesc(descricao, m) {
  const d = String(descricao || m.nome).split("\n")[0];
  const e = /^(\p{Extended_Pictographic}\uFE0F?)\s*/u.exec(d);
  return e && !d.startsWith("📍") ? [esc(e[1]), d.slice(e[0].length)] : [m.icone, d];
}

/** Trabalhador/motorista: os pontos exatos (que chegaram cifrados na conversa) com botões de GPS. */
async function carregarRota(t) {
  if (!S.chat) return;
  try {
    const msgs = await S.chat.ler(idConversa(S.imp.EscrowTrabalho, t.id), S.carteira);
    const m = [...msgs].reverse().find((x) => x.de.toLowerCase() === t.cliente.toLowerCase() && coordenadasNoTexto(x.texto).length);
    const box = $("#rota");
    if (!box) return;
    box.innerHTML = m
      ? `<div class="cartao rota"><h2 style="margin-top:0">🧭 Ir até lá</h2><p class="mudo" style="white-space:pre-line">${esc(m.texto)}</p>${botoesGps(m.texto, rotulosPontos(m.texto))}</div>`
      : `<p class="mudo">📍 Assim que ${lerCorrida(S.escrow.resumoTrabalhos().get(String(t.id))?.descricao) ? "o passageiro" : "o cliente"} mandar o endereço (cifrado), os botões de GPS aparecem aqui.</p>`;
  } catch { /* conversa ainda não ativada */ }
}

// ---------- Pedidos sem gás que chegam pelo correio (correio.js) ----------
async function pedidosNoCorreio(t) {
  if (!S.imp?.Encaminhador || t.encerrado || t.estado >= 4) return [];
  const eu = S.endereco.toLowerCase();
  const souCliente = t.cliente.toLowerCase() === eu;
  const souTrab = [t.trabalhador, t.candidato].some((a) => a && a.toLowerCase() === eu);
  if (!souCliente && !souTrab) return [];
  const textos = await CO.ler(S.chainId, S.imp.EscrowTrabalho, t.id).catch(() => []);
  const it = new E.Interface(ABIS.EscrowTrabalho);
  const out = [];
  for (const texto of textos) {
    if (CO.jaResolvido(texto)) continue;
    try {
      const d = SG.decodificar(texto);
      const de = d.pedidos[0].from;
      if (de.toLowerCase() === eu || d.pedidos.some((p) => p.from.toLowerCase() !== de.toLowerCase())) continue;
      let aceitar = false;
      for (const p of d.pedidos) {
        if (p.to.toLowerCase() !== S.imp.EscrowTrabalho.toLowerCase()) continue;
        const f = it.parseTransaction({ data: p.data });
        if (String(f.args[0]) !== String(t.id)) throw new Error("outro trabalho");
        if (f.name === "aceitar") aceitar = true;
      }
      // Só a outra parte (ou, numa vaga aberta, quem quer aceitar) pode pedir aqui
      const outraParte = souCliente ? [t.trabalhador, t.candidato].some((a) => a && a.toLowerCase() === de.toLowerCase()) : de.toLowerCase() === t.cliente.toLowerCase();
      if (!outraParte && !(aceitar && souCliente)) continue;
      const descricoes = d.pedidos.map((p) => SG.descrever(p, S.imp));
      await SG.conferir(S.provider, S.imp, d);
      const rep = aceitar ? await S.escrow.reputacao(de).catch(() => null) : null;
      out.push({ texto, d, de, aceitar, descricoes, rep });
    } catch { /* inválido, vencido ou já usado: não mostra */ }
  }
  return out;
}

/** Desenha os avisos de pedidos sem gás de vários trabalhos num container (só troca se mudou). */
async function mostrarCorreio(box, trabalhos, corForcada) {
  if (!box) return;
  const partes = [];
  for (const t of trabalhos) {
    const itens = await pedidosNoCorreio(t);
    const cor = corForcada ?? lerCorrida(S.escrow.resumoTrabalhos().get(String(t.id))?.descricao);
    for (const item of itens) partes.push(cartaoCorreio(t, item, cor));
  }
  const html = partes.join("");
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
    ligarSegurar(box);
    if (html) avisarNovoPedido(partes.length === 1 && html.includes("quer fazer sua corrida") ? "🙋 Um motorista quer fazer sua corrida!" : "📨 Pedido da outra parte esperando você");
  }
}

function cartaoCorreio(t, item, cor) {
  const souCliente = t.cliente.toLowerCase() === S.endereco.toLowerCase();
  const k = E.id(item.texto).slice(2, 14);
  S.correio ||= new Map();
  S.correio.set(k, { item, t, cor });
  const quem = cor ? (souCliente ? "O motorista" : "O passageiro") : souCliente ? "O trabalhador" : "O cliente";
  if (item.aceitar && souCliente) {
    const r = item.rep;
    const precisaAprovar = t.modalidade !== 1 && t.trabalhador === E.ZeroAddress;
    return `<div class="cartao correio destaque">
      <h2 style="margin-top:0">🙋 ${cor ? "Um motorista quer fazer sua corrida" : "Alguém quer aceitar seu trabalho"}</h2>
      ${cor ? `<p>${linhaMotorista(item.de)}</p>` : ""}
      <div class="linha"><span>${esc(curto(item.de))}</span><span>${r ? `${estrelasNivel(r.nivel)} <b>${esc(r.nomeNivel)}</b> <small class="mudo">${Number(r.contrapartes)} ${Number(r.contrapartes) === 1 ? "pessoa" : "pessoas"} · ${r.idadeDias} dias</small>` : ""}</span></div>
      <p>${cor ? "Ele" : "A pessoa"} está <b>sem POL</b> para a taxa da rede. Se você aceitar, o seu app envia o pedido ${cor ? "dele" : "dela"} (você paga a taxa, centavos)${precisaAprovar ? ` e já ${cor ? "aprova ele como seu motorista" : "aprova a pessoa"}` : ""}.${t.kitGas > 0n ? ` O gás que você deixou (${fmt(t.kitGas, 18, 2)} POL) vai para ${cor ? "ele" : "ela"}, para não travar no caminho.` : ""}</p>
      ${botaoSegurar(cor ? "aceitar este motorista" : "aceitar esta pessoa", `correio-aceitar:${k}`)}
      <button class="btn sec" data-acao="correio-recusar" data-k="${esc(k)}">Recusar</button></div>`;
  }
  return `<div class="cartao correio destaque">
    <h2 style="margin-top:0">📨 ${quem} está sem POL</h2>
    <p>Pediu para você enviar por ${cor && souCliente ? "ele" : "ela"}:</p>${item.descricoes.map((x) => `<p>• ${esc(x)}</p>`).join("")}
    <p class="mudo">Você paga só a taxa da rede (centavos). Nenhum dinheiro seu é usado na ação.</p>
    ${botaoSegurar("enviar por " + (cor && souCliente ? "ele" : "ela"), `correio-enviar:${k}`)}
    <button class="btn sec" data-acao="correio-recusar" data-k="${esc(k)}">Agora não</button></div>`;
}

async function enviarDoCorreio(nome) {
  const [tipo, k] = nome.split(":");
  const x = S.correio?.get(k);
  if (!x) throw new Error("Esse pedido não está mais aqui. Atualize a tela.");
  const { item, t, cor } = x;
  await SG.conferir(S.provider, S.imp, item.d);
  const passos = SG.passosParaEnviar(S.carteira, S.imp, item.d);
  const atual = await S.escrow.detalhe(t.id);
  if (tipo === "correio-aceitar" && atual.modalidade !== 1 && atual.trabalhador === E.ZeroAddress) passos.push(passoEscrow(cor ? "Aprovar como seu motorista" : "Aprovar", "decidirCandidato", [BigInt(t.id), true]));
  await executar(tipo === "correio-aceitar" ? (cor ? "Aceitar motorista" : "Aceitar pessoa") : "Enviar pela outra pessoa", passos);
  CO.resolver(item.texto);
  S.correio.delete(k);
}

// ---------- Conversa ----------
function participantes(t) {
  const z = E.ZeroAddress;
  return [t.cliente, t.trabalhador, t.arbitroCliente, t.arbitroTrabalhador].filter((a) => a && a !== z);
}
function papelDe(t, a) {
  const x = a.toLowerCase();
  if (x === S.endereco.toLowerCase()) return "Você";
  if (x === t.cliente.toLowerCase()) return "Cliente";
  if (x === t.trabalhador.toLowerCase()) return "Trabalhador";
  if (x === CREATOR_TREASURY.toLowerCase()) return "Criador da rede";
  return "Árbitro";
}

TELAS.CHAT = async () => {
  const t = S.params.t;
  tela(`<h1>💬 Conversa</h1><div class="cartao"><div class="giro"></div><p class="mudo">Abrindo mensagens cifradas…</p></div>`);
  const conversa = idConversa(S.imp.EscrowTrabalho, t.id);
  const msgs = await S.chat.ler(conversa, S.carteira);
  const quem = participantes(t);
  tela(`
    <h1>💬 Conversa do trabalho #${esc(t.id)}</h1>
    <p class="mudo">Cifrada de ponta a ponta: só ${quem.length > 2 ? "as partes e os árbitros" : "vocês dois"} conseguem ler. Cada mensagem é uma pequena transação (custa um pouco de POL) e fica guardada para sempre, servindo de registro numa disputa.</p>
    <div class="cartao" id="chat-lista" style="max-height:55vh;overflow:auto">
      ${msgs.map((m) => `<div class="msg ${m.de.toLowerCase() === S.endereco.toLowerCase() ? "minha" : ""}"><small class="mudo">${esc(papelDe(t, m.de))}${m.em ? " · " + new Date(m.em * 1000).toLocaleString("pt-BR") : ""}</small><p>${comLinks(esc(m.texto))}</p>${botoesGps(m.texto, rotulosPontos(m.texto))}</div>`).join("") || `<p class="mudo">Nenhuma mensagem ainda. Diga olá! 👋</p>`}
    </div>
    <label for="chat-txt">Mensagem</label><textarea id="chat-txt" maxlength="${MAX_CARACTERES}" placeholder="Ex.: Estou chegando em 10 minutos"></textarea>
    <button class="btn prim" data-acao="chat-enviar">Enviar mensagem</button>
    <button class="btn sec" data-acao="chat-atualizar">↻ Atualizar</button>
    <button class="btn sec" data-acao="chat-voltar">Voltar ao trabalho</button>`);
  const l = $("#chat-lista");
  l.scrollTop = l.scrollHeight;
};

TELAS.AJUSTES = async () => {
  const bioDisp = await K.biometriaDisponivel();
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const redes = Object.values(REDES).filter((r) => !r.somenteDev || local);
  tela(`
    <h1>Ajustes</h1>
    <label for="aj-rede">Rede</label>
    <select id="aj-rede">${redes.map((r) => `<option value="${r.chainId}" ${r.chainId === S.chainId ? "selected" : ""}>${esc(r.nome)}</option>`).join("")}</select>
    ${S.externa ? `<div class="cartao ok"><b>🔌 Conectada pela ${esc(S.externa.nome)}</b><p class="mudo">As chaves ficam na ${esc(S.externa.nome)}: é lá que você confirma cada operação, tranca a carteira e guarda as palavras.</p></div>` : `
    <div class="cartao">
      <div class="linha"><span>Biometria (chave no chip)</span><b>${K.temBiometria() ? "ativada" : bioDisp ? "disponível" : "indisponível"}</b></div>
      ${bioDisp && !K.temBiometria() ? `<button class="btn sec" data-acao="bio-ativar">👆 Ativar biometria</button>` : ""}
      ${K.temBiometria() ? `<button class="btn sec" data-acao="bio-desativar">Desativar biometria</button>` : ""}
    </div>
    <button class="btn sec" data-ir="BACKUP">🔑 Ver minhas palavras</button>
    <button class="btn sec" data-acao="trocar-pin">🔢 Trocar PIN</button>
    <button class="btn sec" data-acao="bloquear">🔒 Bloquear agora</button>`}
    <div class="cartao">
      <h2 style="margin-top:0">Sobre</h2>
      <div class="linha"><span>Versão</span><b>${esc(VERSAO)}</b></div>
      <div class="linha"><span>Sua carteira</span><a href="${esc(linkExplorer(S.chainId, "address", S.endereco))}" target="_blank" rel="noopener">${esc(curto(S.endereco))}</a></div>
      ${S.imp ? [["xBRL", "Moeda BRLS"], ["ReservaBRL", "Reserva"], ["CofreCripto", "Cofre cripto"], ["EscrowTrabalho", "Trabalhos"], ["Mensageiro", "Conversas"], ["Encaminhador", "Envio sem gás"]].filter(([n]) => S.imp[n]).map(([n, rotulo]) => `<div class="linha"><span>${rotulo}</span><a href="${esc(linkExplorer(S.chainId, "address", S.imp[n]))}" target="_blank" rel="noopener">${esc(curto(S.imp[n]))}</a></div>`).join("") : ""}
      <div class="linha"><span>Taxa vitalícia 0,1% para</span><span>${esc(curto(CREATOR_TREASURY))}</span></div>
    </div>
    ${S.externa ? "" : `<h2>Zona de perigo</h2>
    <label for="aj-apagar">Para apagar a carteira deste aparelho, digite APAGAR</label><input id="aj-apagar" autocomplete="off">
    <button class="btn perigo segurar" data-confirmar="apagar"><i>👉 Deslize para apagar deste aparelho</i></button>
    <p class="mudo">Apagar não mexe no dinheiro: ele continua na blockchain e volta com as suas palavras.</p>`}`);
  $("#aj-rede").addEventListener("change", async (ev) => {
    const id = Number(ev.target.value);
    localStorage.setItem("xbrl.rede", String(id));
    await conectarRede(id);
    toast(`Rede: ${REDES[id].nome}`);
    ir("INICIO");
  });
};

TELAS.BACKUP = () =>
  tecladoPin("Confirme o PIN", "Para mostrar as suas palavras.", async (pin) => {
    const frase = await K.abrirComPin(pin);
    const idioma = K.idiomaDaFrase(frase) === "pt" ? "em português" : "em inglês";
    tela(`<h1>Suas ${frase.split(" ").length} palavras</h1><p class="mudo">${idioma}</p><ol class="palavras">${frase.split(" ").map((w) => `<li>${esc(w)}</li>`).join("")}</ol>
      <div class="aviso">Não tire print. Anote no papel.</div><button class="btn prim" data-ir="AJUSTES">Pronto</button>`);
  });

async function render() {
  const f = TELAS[S.tela];
  if (!f) return;
  S.ocupado = (S.ocupado || 0) + 1;
  try {
    await f();
  } finally {
    S.ocupado -= 1;
  }
  // Link de pedido sem gás recebido (WhatsApp): abre assim que a carteira estiver desbloqueada.
  if (S.pedidoRecebido && S.carteira && ABERTAS.includes(S.tela)) {
    const txt = S.pedidoRecebido;
    S.pedidoRecebido = null;
    abrirPedidoSemGas(txt).catch(mostrarErro);
  }
}

// ----------------------------------------------------------------------------
// Ações (delegação de eventos)
// ----------------------------------------------------------------------------
document.addEventListener("click", async (ev) => {
  const alvo = ev.target.closest("[data-ir],[data-acao],[data-trabalho],[data-estrela]");
  if (!alvo) return;
  try {
    if (alvo.dataset.ir) return ir(alvo.dataset.ir);
    if (alvo.dataset.trabalho) return ir("TRABALHO", { id: alvo.dataset.trabalho });
    if (alvo.dataset.estrela) {
      S.params.estrelas = Number(alvo.dataset.estrela);
      $$(".estrelas button").forEach((b) => b.classList.toggle("on", Number(b.dataset.estrela) <= S.params.estrelas));
      return;
    }
    await acao(alvo.dataset.acao, alvo);
  } catch (e) {
    mostrarErro(e);
  }
});

document.addEventListener("confirmado", async (ev) => {
  try {
    await confirmar(ev.target.closest("[data-confirmar]").dataset.confirmar);
  } catch (e) {
    console.error(e);
    if ($("#modal").hidden) mostrarErro(e);
  }
});

$("#btn-bloquear").addEventListener("click", bloquear);

async function acao(nome, el) {
  if (nome?.startsWith("vit-cat-")) {
    S.vitrineFiltro.cat = nome.slice(8);
    $$(".cats button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.acao === nome)));
    return desenharVitrine();
  }
  if (nome?.startsWith("an-status-")) return mudarStatus(nome.slice(10));
  switch (nome) {
    case "oferecer-servico":
      return ir("ANUNCIAR", { cat: "servicos" });
    case "vit-anunciar-pix":
      return ir("ANUNCIAR", { cat: "pix" });
    case "an-editar":
      return ir("ANUNCIAR", { chave: S.params.chave });
    case "an-sacola":
      return adicionarNaSacola();
    case "an-mapa": {
      const p = await escolherPonto({ titulo: "📍 Marque o endereço exato", inicial: S.params.ponto });
      if (p) { S.params.ponto = p; desenharAcaoAnuncio(vit().item(S.params.chave)); }
      return;
    }
    case "na-pix-vendo":
    case "na-pix-compro":
      return ir("ANUNCIAR", { ...S.params, cat: "pix", lado: nome.slice(7) });
    case "na-spec-mais":
      return $("#na-specs").insertAdjacentHTML("beforeend", linhaSpec());
    case "na-var-mais":
      return $("#na-vars").insertAdjacentHTML("beforeend", linhaVar());
    case "na-opcao-mais":
      return $("#na-opcoes").insertAdjacentHTML("beforeend", linhaOpcao());
    case "na-bairro-mapa": {
      const p = await escolherPonto({ titulo: "📍 Onde fica (só o bairro aparece)" });
      if (p?.bairro) $("#na-bairro").value = p.bairro;
      return;
    }
    case "lj-mapa": {
      const p = await escolherPonto({ titulo: "📍 Endereço de retirada da loja", inicial: S.lojaPonto });
      if (!p) return;
      const vals = Object.fromEntries($$("#tela input, #tela textarea, #tela select").filter((x) => x.id).map((x) => [x.id, x.value]));
      S.lojaPonto = p;
      await render();
      for (const [id, v] of Object.entries(vals)) if ($(`#${id}`) && id !== "lj-foto") $(`#${id}`).value = v;
      if (p.bairro && !$("#lj-bairro").value) $("#lj-bairro").value = p.bairro;
      return;
    }
    case "sac-mapa": {
      const p = await escolherPonto({ titulo: "📍 Onde entregar", inicial: S.sacolaPonto });
      if (p) { S.sacolaPonto = p; render(); }
      return;
    }
    case "sac-tirar": {
      const s = lerSacola();
      s.itens.splice(Number(el.dataset.n), 1);
      gravarSacola(s);
      return render();
    }
    case "sac-limpar":
      gravarSacola({ loja: null, itens: [] });
      toast("Sacola limpa");
      return S.tela === "VITRINE" ? render() : ir("VITRINE");
    case "pix-recusar": {
      const p = S.pedidosPix?.get(el.dataset.k);
      if (p) CO.resolver(p.texto);
      el.closest(".correio")?.remove();
      return toast("Pedido recusado.");
    }
    case "loja-online": {
      const liga = !lojaOnline();
      try { localStorage.setItem("xbrl.loja.online", liga ? "1" : "0"); } catch { /* ok */ }
      if (liga) await pedirAvisos();
      atualizarPlantao();
      toast(liga ? "🔔 Você vai receber aviso de pedido novo" : "Avisos de pedido desligados");
      return render();
    }
    case "pix-copiar-pedido":
      await navigator.clipboard.writeText(S.pedidoPix || "");
      return toast("Pedido copiado: mande para o vendedor.");
    case "pix-colar-pedido": {
      const t = (prompt("Cole aqui o pedido que o comprador mandou") || "").trim();
      if (!t.startsWith(PREFIXO_P2P)) return toast("Isso não é um pedido Pix do BRLS.");
      (S.pedidosPixLocais ||= []).push(t);
      return mostrarPedidosPix($("#pix-pedidos"));
    }
    case "cor-mapa-de":
      return marcarPontoCorrida("de");
    case "cor-mapa-para":
      return marcarPontoCorrida("para");
    case "tn-mapa": {
      const p = await escolherPonto({ titulo: "📍 Onde é o serviço?", inicial: S.params.ponto });
      if (!p) return;
      S.params.ponto = p;
      const end = $("#tn-endereco");
      if (end && !end.value.trim()) end.value = [p.endereco, p.complemento].filter(Boolean).join(" · ").slice(0, 180);
      const reg = $("#tn-regiao");
      if (reg && !reg.value.trim() && p.bairro) reg.value = p.bairro.slice(0, 36);
      const info = $("#tn-ponto");
      if (info) info.textContent = `📍 Ponto marcado: ${fmtCoord(p.lat, p.lon)}. Confira o número e o complemento no campo acima.`;
      return;
    }
    case "correio-recusar": {
      const x = S.correio?.get(el.dataset.k);
      if (x) CO.resolver(x.item.texto);
      el.closest(".correio")?.remove();
      toast(x?.item.aceitar ? "Recusado. A corrida continua aberta para outros." : "Ok, não vou mostrar de novo.");
      return;
    }
    case "fechar-modal":
      S.pinRecente = null;
      fecharModal();
      if (ABERTAS.includes(S.tela)) render().catch(mostrarErro);
      return;
    case "cor-cat-moto":
    case "cor-cat-pop":
    case "cor-cat-plus": {
      const k = nome.slice(8);
      const l = S.corrida.categorias;
      S.corrida.categorias = l.includes(k) ? l.filter((x) => x !== k) : [...l, k];
      return desenharPrecos();
    }
    case "mot-online":
      S.motorista.online = !S.motorista.online;
      try { localStorage.setItem("xbrl.motorista.online", S.motorista.online ? "1" : "0"); } catch { /* ok */ }
      S.motorista.vistos = null;
      if (S.motorista.online) { S.motorista.aqui = await minhaPosicao(); await pedirAvisos(); }
      atualizarPlantao();
      return render();
    case "mot-filtros": {
      const f = { veiculo: $("#mf-veiculo").value, raio: Number($("#mf-raio").value), minKm: Number(String($("#mf-minkm").value).replace(",", ".")) || 0 };
      try { localStorage.setItem(CHAVE_FILTROS, JSON.stringify(f)); } catch { /* ok */ }
      S.motorista.vistos = null;
      toast("Filtros salvos");
      return render();
    }
    case "tf-salvar":
      gravarTarifas(lerTarifasDaTela());
      if (S.corrida) S.corrida.valorEditado = false;
      toast("Tarifas salvas");
      return ir("CORRIDA");
    case "tf-padrao":
      voltarTarifasPadrao();
      return render();
    case "contra-recusar": {
      const x = S.contras?.get(el.dataset.k);
      if (x) CO.resolver(x.texto);
      el.closest(".correio")?.remove();
      return toast("Contraproposta recusada");
    }
    case "cor-cancel-recusar":
      return recusarCancelamento(S.params.t);
    case "tr-contra-enviar":
      return enviarContraproposta();
    case "cor-compartilhar":
      return compartilharCorrida();
    case "cor-favoritar": {
      const t = S.params.t;
      const l = lerFavoritos().filter((f) => f.conta.toLowerCase() !== t.trabalhador.toLowerCase());
      const m = vit()?.motorista(t.trabalhador);
      l.push({ conta: t.trabalhador, nome: m ? `${m.apelido} · ${m.modelo} ${m.placa}` : curto(t.trabalhador) });
      gravarFavoritos(l);
      toast("⭐ Motorista favoritado: na próxima, chame ele direto em Mais opções.");
      return render();
    }
    case "cor-cancelar":
      modal(`<h2>Cancelar a corrida</h2><p>O motorista já aceitou. Proponha quanto ele recebe pelo tempo e pelo caminho que já fez (o resto volta para você). Se ele concordar, o contrato divide na hora. <b>Se ele não responder</b>, quando o prazo vencer (${esc(horaCurta(Number(S.params.t.prazo)))}) você pega 100% de volta sozinho.</p>
        <label for="cc-pct">Para o motorista: <b id="cc-pct-v">${S.params.t.chegou ? 50 : 20}%</b></label><input type="range" id="cc-pct" min="0" max="100" step="5" value="${S.params.t.chegou ? 50 : 20}">
        <p class="mudo">Sugestão: 20% se ele ainda está a caminho; mais se já chegou e esperou.</p>
        <p class="mudo">Pedir não custa nada (você só assina).</p>
        ${botaoSegurar("pedir o cancelamento", "cor-cancelar-ok")}<button class="btn sec" data-acao="fechar-modal">Voltar</button>`);
      $("#cc-pct")?.addEventListener("input", (ev) => ($("#cc-pct-v").textContent = ev.target.value + "%"));
      return;
    case "criar":
      S.frasePendente = null;
      return ir("CRIAR_FRASE");
    case "frase-12":
    case "frase-24":
    case "frase-en":
    case "frase-pt": {
      S.opcoesFrase ||= { n: 12, idioma: "en" };
      if (nome === "frase-12" || nome === "frase-24") S.opcoesFrase.n = nome === "frase-24" ? 24 : 12;
      else S.opcoesFrase.idioma = nome === "frase-pt" ? "pt" : "en";
      S.frasePendente = null; // nova frase com a escolha (a anterior nunca foi usada)
      return render();
    }
    case "restaurar":
      return ir("RESTAURAR");
    case "voltar-boas-vindas":
      S.frasePendente = null;
      return ir("BOAS_VINDAS");
    case "revelar":
      $("#palavras").classList.toggle("borrado");
      el.textContent = $("#palavras").classList.contains("borrado") ? "👁️ Mostrar palavras" : "🙈 Esconder palavras";
      return;
    case "rever-frase":
      return ir("CRIAR_FRASE");
    case "conferir": {
      const p = S.frasePendente.split(" ");
      const ok = S.params.posicoes.every((i) => K.normalizarFrase($(`#w${i}`).value) === p[i]);
      if (!ok) {
        $("#msg").innerHTML = `<div class="erro">Alguma palavra não confere. Veja de novo a sua anotação.</div>`;
        return;
      }
      return ir("DEFINIR_PIN");
    }
    case "rest-n-12":
    case "rest-n-15":
    case "rest-n-18":
    case "rest-n-21":
    case "rest-n-24":
      S.restN = Number(nome.slice(7));
      return render();
    case "rest-limpar":
      S.restPalavras = [];
      return render();
    case "restaurar-ok": {
      const campos = $$("#grade input");
      const vazio = campos.findIndex((c) => !c.value.trim());
      if (vazio >= 0) { $("#msg").innerHTML = `<div class="erro">Falta a palavra nº ${vazio + 1}.</div>`; campos[vazio].focus(); return; }
      const ruim = campos.findIndex((c) => !K.palavraExiste(c.value));
      if (ruim >= 0) { $("#msg").innerHTML = `<div class="erro">A palavra nº ${ruim + 1} ("${esc(campos[ruim].value.trim())}") não existe na lista. Confira a escrita.</div>`; campos[ruim].focus(); return; }
      const f = campos.map((c) => c.value.trim()).join(" ");
      const problema = K.problemaDaFrase(f);
      if (problema) {
        $("#msg").innerHTML = `<div class="erro">${esc(problema)}</div>`;
        return;
      }
      S.frasePendente = K.normalizarFrase(f);
      S.restPalavras = []; // não deixa as palavras na memória da tela
      return ir("DEFINIR_PIN");
    }
    case "esqueci":
      modal(`<h2>Restaurar com as palavras?</h2><p>Isso apaga a carteira cifrada deste aparelho. Seu dinheiro fica intacto e volta com as suas palavras (12 ou 24).</p>
        <button class="btn perigo segurar" data-confirmar="esqueci"><i>👉 Deslize para continuar</i></button><button class="btn sec" data-acao="fechar-modal">Cancelar</button>`);
      return;
    case "biometria": {
      const frase = await K.abrirComBiometria();
      abrirSessao(frase);
      ir("INICIO");
      return aoEntrar();
    }
    case "atualizar":
      return render();
    case "bloquear":
      return bloquear();
    case "copiar-end":
      await navigator.clipboard.writeText(S.endereco);
      return toast("Endereço copiado");
    case "compartilhar-end":
      if (navigator.share) return navigator.share({ title: "Meu endereço BRLS (Polygon)", text: S.endereco });
      await navigator.clipboard.writeText(S.endereco);
      return toast("Endereço copiado");
    case "modo-emitir":
    case "modo-resgatar":
      return ir("RESERVA", { modo: nome.slice(5) });
    case "torneira": {
      const l = S.params.lastros[0];
      await executar(`Torneira ${l.simbolo}`, [{ rotulo: "Pegar moedas de teste", fn: (o) => erc20(l.endereco, true).torneira(o) }]);
      return;
    }
    case "aba-meus":
    case "aba-vagas":
    case "aba-arbitragens":
      return ir("TRABALHOS", { aba: nome.slice(4) });
    case "ext-todos":
    case "ext-xbrl":
    case "ext-outras":
      return ir("EXTRATO", { filtro: nome.slice(4) });
    case "ext-atualizar":
      return render();
    case "beta-resgatar": {
      const v = S.params.saldoBeta;
      const rb = new E.Contract(S.beta.ReservaBRL, ABIS.ReservaBRL, S.carteira);
      let lastro = S.beta.lastros[0];
      for (const l of S.beta.lastros) {
        const [pago] = await rb.cotarResgate(l, v).catch(() => [0n]);
        if (pago > 0n && (await erc20(l).balanceOf(S.beta.ReservaBRL)) >= pago) {
          lastro = l;
          break;
        }
      }
      // Troca completa: resgata a beta no lastro e emite BRLS novo com o que voltou (2 taxas de 0,1%).
      const [pago] = await rb.cotarResgate(lastro, v);
      const tok = erc20(lastro);
      const antes = await tok.balanceOf(S.endereco);
      const rn = c("ReservaBRL", true);
      await executar("Trocar pela versão nova", [
        passoAprovar(S.beta.xBRL, S.beta.ReservaBRL, v, "Autorizar a versão antiga"),
        { rotulo: "Resgatar a versão antiga", fn: (o) => rb.resgatar(lastro, v, pago, o) },
        passoAprovar(lastro, S.imp.ReservaBRL, pago, "Autorizar a Reserva nova"),
        { rotulo: "Emitir BRLS novo", fn: async (o) => rn.emitir(lastro, (await tok.balanceOf(S.endereco)) - antes, 0, o) },
      ]);
      return;
    }
    case "guia-ok":
      try { localStorage.setItem("xbrl.guia.ok", "1"); } catch { /* */ }
      return render();
    case "conectar-injetada": {
      const conexao = await conectarInjetada(S.chainId);
      conectarExterna(conexao);
      globalThis.ethereum.on?.("accountsChanged", (contas) => {
        if (contas?.[0]) conectarExterna({ ...conexao, endereco: E.getAddress(contas[0]) });
        render();
      });
      return ir("INICIO");
    }
    case "semgas-ler":
      return escanearQR(null, (txt) => abrirPedidoSemGas(txt).catch(mostrarErro));
    case "semgas-compartilhar":
      if (navigator.share) return navigator.share({ title: "Pedido sem gás — BRLS", text: "Abra no app BRLS para enviar minha ação (eu estou sem POL):", url: S.pedidoProprio }).catch(() => {});
      await navigator.clipboard?.writeText(S.pedidoProprio);
      return toast("Link copiado");
    case "semgas-pronto":
      fecharModal();
      return render();
    case "scan-endereco":
      return escanearQR("#env-para");
    case "scan-devolucao":
      return escanearQR("#tr-dev");
    case "abrir-chat":
      return ir("CHAT", { t: S.params.t });
    case "chat-atualizar":
      return render();
    case "chat-voltar":
      return ir("TRABALHO", { id: S.params.t.id });
    case "enviar-endereco": {
      const t = S.params.t;
      const chave = t.modalidade === 0 ? t.chegadaHash : t.codigoHash;
      const end = localStorage.getItem(`xbrl.endereco.${chave}`);
      const txs = {};
      if (t.txCriacao) txs[t.cliente.toLowerCase()] = [t.txCriacao];
      if (t.txAceite) txs[t.trabalhador.toLowerCase()] = [t.txAceite];
      const prep = await S.chat.preparar(idConversa(S.imp.EscrowTrabalho, t.id), S.carteira, participantes(t), /^\p{Extended_Pictographic}/u.test(end) ? end : `📍 Endereço: ${end}`, txs);
      if ((await executar("Enviar endereço", [passoMensagem("Enviar cifrado", prep)])) === "semgas") return;
      localStorage.setItem(`xbrl.endereco.enviado.${chave}`, "1");
      return;
    }
    case "chat-enviar": {
      const t = S.params.t;
      const txs = {};
      if (t.txCriacao) txs[t.cliente.toLowerCase()] = [t.txCriacao];
      if (t.txAceite) txs[t.trabalhador.toLowerCase()] = [t.txAceite];
      const prep = await S.chat.preparar(idConversa(S.imp.EscrowTrabalho, t.id), S.carteira, participantes(t), $("#chat-txt").value, txs);
      if ((await executar("Enviar mensagem", [passoMensagem("Enviar cifrada", prep)])) === "semgas") return;
      fecharModal();
      if (prep.semChave.length) toast(`${prep.semChave.length} participante(s) ainda sem chave: vão ler quando ativarem.`);
      return render();
    }
    case "cofre-tudo":
      $("#cf-valor").value = E.formatUnits(S.params.cofre.x.pos.divida, 18).replace(".", ",");
      S.params.quitarTudo = true;
      return;
    case "cofre-torneira": {
      const { x } = S.params.cofre;
      await executar(`Torneira ${x.simbolo}`, [{ rotulo: "Pegar moedas de teste", fn: (o) => erc20(x.a.token, true).torneira(o) }]);
      return;
    }
    case "cofre-risco":
      return procurarRisco();
    case "scan-chegada":
      return escanearQR("#tr-chegada");
    case "scan-codigo":
      return escanearQR("#tr-cod");
    case "fechar-scanner":
      if (S.scanner) S.scanner.ativo = false;
      return fecharModal();
    case "bio-agora": {
      const pin = S.pinRecente;
      S.pinRecente = null;
      await K.ativarBiometria(pin);
      fecharModal();
      return toast("Biometria ativada ✅");
    }
    case "bio-depois":
      S.pinRecente = null;
      return fecharModal();
    case "tq-cotar": {
      const t = S.params.candidatos[Number($("#tq-token").value)];
      if (S.params.faltam === 0n) return toast("O tanque já está cheio");
      $("#tq-cot").innerHTML = `<div class="giro"></div><p class="mudo">Procurando o caminho até o POL…</p>`;
      let cot;
      try {
        cot = await G.cotarAbastecimento(S.provider, S.chainId, t.endereco, S.params.faltam, t, [S.imp?.xBRL]);
      } catch (e) {
        $("#tq-cot").innerHTML = `<div class="aviso">${esc(traduzirErro(e))}</div>`;
        return;
      }
      S.params.cotacao = { ...cot, simbolo: t.simbolo, decimais: t.decimais };
      $("#tq-cot").innerHTML = `<div class="cartao"><div class="linha"><span>Recebe</span><b>${fmt(cot.quantidadePol, 18, 4)} POL</b></div>
        <div class="linha"><span>Custo cotado</span><b>${fmt(cot.entradaCotada, t.decimais, 4)} ${esc(t.simbolo)}</b></div>
        <div class="linha"><span>Máximo (slippage 1%)</span><b>${fmt(cot.entradaMaxima, t.decimais, 4)} ${esc(t.simbolo)}</b></div>
        <div class="linha"><span>Rota</span><b>Uniswap V3 · ${esc(cot.rota.tipo)}</b></div></div>${botaoSegurar("abastecer", "abastecer")}`;
      ligarSegurar($("#tq-cot"));
      return;
    }
    case "bio-ativar":
      return tecladoPin("Confirme o PIN", "Para ligar a biometria.", async (pin) => {
        await K.ativarBiometria(pin);
        toast("Biometria ativada");
        ir("AJUSTES");
      });
    case "bio-desativar":
      K.desativarBiometria();
      toast("Biometria desativada");
      return render();
    case "trocar-pin": {
      let atual;
      return tecladoPin("PIN atual", "Digite o PIN de hoje.", async (p) => {
        await K.abrirComPin(p);
        atual = p;
        tecladoPin("Novo PIN", "Escolha o novo PIN.", async (novo) => {
          await K.trocarPin(atual, novo);
          toast("PIN trocado");
          ir("AJUSTES");
        });
      });
    }
    case "ct-jitsi":
    case "ct-add-link": {
      const t = S.params.t;
      const f = guardarFormContato(t);
      const u = nome === "ct-jitsi" ? novaSalaJitsi(t.id) : linkSeguro($("#ct-link").value);
      if (!u) throw new Error("Cole um link que comece com https://");
      f.meu.links = [...(f.meu.links || []).filter((l) => l.u !== u), { t: nome === "ct-jitsi" ? "Sala de vídeo (Jitsi)" : "", u }].slice(-8);
      f.postadoEm = 0;
      gravarFicha(t.id, f);
      $("#contato").outerHTML = blocoContato(t, t.cliente.toLowerCase() === S.endereco.toLowerCase());
      $("#contato details").open = true;
      return toast(nome === "ct-jitsi" ? "🎥 Sala criada. Toque em Compartilhar para mandar" : "🔗 Link adicionado. Toque em Compartilhar para mandar");
    }
    case "ct-compartilhar": {
      const t = S.params.t;
      guardarFormContato(t);
      await enviarContato(t);
      $("#contato").outerHTML = blocoContato(t, t.cliente.toLowerCase() === S.endereco.toLowerCase());
      return toast("📤 Contato enviado, cifrado: só a outra pessoa consegue ler");
    }
    case "ct-pela-conversa": {
      const t = S.params.t;
      const f = guardarFormContato(t);
      const linhas = [f.meu.wa ? `📇 Meu WhatsApp: ${whatsBonito(f.meu.wa)} https://wa.me/${f.meu.wa}` : "", ...(f.meu.links || []).map((l) => `${iconeLink(l.u)[0]} ${l.t || iconeLink(l.u)[1]}: ${l.u}`), f.meu.det].filter(Boolean);
      if (!linhas.length) throw new Error("Preencha o WhatsApp ou um link antes de enviar");
      const txs = {};
      if (t.txCriacao) txs[t.cliente.toLowerCase()] = [t.txCriacao];
      if (t.txAceite) txs[t.trabalhador.toLowerCase()] = [t.txAceite];
      const prep = await S.chat.preparar(idConversa(S.imp.EscrowTrabalho, t.id), S.carteira, participantes(t), linhas.join("\n").slice(0, MAX_CARACTERES), txs);
      return executar("Enviar contato", [passoMensagem("Enviar cifrado", prep)]);
    }
    default:
      if (nome?.startsWith("ct-tirar-")) {
        const t = S.params.t;
        const f = guardarFormContato(t);
        f.meu.links = (f.meu.links || []).filter((_, i) => i !== Number(nome.slice(9)));
        f.postadoEm = 0;
        gravarFicha(t.id, f);
        $("#contato").outerHTML = blocoContato(t, t.cliente.toLowerCase() === S.endereco.toLowerCase());
        $("#contato details").open = true;
        return;
      }
      if (nome?.startsWith("mod-")) return ir("TRABALHO_NOVO", { modalidade: Number(nome.slice(4)) });
      if (nome?.startsWith("cofre-ativo-")) return ir("COFRE", { ativo: Number(nome.slice(12)), modo: S.params.modo });
      if (nome?.startsWith("cofre-modo-")) return ir("COFRE", { ativo: S.params.cofre?.x.i ?? 0, modo: nome.slice(11) });
      if (nome?.startsWith("cofre-simular-")) {
        const l = S.params.risco[Number(nome.slice(14))];
        const { x } = S.params.cofre;
        const plano = await c("CofreCripto").simularLiquidacao(x.i, l.conta);
        S.params.liquidar = { conta: l.conta, plano };
        modal(`<h2>⚖️ Liquidar ${esc(curto(l.conta))}</h2>
          <div class="linha"><span>Você paga</span><b>${fmt(plano.pagar)} BRLS</b></div>
          <div class="linha"><span>Você recebe</span><b>${fmt(plano.entregar, x.decimais, 6)} ${esc(x.simbolo)}</b></div>
          ${plano.coberto > 0n ? `<div class="linha"><span>Coberto pelo colchão</span><b>${fmt(plano.coberto)}</b></div>` : ""}
          <p class="mudo">O que sobrar da garantia continua com o dono da posição.</p>
          ${botaoSegurar("liquidar", "cofre-liquidar")}<button class="btn sec" data-acao="fechar-modal">Cancelar</button>`);
      }
  }
}

// Ações confirmadas por "segurar"
async function confirmar(nome) {
  if (nome.startsWith("correio-")) return enviarDoCorreio(nome);
  if (nome.startsWith("pixok:")) return aceitarPedidoPix(nome.slice(6));
  if (nome.startsWith("contra:")) return aceitarContraproposta(nome.slice(7));
  const vitrineAcoes = { "na-publicar": publicarAnuncio, "lj-publicar": publicarLoja, "an-comprar": () => comprarAnuncio(false), "an-contratar": () => comprarAnuncio(true), "pix-pedir": pedirCompraPix, "pix-vender": venderBrlsPorPix, "sac-pedir": fazerPedidoComida };
  if (vitrineAcoes[nome]) return vitrineAcoes[nome]();
  switch (nome) {
    case "anotei":
      return ir("CONFIRMAR_FRASE");
    case "esqueci":
      K.apagarCofre();
      fecharModal();
      S.tela = "BLOQUEADA";
      return ir("BOAS_VINDAS");
    case "apagar":
      if ($("#aj-apagar").value.trim().toUpperCase() !== "APAGAR") return toast("Digite APAGAR para confirmar");
      K.apagarCofre();
      S.carteira = null;
      S.endereco = null;
      return ir("BOAS_VINDAS");
    case "enviar": {
      const sel = $("#env-token").value;
      const para = $("#env-para").value.trim();
      if (!E.isAddress(para)) throw new Error("Endereço de destino inválido");
      if (para.toLowerCase() === S.endereco.toLowerCase()) throw new Error("Esse é o seu próprio endereço");
      if (sel === "nativo") {
        const v = lerValor($("#env-valor").value, 18);
        await executar(`Enviar ${S.rede.nativo.simbolo}`, [{ rotulo: "Enviar", fn: (o) => S.carteira.sendTransaction({ to: E.getAddress(para), value: v, ...o }) }]);
      } else {
        const t = S.tokensInfo[Number(sel)];
        const v = lerValor($("#env-valor").value, t.decimais);
        await executar(`Enviar ${t.simbolo}`, [{ rotulo: "Enviar", fn: (o) => erc20(t.endereco, true).transfer(E.getAddress(para), v, o) }]);
      }
      return;
    }
    case "reserva": {
      const t = S.params.lastros[Number($("#res-lastro").value)];
      const r = c("ReservaBRL", true);
      if ((S.params.modo || "emitir") === "emitir") {
        const v = lerValor($("#res-valor").value, t.decimais);
        const [liq] = await c("ReservaBRL").cotarEmissao(t.endereco, v);
        const minimo = (liq * 995n) / 1000n; // tolerância 0,5% (o spread pode mudar se outra pessoa emitir antes)
        await executar("Comprar BRLS", [passoAprovar(t.endereco, S.imp.ReservaBRL, v, `Autorizar ${t.simbolo}`), { rotulo: "Emitir BRLS", fn: (o) => r.emitir(t.endereco, v, minimo, o) }]);
      } else {
        const v = lerValor($("#res-valor").value, 18);
        const [pago] = await c("ReservaBRL").cotarResgate(t.endereco, v);
        const minimo = (pago * 995n) / 1000n;
        await executar("Resgatar", [passoAprovar(S.imp.xBRL, S.imp.ReservaBRL, v, "Autorizar BRLS"), { rotulo: `Receber ${t.simbolo}`, fn: (o) => r.resgatar(t.endereco, v, minimo, o) }]);
      }
      return;
    }
    case "abastecer": {
      const cot = S.params.cotacao;
      modal(`<div class="giro"></div><h2>Abastecendo</h2><p class="mudo">Gasto máximo: ${fmt(cot.entradaMaxima, cot.decimais, 4)} ${esc(cot.simbolo)}</p>`);
      try {
        const recibo = await G.abastecer(S.carteira, cot, await opcoesGas());
        modal(`<h2>⛽ Tanque abastecido</h2><p><a href="${esc(linkExplorer(S.chainId, "tx", recibo.hash))}" target="_blank" rel="noopener">Ver comprovante</a></p><button class="btn prim" data-acao="fechar-modal">Ok</button>`);
      } catch (e) {
        modal(`<h2>Não foi possível abastecer</h2><div class="erro">${esc(traduzirErro(e))}</div><button class="btn sec" data-acao="fechar-modal">Fechar</button>`);
      }
      return;
    }
    case "semgas-enviar":
      await executar("Enviar pela outra pessoa", SG.passosParaEnviar(S.carteira, S.imp, S.params.pedidoSemGas));
      return;
    case "criar-trabalho":
      return criarTrabalho();
    case "mc-publicar":
      return publicarCarro();
    case "cor-cancelar-ok":
      return pedirCancelamento(S.params.t, Number($("#cc-pct").value) * 100);
    case "cor-cancel-aceitar":
      return aceitarCancelamento(S.params.t);
    case "cor-acordo-aceitar": {
      const t = S.params.t;
      const bps = Math.max(0, Number(t.propostaCliente) - 1);
      return executar("Aceitar o cancelamento", [passoEscrow(`Aceitar ${bps / 100}%`, "proporAcordo", [BigInt(t.id), bps])]);
    }
    case "cor-gorjeta": {
      const t = S.params.t;
      const v = lerValor($("#cor-gorjeta-v").value);
      if (v === 0n) throw new Error("Informe o valor da gorjeta");
      return executar("Gorjeta", [{ rotulo: "Enviar gorjeta", fn: (o) => c("xBRL", true).transfer(t.trabalhador, v, o) }]);
    }
    case "pedir-corrida":
      return pedirCorrida();
    case "cofre":
      return operarCofre();
    case "cofre-liquidar": {
      const { x } = S.params.cofre;
      const { conta, plano } = S.params.liquidar;
      const k = c("CofreCripto", true);
      await executar("Liquidar posição", [passoAprovar(S.imp.xBRL, S.imp.CofreCripto, plano.pagar, "Autorizar BRLS"), { rotulo: "Liquidar", fn: (o) => k.liquidar(x.i, conta, o) }]);
      return;
    }
    default:
      if (nome?.startsWith("tr-")) return acaoTrabalho(nome.slice(3));
  }
}

async function operarCofre() {
  const { x, saldoX } = S.params.cofre;
  const modo = S.params.modo || "depositar";
  const k = c("CofreCripto", true);
  const ehCripto = modo === "depositar" || modo === "retirar";
  let v = lerValor($("#cf-valor").value, ehCripto ? x.decimais : 18);
  if (v === 0n) throw new Error("Informe um valor");
  if (modo === "depositar") {
    return executar(`Depositar ${x.simbolo}`, [passoAprovar(x.a.token, S.imp.CofreCripto, v, `Autorizar ${x.simbolo}`), { rotulo: "Depositar garantia", fn: (o) => k.depositar(x.i, v, o) }]);
  }
  if (modo === "retirar") return executar(`Retirar ${x.simbolo}`, [{ rotulo: "Retirar garantia", fn: (o) => k.retirar(x.i, v, o) }]);
  if (modo === "emitir") {
    if (v > x.podeEmitir) throw new Error(`O máximo agora é ${fmt(x.podeEmitir)} BRLS`);
    return executar("Emitir BRLS", [{ rotulo: "Emitir", fn: (o) => k.emitir(x.i, v, o) }]);
  }
  // quitar: nunca aprova mais do que a dívida
  if (S.params.quitarTudo || v > x.pos.divida) v = x.pos.divida;
  S.params.quitarTudo = false;
  if (v > saldoX) throw new Error("Saldo de BRLS insuficiente");
  return executar("Pagar dívida", [passoAprovar(S.imp.xBRL, S.imp.CofreCripto, v, "Autorizar BRLS"), { rotulo: "Pagar", fn: (o) => k.quitar(x.i, S.endereco, v, o) }]);
}

async function criarTrabalho() {
  const m = Number(S.params.modalidade ?? 0);
  const regiao = ($("#tn-regiao")?.value || "").trim();
  let enderecoCompleto = ($("#tn-endereco")?.value || "").trim();
  const pt = S.params.ponto;
  if (pt && !coordenadasNoTexto(enderecoCompleto).length) enderecoCompleto = `${enderecoCompleto || pt.endereco}\n📍 ${fmtCoord(pt.lat, pt.lon)}`;
  if ((m === 0 || m === 1) && regiao.length < 3) throw new Error("Informe o bairro e a cidade");
  if ((m === 0 || m === 1) && enderecoCompleto.length < 8) throw new Error("Informe o endereço completo: sem ele a pessoa não sabe aonde ir");
  const valor = lerValor($("#tn-valor").value, 18);
  if (valor === 0n) throw new Error("Informe o pagamento");
  if ($("#tn-desc").value.trim().length < 3) throw new Error("Diga em poucas palavras o que precisa ser feito (título)");
  const detalhes = ($("#tn-detalhes")?.value || "").replace(/\r/g, "").trim().slice(0, 600);
  const waBruto = $("#tn-whats")?.value || "";
  const wa = normalizarWhats(waBruto);
  if (waBruto.trim() && !wa) throw new Error("WhatsApp inválido: use DDD + número, ex.: (31) 99999-9999");
  const linksTxt = ($("#tn-links")?.value || "").split(/\s+/).filter(Boolean);
  const ruim = linksTxt.find((u) => !linkSeguro(u));
  if (ruim) throw new Error(`Link inválido: ${ruim.slice(0, 40)} (precisa começar com https://)`);
  const priv = ($("#tn-priv")?.value || "").trim().slice(0, 1000);
  const querJitsi = !!$("#tn-jitsi")?.checked;
  const [saldoX, saldoPol] = await Promise.all([c("xBRL").balanceOf(S.endereco), S.provider.getBalance(S.endereco)]);
  if (saldoX < valor) throw new Error(`Você tem ${fmt(saldoX)} BRLS e o pagamento é ${fmt(valor)}. Pegue BRLS na aba Reserva (troque BRZ/BRLA/BRL1) e tente de novo.`);
  if (saldoPol < E.parseEther("0.05")) throw new Error("Você precisa de um pouco de POL (uns 0,2) para pagar a taxa da rede. Mande POL para o seu endereço na tela Receber.");
  const dias = Math.max(1, Math.min(365, Number($("#tn-prazo").value) || 7));
  const trabTxt = $("#tn-trab").value.trim();
  if (trabTxt && !E.isAddress(trabTxt)) throw new Error("Endereço do trabalhador inválido");
  const palavras = valor >= E.parseEther("1000") ? 6 : 5;
  let codigo = null;
  if (m === 1 || $("#tn-cod")?.checked) codigo = gerarCodigoEntrega(palavras);
  const codigoHash = codigo ? hashCodigo(S.imp.EscrowTrabalho, S.endereco, codigo) : E.ZeroHash;
  if (codigo) guardarCodigo(codigoHash, codigo);
  const chegada = m === 0 ? gerarCodigoEntrega(palavras) : null;
  const chegadaHash = chegada ? hashChegada(S.imp.EscrowTrabalho, S.endereco, chegada) : E.ZeroHash;
  if (chegada) guardarCodigo(chegadaHash, chegada);
  const arbTxt = $("#tn-arb")?.value.trim() || "";
  if (arbTxt && !E.isAddress(arbTxt)) throw new Error("Endereço do árbitro inválido");
  if (arbTxt && [S.endereco, trabTxt].some((a) => a && a.toLowerCase() === arbTxt.toLowerCase())) throw new Error("O árbitro precisa ser outra pessoa");
  const comCaucao = m === 1 && $("#tn-caucao-on")?.checked;
  const caucao = comCaucao ? lerValor($("#tn-caucao").value, 18) : 0n;
  if (comCaucao && caucao < E.parseEther(String(ESCROW.caucaoMinima))) throw new Error(`A caução mínima é ${ESCROW.caucaoMinima} BRLS`);
  const devolucao = comCaucao ? gerarCodigoEntrega(palavras) : null;
  const devolucaoHash = devolucao ? hashDevolucao(S.imp.EscrowTrabalho, S.endereco, devolucao) : E.ZeroHash;
  if (devolucao) guardarCodigo(devolucaoHash, devolucao);
  const p = {
    modalidade: m,
    trabalhador: trabTxt ? E.getAddress(trabTxt) : E.ZeroAddress,
    valor,
    prazo: BigInt(agora() + dias * 86400),
    etapas: m === 3 ? Math.max(2, Math.min(50, Number($("#tn-etapas").value) || 2)) : 1,
    codigoHash,
    chegadaHash,
    arbitroCliente: arbTxt ? E.getAddress(arbTxt) : E.ZeroAddress,
    desempateCriador: m !== 1 && !!$("#tn-desempate")?.checked,
    caucao,
    devolucaoHash,
    descricao: (regiao ? `📍 ${regiao} · ` : "") + $("#tn-desc").value.trim().replace(/\n/g, " ").slice(0, 100) + (detalhes ? `\n${detalhes}` : ""),
  };
  const chaveEnd = m === 0 ? chegadaHash : codigoHash;
  if (enderecoCompleto) try { localStorage.setItem(`xbrl.endereco.${chaveEnd}`, enderecoCompleto); } catch { /* sem armazenamento */ }
  const kit = S.imp.Encaminhador ? lerValor($("#tn-kit")?.value || "0", 18) : 0n;
  if (kit > E.parseEther("5")) throw new Error("O gás para o trabalhador pode ser no máximo 5 POL");
  if (saldoPol < kit + E.parseEther("0.05")) throw new Error(`Você tem ${fmt(saldoPol, 18, 3)} POL: não dá para deixar ${fmt(kit, 18, 3)} de gás para o trabalhador e ainda pagar a taxa. Diminua o valor.`);
  const rec = await executar("Contratar", [passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, valor, "Autorizar BRLS"), { rotulo: "Travar pagamento", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(p, { ...o, value: kit }) }]);
  // Contato direto: fica guardado no aparelho e vai cifrado (sozinho) para quem for confirmado no trabalho
  const idNovo = idDoRecibo(rec);
  if (idNovo && (wa || linksTxt.length || priv || querJitsi)) {
    const links = linksTxt.map((u) => ({ t: "", u: linkSeguro(u) })).slice(0, 7);
    if (querJitsi) links.unshift({ t: "Sala de vídeo (Jitsi)", u: novaSalaJitsi(idNovo) });
    gravarFicha(idNovo, { meu: { wa, links, det: priv }, deles: {}, auto: true });
    try { if (wa) localStorage.setItem("xbrl.meu.whatsapp", wa); } catch { /* ok */ }
  }
  if (codigo || chegada) {
    modal(`<h2>✅ Pagamento travado</h2>
      ${chegada ? `<p><b>📍 Código de chegada</b> — deixe no local ou mostre na porta:</p>${qrSvg(chegada)}<div class="codigo" id="cod-chegada">${esc(chegada)}</div>` : ""}
      ${codigo ? `<p><b>🔑 Código de ${m === 1 ? "entrega" : "liberação"}</b> — entregue <b>só</b> a quem recebe, no momento em que receber:</p>${qrSvg(codigo)}<div class="codigo" id="cod-liberacao">${esc(codigo)}</div>` : ""}
      ${devolucao ? `<p><b>↩️ Código de devolução</b> — só se a mercadoria voltar para as suas mãos:</p><div class="codigo" id="cod-devolucao">${esc(devolucao)}</div>` : ""}
      <p class="mudo">Os códigos também ficam salvos neste aparelho, na tela do trabalho.</p><button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
  }
  ir("TRABALHOS", { aba: "meus" });
}

/** Número do trabalho criado, lido do recibo (evento TrabalhoCriado). */
function idDoRecibo(rec) {
  if (!rec?.logs) return null;
  const k = c("EscrowTrabalho");
  for (const l of rec.logs) {
    try { const ev = k.interface.parseLog(l); if (ev?.name === "TrabalhoCriado") return String(ev.args.id); } catch { /* outro contrato */ }
  }
  return null;
}

async function acaoTrabalho(nome) {
  const t = S.params.t;
  const k = c("EscrowTrabalho", true);
  const id = BigInt(t.id);
  const f = {
    aceitar: () => {
      let arb = E.ZeroAddress;
      if (t.arbitroCliente !== E.ZeroAddress) {
        const txt = $("#tr-arb")?.value.trim() || "";
        if (!E.isAddress(txt)) throw new Error("Indique o seu árbitro (endereço 0x…)");
        if ([t.cliente, S.endereco].some((a) => a.toLowerCase() === txt.toLowerCase())) throw new Error("O árbitro precisa ser outra pessoa");
        arb = E.getAddress(txt);
      }
      const passos = [];
      if (t.caucao > 0n) passos.push(passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, t.caucao, "Autorizar caução"));
      passos.push(passoEscrow("Aceitar", "aceitar", [id, arb]));
      return executar("Aceitar trabalho", passos);
    },
    chegadaPeloCliente: () => executar("Confirmar chegada", [passoEscrow("Confirmar", "confirmarChegadaPeloCliente", [id])]),
    devolucao: () => {
      const cod = normalizarCodigo($("#tr-dev").value);
      if (!codigoTemFormatoValido(cod)) throw new Error("O código de devolução tem 5 ou 6 palavras.");
      if (hashDevolucao(S.imp.EscrowTrabalho, t.cliente, cod) !== t.devolucaoHash) throw new Error("Código de devolução incorreto");
      return executar("Confirmar devolução", [passoEscrow("Devolução com código", "confirmarDevolucao", [id, cod])]);
    },
    arbitrar: () => {
      const bps = Number($("#tr-arbitrar").value) * 100;
      return executar("Proposta do árbitro", [passoEscrow(`${bps / 100}% ao trabalhador`, "arbitrar", [id, bps])]);
    },
    desempatar: () => {
      const bps = Number($("#tr-desempate").value) * 100;
      return executar("Desempatar", [passoEscrow(`${bps / 100}% ao trabalhador`, "desempatar", [id, bps])]);
    },
    cancelar: () => executar("Cancelar", [passoEscrow("Cancelar", "cancelar", [id])]),
    desistir: () => executar("Desistir", [passoEscrow("Desistir", "desistir", [id])]),
    retirarCandidatura: () => executar("Retirar candidatura", [passoEscrow("Retirar", "desistir", [id])]),
    aprovarCandidato: () => executar("Aprovar trabalhador", [passoEscrow("Aprovar", "decidirCandidato", [id, true])]),
    recusarCandidato: () => executar("Recusar candidato", [passoEscrow("Recusar", "decidirCandidato", [id, false])]),
    marcarEntregue: () => executar("Marcar entregue", [passoEscrow("Marcar entregue", "marcarEntregue", [id])]),
    liberar: () => executar("Pagar trabalhador", [passoEscrow("Liberar", "liberar", [id])]),
    reivindicar: () => executar("Receber pagamento", [passoEscrow("Receber", "reivindicar", [id])]),
    abrirDisputa: () => executar("Abrir disputa", [passoEscrow("Abrir disputa", "abrirDisputa", [id])]),
    reembolsarPorPrazo: () => executar("Reaver valor", [passoEscrow("Reembolso", "reembolsarPorPrazo", [id])]),
    resolverPorTempo: () => executar("Dividir 50/50", [passoEscrow("Resolver", "resolverPorTempo", [id])]),
    acordo: () => {
      const bps = Number($("#tr-acordo").value) * 100;
      return executar("Propor acordo", [passoEscrow(`Propor ${bps / 100}% ao trabalhador`, "proporAcordo", [id, bps])]);
    },
    avaliar: () => {
      if (!S.params.estrelas) throw new Error("Escolha de 1 a 5 estrelas");
      return executar("Avaliar", [passoEscrow(`${S.params.estrelas} estrelas`, "avaliar", [id, S.params.estrelas])]);
    },
    codigo: () => {
      const cod = normalizarCodigo($("#tr-cod").value);
      if (!codigoTemFormatoValido(cod)) throw new Error("O código tem 5 ou 6 palavras. Confira com quem recebe.");
      if (hashCodigo(S.imp.EscrowTrabalho, t.cliente, cod) !== t.codigoHash) throw new Error("Código incorreto");
      return executar("Confirmar com código", [passoEscrow("Liberar com código", "confirmarComCodigo", [id, cod])]);
    },
    chegada: () => {
      const cod = normalizarCodigo($("#tr-chegada").value);
      if (!codigoTemFormatoValido(cod)) throw new Error("O código de chegada tem 5 ou 6 palavras. Confira no local.");
      if (hashChegada(S.imp.EscrowTrabalho, t.cliente, cod) !== t.chegadaHash) throw new Error("Código de chegada incorreto");
      return executar("Confirmar chegada", [passoEscrow("Registrar que cheguei", "confirmarChegada", [id, cod])]);
    },
  }[nome];
  if (!f) return;
  await f();
  if (ABERTAS.includes(S.tela) && $("#modal").hidden) ir("TRABALHO", { id: t.id });
}

// ----------------------------------------------------------------------------
// Partida
// ----------------------------------------------------------------------------
// No app Android, um link "abrir em outra janela" sairia do Tor: o comprovante abre aqui dentro.
function abrirComprovantesAqui() {
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest?.("a[href]");
    if (!a) return;
    const u = new URL(a.getAttribute("href"), location.href);
    if (u.origin !== location.origin || !u.pathname.endsWith("/comprovante.html")) return;
    ev.preventDefault();
    u.searchParams.set("rede", u.searchParams.get("rede") || String(S.chainId));
    const janela = document.createElement("div");
    janela.className = "janela-comprovante";
    janela.innerHTML = `<button type="button" class="btn sec">← Voltar</button><iframe title="Comprovante"></iframe>`;
    u.searchParams.set("tor", "pai"); // usa a rede desta janela (pela Caixa Forte)
    janela.querySelector("iframe").src = u.pathname + u.search;
    janela.querySelector("button").addEventListener("click", () => janela.remove());
    document.body.appendChild(janela);
  }, true);
}

async function iniciar() {
  S.tela = "CARREGANDO";
  $("#marca").innerHTML = marca(32);
  if (REDE_PELA_PONTE) abrirComprovantesAqui();
  else if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
    let recarregou = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (recarregou) return;
      recarregou = true;
      if (!S.carteira) location.reload(); // nova versão: atualiza já (se a carteira estiver aberta, no próximo bloqueio)
    });
  }
  window.addEventListener("hashchange", receberPedidoDoLink);
  if (location.hash.startsWith("#" + SG.PREFIXO)) {
    S.pedidoRecebido = location.hash.slice(1);
    history.replaceState(null, "", location.pathname + location.search);
  }
  await conectarRede(escolherRedeInicial());
  // Aberto dentro da Caixa Forte: usa a carteira dela, sem pedir 12 palavras nem PIN.
  const ponte = await procurarPonte();
  if (ponte) {
    if (ponte.chainId && ponte.chainId !== S.chainId && REDES[ponte.chainId]) await conectarRede(ponte.chainId);
    conectarExterna(ponte);
    ir("INICIO");
    return aoEntrar();
  }
  ir(K.existeCofre() ? "BLOQUEADA" : "BOAS_VINDAS");
}

iniciar().catch((e) => {
  console.error(e);
  $("#tela").innerHTML = `<div class="erro">Falha ao iniciar: ${esc(traduzirErro(e))}</div>`;
});

// Exposto só para testes automatizados (sem chaves).
window.__xbrl = { estado: () => ({ tela: S.tela, chainId: S.chainId, endereco: S.endereco, implantado: !!S.imp, ocupado: S.ocupado > 0 }) };
