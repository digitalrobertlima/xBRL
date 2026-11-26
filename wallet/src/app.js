// =====================================================================
// BRLS — Carteira Nativa (PWA) — máquina de estados travada
// - Só transições declaradas em TRANSICOES são possíveis (botão "voltar" do aparelho não fura o bloqueio).
// - A frase/chave só existe na memória enquanto a carteira está desbloqueada (auto-bloqueio em 5 min).
// - Ações que movem dinheiro exigem "segurar para confirmar"; desbloqueio exige "deslizar" + PIN.
// - Chegada ao local é comprovada por código/QR (palavras), nunca por GPS (falsificável).
// =====================================================================
import { REDE_PELA_PONTE } from "./rede-ponte.js"; // primeiro: no app Android, a rede vem pela Caixa Forte (Tor)
import { carregarImplantacaoBeta } from "./config.js";
import { ABIS, COFRE, CREATOR_TREASURY, ESCROW, REDE_PADRAO, REDES, SEGURANCA, TANQUE, VERSAO, carregarImplantacao, linkExplorer } from "./config.js";
import * as K from "./keystore.js";
import * as G from "./gas-tank.js";
import { EscrowClient, REGRAS_NIVEL, codigoGuardado, codigoTemFormatoValido, gerarCodigoEntrega, guardarCodigo, hashChegada, hashCodigo, hashDevolucao, idConversa, normalizarCodigo } from "./escrow-client.js";
import { Chat, MAX_CARACTERES } from "./chat.js";
import * as SG from "./semgas.js";
import { marca, roseta } from "./marca.js";
import { ProvedorRotativo } from "./rpc.js";
import { AssinanteExterno, conectarInjetada, procurarPonte, temInjetada } from "./externa.js";
import qrcode from "./vendor/qrcode.mjs";

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
const ABERTAS = ["INICIO", "ENVIAR", "RECEBER", "RESERVA", "COFRE", "EXTRATO", "TRABALHOS", "TRABALHO_NOVO", "TRABALHO", "CHAT", "TANQUE", "AJUSTES", "BACKUP"];
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
  const aberta = ABERTAS.includes(destino);
  $("#abas").hidden = !aberta;
  $("#btn-bloquear").hidden = !aberta || !!S.externa;
  for (const b of $$("#abas button")) b.toggleAttribute("aria-current", false);
  const aba = { TRABALHO_NOVO: "TRABALHOS", TRABALHO: "TRABALHOS", CHAT: "TRABALHOS", COFRE: "RESERVA", EXTRATO: "INICIO", ENVIAR: "INICIO", RECEBER: "INICIO", TANQUE: "INICIO", BACKUP: "AJUSTES" }[destino] || destino;
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

/** Botões "segure para confirmar": dispara após 1,2 s pressionado (toque, mouse ou teclado). */
function ligarSegurar(raiz) {
  for (const b of $$(".segurar", raiz)) {
    if (b.dataset.ligado) continue;
    b.dataset.ligado = "1";
    let t0 = 0;
    let raf = 0;
    const DUR = 1200;
    const parar = () => {
      cancelAnimationFrame(raf);
      t0 = 0;
      b.style.setProperty("--p", "0%");
    };
    const passo = () => {
      const p = Math.min(1, (performance.now() - t0) / DUR);
      b.style.setProperty("--p", `${p * 100}%`);
      if (p >= 1) {
        parar();
        navigator.vibrate?.(40);
        b.dispatchEvent(new CustomEvent("confirmado", { bubbles: true }));
      } else raf = requestAnimationFrame(passo);
    };
    const iniciar = (ev) => {
      if (b.disabled || t0) return;
      ev.preventDefault();
      t0 = performance.now();
      raf = requestAnimationFrame(passo);
    };
    b.addEventListener("pointerdown", iniciar);
    b.addEventListener("pointerup", parar);
    b.addEventListener("pointerleave", parar);
    b.addEventListener("pointercancel", parar);
    b.addEventListener("keydown", (ev) => (ev.key === " " || ev.key === "Enter") && !ev.repeat && iniciar(ev));
    b.addEventListener("keyup", (ev) => (ev.key === " " || ev.key === "Enter") && parar());
    b.addEventListener("click", (ev) => ev.preventDefault());
  }
}

function botaoSegurar(texto, acao, extra = "") {
  return `<button class="btn prim segurar" data-confirmar="${esc(acao)}" ${extra}><i>✋ Segure para ${esc(texto)}</i></button>`;
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
    if (auto) toast(`⛽ Tanque abastecido com ${auto.simbolo}`);
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
    conectarExterna({ ...conexao, endereco: E.getAddress(novo) });
    toast("Conta trocada na carteira conectada");
    render();
  });
}

function bloquear() {
  if (S.externa) return; // quem tranca é a carteira conectada
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
  if (document.hidden) S.ocultoEm = Date.now();
  else if (S.carteira && !S.externa && S.ocultoEm && Date.now() - S.ocultoEm > 60_000) bloquear();
});

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
      return `<div class="item"><span class="ic">${m.icone}</span><span class="meio"><b>${esc(t.descricao || m.nome)}</b><span class="mudo">${esc(m.nome)} · prazo ${esc(new Date(t.prazo * 1000).toLocaleDateString("pt-BR"))}</span></span><b>${reais(t.valor)}</b></div>`;
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

TELAS.RESTAURAR = () => tela(`
  <h1>Restaurar carteira</h1><p class="mudo">Digite as suas palavras (12 ou 24), na ordem, separadas por espaço. Em português ou em inglês: o app reconhece sozinho.</p>
  <textarea id="frase" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Palavras de recuperação"></textarea>
  <div id="msg" role="alert"></div>
  <button class="btn prim" data-acao="restaurar-ok">Continuar</button>
  <button class="btn sec" data-acao="voltar-boas-vindas">Voltar</button>`);

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
  tela(`
    <div class="abertura">
      ${roseta({ tam: 120, tracos: 5 })}
      <h1>Carteira bloqueada</h1>
      <p class="serie">Nº ${esc(curto(K.enderecoSalvo()))}</p>
    </div>
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

TELAS.INICIO = async () => {
  tela(`<div class="cartao"><div class="giro"></div></div>`);
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
      <button class="atalho" data-ir="TRABALHOS"><span>🤝</span>Trabalhos</button>
      <button class="atalho" data-ir="TANQUE"><span>⛽</span>Tanque</button>
      <button class="atalho" data-ir="EXTRATO"><span>🧾</span>Extrato</button>
      <button class="atalho" data-ir="COFRE"><span>🏦</span>Cofre cripto</button>
    </div>
    <div class="cartao">
      <div class="linha"><b>⛽ Tanque de gás</b><span>${fmt(pol, 18, 3)} ${esc(S.rede.nativo.simbolo)} / ${TANQUE.alvoPol}</span></div>
      <div class="tanque" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${tanque.nivelPct}" style="--n:${tanque.nivelPct}%"><i></i></div>
      ${tanque.precisaAbastecer ? `<p class="mudo">Tanque baixo. ${G.autoAtivo() ? "O abastecimento automático vai agir na próxima operação." : "Toque em Tanque para abastecer."}</p>` : ""}
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
  $("#env-valor").addEventListener("input", atualizar);
  $("#env-token").addEventListener("change", atualizar);
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
  $("#res-valor").addEventListener("input", cotar);
  $("#res-lastro").addEventListener("change", cotar);
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
  const [{ meus, vagas, arbitragens }, rep] = await Promise.all([S.escrow.listar(S.endereco), S.escrow.reputacao(S.endereco)]);
  const lista = { meus, vagas, arbitragens }[aba] || meus;
  const card = (t) => {
    const m = ESCROW.modalidades[t.modalidade];
    const papel = t.cliente.toLowerCase() === S.endereco.toLowerCase() ? "Você contratou" : t.trabalhador.toLowerCase() === S.endereco.toLowerCase() ? "Você trabalha" : aba === "arbitragens" ? "Você é árbitro" : "Vaga aberta";
    return `<button class="item" data-trabalho="${esc(t.id)}"><span class="ic">${m.icone}</span><span class="meio"><b>${esc(t.descricao || m.nome)}</b><span class="mudo">#${esc(t.id)} · ${esc(m.nome)} · ${esc(papel)}</span></span><b>${fmt(t.valor)}</b></button>`;
  };
  tela(`
    <h1>Trabalhos</h1>
    <div class="cartao"><div class="linha"><span>Sua reputação</span><span>${estrelasNivel(rep.nivel)} <b>${esc(rep.nomeNivel)}</b></span></div>
      ${resumoReputacao(rep)}</div>
    <button class="btn prim" data-ir="TRABALHO_NOVO">+ Contratar alguém</button>
    ${S.imp?.Encaminhador ? `<button class="btn sec" data-acao="semgas-ler">📷 Ler pedido sem gás (de quem está sem POL)</button>` : ""}
    <div class="seg" role="group"><button data-acao="aba-meus" aria-pressed="${aba === "meus"}">Meus (${meus.length})</button><button data-acao="aba-vagas" aria-pressed="${aba === "vagas"}">Vagas (${vagas.length})</button>${arbitragens.length ? `<button data-acao="aba-arbitragens" aria-pressed="${aba === "arbitragens"}">⚖️ Árbitro (${arbitragens.length})</button>` : ""}</div>
    ${lista.map(card).join("") || `<p class="mudo">Nada por aqui ainda.</p>`}`);
};

TELAS.TRABALHO_NOVO = () => {
  const m = Number(S.params.modalidade ?? 0);
  tela(`
    <h1>Contratar</h1>
    <div class="grade duas">${ESCROW.modalidades.map((x) => `<button class="atalho" data-acao="mod-${x.id}" aria-pressed="${x.id === m}" style="${x.id === m ? "border-color:var(--o400);background:rgba(212,175,55,.14)" : ""}"><span>${x.icone}</span>${esc(x.nome)}</button>`).join("")}</div>
    <p class="mudo">${esc(ESCROW.modalidades[m].resumo)}</p>
    <label for="tn-desc">O que precisa ser feito</label><input id="tn-desc" maxlength="100" placeholder="Ex.: Escrever uma mensagem num papel">
    ${m === 0 || m === 1 ? `<label for="tn-regiao">📍 Bairro e cidade ${m === 1 ? "da entrega" : "do serviço"} (obrigatório, aparece para todos)</label><input id="tn-regiao" maxlength="36" placeholder="Ex.: Savassi, Belo Horizonte">
    <label for="tn-endereco">🏠 Endereço completo (obrigatório)</label><input id="tn-endereco" maxlength="200" placeholder="Rua, número, complemento, referência">
    <p class="mudo">Por segurança, o endereço completo não fica público: só a pessoa aceita vê, pela conversa cifrada do trabalho.</p>` : ""}
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
};

TELAS.TRABALHO = async () => {
  const id = S.params.id;
  const t = await S.escrow.detalhe(id);
  const resumo = S.escrow.resumoTrabalhos().get(String(id));
  const m = ESCROW.modalidades[t.modalidade];
  const acoes = S.escrow.acoesPossiveis(t, S.endereco);
  const [rc, rt] = await Promise.all([S.escrow.reputacao(t.cliente), t.trabalhador !== E.ZeroAddress ? S.escrow.reputacao(t.trabalhador) : null]);
  const souCliente = t.cliente.toLowerCase() === S.endereco.toLowerCase();
  const codigo = souCliente && t.codigoHash !== E.ZeroHash ? codigoGuardado(t.codigoHash) : null;
  const chegada = souCliente && t.chegadaHash !== E.ZeroHash && !t.chegou ? codigoGuardado(t.chegadaHash) : null;
  const devolucao = souCliente && t.caucaoTravada ? codigoGuardado(t.devolucaoHash) : null;
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
  tela(`
    <h1>${m.icone} ${esc(resumo?.descricao || m.nome)}</h1>
    <p class="mudo">#${esc(t.id)} · ${esc(m.nome)} · <span class="selo">${esc(t.estadoNome)}</span></p>
    <div class="cartao">
      <div class="linha"><span>Valor</span><b>${fmt(t.valor)} BRLS</b></div>
      <div class="linha"><span>Já pago</span><b>${fmt(t.pago)} BRLS</b></div>
      ${t.etapas > 1 ? `<div class="linha"><span>Etapas pagas</span><b>${t.etapasPagas} de ${t.etapas}</b></div>` : ""}
      <div class="linha"><span>Prazo</span><b>${new Date(t.prazo * 1000).toLocaleString("pt-BR")}</b></div>
      <div class="linha"><span>Cliente</span><span>${esc(curto(t.cliente))} ${estrelasNivel(rc.nivel)} <small class="mudo">${Number(rc.contrapartes)} ${Number(rc.contrapartes) === 1 ? "pessoa" : "pessoas"} · ${rc.idadeDias} dias</small></span></div>
      <div class="linha"><span>${t.pendenteAprovacao ? "Candidato" : "Trabalhador"}</span><span>${t.trabalhador === E.ZeroAddress ? "vaga aberta" : `${esc(curto(t.trabalhador))} ${estrelasNivel(rt.nivel)} ${rt ? `<small class="mudo">${Number(rt.contrapartes)} ${Number(rt.contrapartes) === 1 ? "pessoa" : "pessoas"} · ${rt.idadeDias} dias</small>` : ""}`}</span></div>
      ${t.pendenteAprovacao ? `<div class="linha"><span>Situação</span><b>aguardando o cliente aprovar</b></div>` : ""}
      ${t.modalidade === 0 ? `<div class="linha"><span>Chegada</span>${t.chegou ? '<span class="selo verde">confirmada com código</span>' : "<b>aguardando</b>"}</div>` : ""}
      ${t.estado === 2 ? `<div class="linha"><span>Pagamento automático em</span><b>${new Date((t.entregueEm + ESCROW.prazoRevisaoDias * 86400) * 1000).toLocaleString("pt-BR")}</b></div>` : ""}
      ${t.estado === 3 ? `<div class="linha"><span>Propostas (ao trabalhador)</span><b>cliente ${t.propostaCliente ? (t.propostaCliente - 1) / 100 + "%" : "—"} · trabalhador ${t.propostaTrabalhador ? (t.propostaTrabalhador - 1) / 100 + "%" : "—"}</b></div>` : ""}
      ${t.kitGas > 0n ? `<div class="linha"><span>⛽ Gás para o trabalhador</span><b>${fmt(t.kitGas, 18, 3)} POL (chega quando o trabalho for confirmado)</b></div>` : ""}
      ${t.caucao > 0n ? `<div class="linha"><span>Caução do entregador</span><b>${fmt(t.caucao)} BRLS ${t.caucaoTravada ? "· travada" : ""}</b></div>` : ""}
      ${temArbitros ? `<div class="linha"><span>Árbitro do cliente</span><span>${esc(curto(t.arbitroCliente))}</span></div>
        <div class="linha"><span>Árbitro do trabalhador</span><span>${t.arbitroTrabalhador !== z ? esc(curto(t.arbitroTrabalhador)) : "indicado ao aceitar"}</span></div>
        ${t.estado === 3 ? `<div class="linha"><span>Propostas dos árbitros</span><b>${propArb(t.propostaArbCliente)} · ${propArb(t.propostaArbTrabalhador)}</b></div>` : ""}` : ""}
      ${t.desempateCriador ? `<div class="linha"><span>Desempate</span><b>criador da rede (opcional)</b></div>` : ""}
    </div>
    ${semPol ? `<div class="aviso">⛽ Você está sem POL. Tudo bem: ao tocar numa ação, o app gera um <b>QR</b> para a outra pessoa enviar por você (ela paga a taxa).</div>` : ""}
    ${S.imp.Encaminhador && !souCliente ? "" : S.imp.Encaminhador ? `<button class="btn sec" data-acao="semgas-ler">📷 Ler pedido sem gás da outra pessoa</button>` : ""}
    ${pedirEndereco ? `<div class="aviso">📍 <b>Falta um passo:</b> envie o endereço completo para quem aceitou, senão a pessoa não sabe aonde ir.<br><small>${esc(enderecoGuardado)}</small></div><button class="btn prim" data-acao="enviar-endereco">📍 Enviar endereço (cifrado)</button>` : ""}
    ${souCliente && enderecoGuardado && enderecoEnviado ? `<p class="mudo">📍 Endereço enviado pela conversa: ${esc(enderecoGuardado)}</p>` : ""}
    ${!souCliente && souParte && (t.modalidade === 0 || t.modalidade === 1) && t.estado === 1 ? `<p class="mudo">📍 O endereço completo chega na 💬 conversa deste trabalho.</p>` : ""}
    ${(souParte || souArbitro || (t.desempateCriador && S.endereco.toLowerCase() === CREATOR_TREASURY.toLowerCase())) && t.trabalhador !== z ? `<button class="btn sec" data-acao="abrir-chat">💬 Conversar com ${souCliente ? "o trabalhador" : souArbitro ? "as partes" : "o cliente"}</button>` : ""}
    ${chegada ? `<h2>📍 Código de chegada</h2><p class="mudo">Deixe no local ou mostre ao trabalhador quando ele chegar.</p>${qrSvg(chegada)}<div class="codigo">${esc(chegada)}</div>` : ""}
    ${codigo ? `<h2>🔑 Código de ${t.modalidade === 1 ? "entrega" : "liberação"}</h2><p class="mudo">Entregue só a quem recebe, na hora da entrega.</p>${qrSvg(codigo)}<div class="codigo">${esc(codigo)}</div>` : ""}
    ${devolucao ? `<details class="cartao"><summary><b>↩️ Código de devolução</b> (só se a mercadoria voltar para você)</summary><p class="mudo">Entregue ao entregador <b>somente</b> quando ele devolver a mercadoria em suas mãos. Com ele, você recebe o pagamento de volta e ele recupera a caução.</p>${qrSvg(devolucao)}<div class="codigo">${esc(devolucao)}</div></details>` : ""}
    ${acoes.includes("aceitar") && temArbitros ? `<label for="tr-arb">Seu árbitro para disputas (endereço 0x… de alguém de sua confiança)</label><input id="tr-arb" autocomplete="off" autocapitalize="none" placeholder="0x…">` : ""}
    ${acoes.includes("aceitar") && t.caucao > 0n ? `<div class="aviso">Ao aceitar, ${fmt(t.caucao)} BRLS da sua carteira ficam travados como caução. Eles voltam quando você usar o código de entrega (ou o de devolução, se trouxer a mercadoria de volta). <b>Nunca entregue nem devolva a mercadoria sem receber o código.</b></div>` : ""}
    ${acoes.includes("confirmarChegada") ? `<label for="tr-chegada">Cheguei: código de chegada que está no local</label><input id="tr-chegada" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="palavras do código"><button class="btn sec" data-acao="scan-chegada">📷 Escanear QR</button>${botaoSegurar("confirmar que cheguei", "tr-chegada")}` : ""}
    ${acoes.includes("confirmarComCodigo") ? `<label for="tr-cod">Código de ${t.modalidade === 1 ? "entrega" : "liberação"}</label><input id="tr-cod" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="palavras do código"><button class="btn sec" data-acao="scan-codigo">📷 Escanear QR</button>${botaoSegurar("confirmar com o código", "tr-codigo")}` : ""}
    ${acoes.includes("confirmarDevolucao") && !souCliente ? `<details class="cartao"><summary><b>↩️ Devolver a mercadoria</b></summary><p class="mudo">Só devolva na mão do cliente e em troca do código de devolução. Com o código, você recupera a caução.</p><label for="tr-dev">Código de devolução</label><input id="tr-dev" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="palavras do código"><button class="btn sec" data-acao="scan-devolucao">📷 Escanear QR</button>${botaoSegurar("confirmar a devolução", "tr-devolucao")}</details>` : ""}
    ${acoes.includes("arbitrar") ? `<h2>⚖️ Sua proposta como árbitro</h2><label for="tr-arbitrar">Quanto do restante vai ao trabalhador? <b id="tr-arbitrar-v">50%</b></label><input type="range" id="tr-arbitrar" min="0" max="100" value="50">${botaoSegurar("enviar proposta de árbitro", "tr-arbitrar")}<p class="mudo">Se o outro árbitro propuser o mesmo número, a divisão acontece na hora.</p>` : ""}
    ${acoes.includes("desempatar") ? `<h2>⚖️ Desempate do criador</h2><label for="tr-desempate">Ao trabalhador: <b id="tr-desempate-v">${Math.round((lim[0] + lim[1]) / 200)}%</b> (entre ${lim[0] / 100}% e ${lim[1] / 100}%)</label><input type="range" id="tr-desempate" min="${Math.ceil(lim[0] / 100)}" max="${Math.floor(lim[1] / 100)}" value="${Math.round((lim[0] + lim[1]) / 200)}">${botaoSegurar("desempatar", "tr-desempatar")}` : ""}
    ${acoes.includes("proporAcordo") ? `<label for="tr-acordo">Proposta: quanto do restante vai ao trabalhador? <b id="tr-acordo-v">50%</b></label><input type="range" id="tr-acordo" min="0" max="100" value="50">${botaoSegurar("propor acordo", "tr-acordo")}` : ""}
    ${acoes.includes("avaliar") ? `<h2>Avalie a outra parte</h2><div class="estrelas" role="group" aria-label="Estrelas">${[1, 2, 3, 4, 5].map((n) => `<button data-estrela="${n}" aria-label="${n} estrelas">★</button>`).join("")}</div>${botaoSegurar("enviar avaliação", "tr-avaliar")}` : ""}
    ${acoes.filter((a) => ROTULOS[a]).map((a) => (["abrirDisputa", "desistir", "cancelar", "recusarCandidato"].includes(a) ? `<button class="btn perigo segurar" data-confirmar="tr-${a}"><i>✋ Segure para ${esc(ROTULOS[a])}</i></button>` : botaoSegurar(ROTULOS[a], `tr-${a}`))).join("")}
    ${acoes.length === 0 ? `<p class="mudo">Nenhuma ação disponível para você agora.</p>` : ""}
    <button class="btn sec" data-ir="TRABALHOS">Voltar</button>`);
  for (const n of ["acordo", "arbitrar", "desempate"]) $(`#tr-${n}`)?.addEventListener("input", (ev) => ($(`#tr-${n}-v`).textContent = `${ev.target.value}%`));
};

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
      ${msgs.map((m) => `<div class="msg ${m.de.toLowerCase() === S.endereco.toLowerCase() ? "minha" : ""}"><small class="mudo">${esc(papelDe(t, m.de))}${m.em ? " · " + new Date(m.em * 1000).toLocaleString("pt-BR") : ""}</small><p>${esc(m.texto)}</p></div>`).join("") || `<p class="mudo">Nenhuma mensagem ainda. Diga olá! 👋</p>`}
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
    <button class="btn perigo segurar" data-confirmar="apagar"><i>✋ Segure para apagar deste aparelho</i></button>
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
  switch (nome) {
    case "fechar-modal":
      S.pinRecente = null;
      fecharModal();
      if (ABERTAS.includes(S.tela)) render().catch(mostrarErro);
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
    case "restaurar-ok": {
      const f = $("#frase").value;
      const problema = K.problemaDaFrase(f);
      if (problema) {
        $("#msg").innerHTML = `<div class="erro">${esc(problema)}</div>`;
        return;
      }
      S.frasePendente = K.normalizarFrase(f);
      return ir("DEFINIR_PIN");
    }
    case "esqueci":
      modal(`<h2>Restaurar com as palavras?</h2><p>Isso apaga a carteira cifrada deste aparelho. Seu dinheiro fica intacto e volta com as suas palavras (12 ou 24).</p>
        <button class="btn perigo segurar" data-confirmar="esqueci"><i>✋ Segure para continuar</i></button><button class="btn sec" data-acao="fechar-modal">Cancelar</button>`);
      return;
    case "biometria": {
      const frase = await K.abrirComBiometria();
      abrirSessao(frase);
      return ir("INICIO");
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
      const prep = await S.chat.preparar(idConversa(S.imp.EscrowTrabalho, t.id), S.carteira, participantes(t), `📍 Endereço: ${end}`, txs);
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
    default:
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
  const enderecoCompleto = ($("#tn-endereco")?.value || "").trim();
  if ((m === 0 || m === 1) && regiao.length < 3) throw new Error("Informe o bairro e a cidade");
  if ((m === 0 || m === 1) && enderecoCompleto.length < 8) throw new Error("Informe o endereço completo: sem ele a pessoa não sabe aonde ir");
  const valor = lerValor($("#tn-valor").value, 18);
  if (valor === 0n) throw new Error("Informe o pagamento");
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
    descricao: (regiao ? `📍 ${regiao} · ` : "") + $("#tn-desc").value.trim().slice(0, 100),
  };
  const chaveEnd = m === 0 ? chegadaHash : codigoHash;
  if (enderecoCompleto) try { localStorage.setItem(`xbrl.endereco.${chaveEnd}`, enderecoCompleto); } catch { /* sem armazenamento */ }
  const kit = S.imp.Encaminhador ? lerValor($("#tn-kit")?.value || "0", 18) : 0n;
  if (kit > E.parseEther("5")) throw new Error("O gás para o trabalhador pode ser no máximo 5 POL");
  if (saldoPol < kit + E.parseEther("0.05")) throw new Error(`Você tem ${fmt(saldoPol, 18, 3)} POL: não dá para deixar ${fmt(kit, 18, 3)} de gás para o trabalhador e ainda pagar a taxa. Diminua o valor.`);
  await executar("Contratar", [passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, valor, "Autorizar BRLS"), { rotulo: "Travar pagamento", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(p, { ...o, value: kit }) }]);
  if (codigo || chegada) {
    modal(`<h2>✅ Pagamento travado</h2>
      ${chegada ? `<p><b>📍 Código de chegada</b> — deixe no local ou mostre na porta:</p>${qrSvg(chegada)}<div class="codigo" id="cod-chegada">${esc(chegada)}</div>` : ""}
      ${codigo ? `<p><b>🔑 Código de ${m === 1 ? "entrega" : "liberação"}</b> — entregue <b>só</b> a quem recebe, no momento em que receber:</p>${qrSvg(codigo)}<div class="codigo" id="cod-liberacao">${esc(codigo)}</div>` : ""}
      ${devolucao ? `<p><b>↩️ Código de devolução</b> — só se a mercadoria voltar para as suas mãos:</p><div class="codigo" id="cod-devolucao">${esc(devolucao)}</div>` : ""}
      <p class="mudo">Os códigos também ficam salvos neste aparelho, na tela do trabalho.</p><button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
  }
  ir("TRABALHOS", { aba: "meus" });
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
    return ir("INICIO");
  }
  ir(K.existeCofre() ? "BLOQUEADA" : "BOAS_VINDAS");
}

iniciar().catch((e) => {
  console.error(e);
  $("#tela").innerHTML = `<div class="erro">Falha ao iniciar: ${esc(traduzirErro(e))}</div>`;
});

// Exposto só para testes automatizados (sem chaves).
window.__xbrl = { estado: () => ({ tela: S.tela, chainId: S.chainId, endereco: S.endereco, implantado: !!S.imp, ocupado: S.ocupado > 0 }) };
