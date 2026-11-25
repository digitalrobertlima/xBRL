// =====================================================================
// xBRL — Carteira Nativa (PWA) — máquina de estados travada
// - Só transições declaradas em TRANSICOES são possíveis (botão "voltar" do aparelho não fura o bloqueio).
// - A frase/chave só existe na memória enquanto a carteira está desbloqueada (auto-bloqueio em 5 min).
// - Ações que movem dinheiro exigem "segurar para confirmar"; desbloqueio exige "deslizar" + PIN.
// - Check-in de trabalho exige GPS com precisão ≤ 50 m e distância ≤ 80 m.
// =====================================================================
import { ABIS, CREATOR_TREASURY, ESCROW, REDE_PADRAO, REDES, SEGURANCA, TANQUE, VERSAO, carregarImplantacao, linkExplorer } from "./config.js";
import * as K from "./keystore.js";
import * as G from "./gas-tank.js";
import { EscrowClient, NOMES_NIVEL, codigoGuardado, codigoTemFormatoValido, distanciaMetros, gerarCodigoEntrega, guardarCodigo, hashCodigo, lerGps, normalizarCodigo, paraMicro } from "./escrow-client.js";

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
const ABERTAS = ["INICIO", "ENVIAR", "RECEBER", "RESERVA", "TRABALHOS", "TRABALHO_NOVO", "TRABALHO", "TANQUE", "AJUSTES", "BACKUP"];
const TRANSICOES = {
  CARREGANDO: ["BOAS_VINDAS", "BLOQUEADA"],
  BOAS_VINDAS: ["CRIAR_FRASE", "RESTAURAR"],
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
  $("#btn-bloquear").hidden = !aberta;
  for (const b of $$("#abas button")) b.toggleAttribute("aria-current", false);
  const aba = { TRABALHO_NOVO: "TRABALHOS", TRABALHO: "TRABALHOS", ENVIAR: "INICIO", RECEBER: "INICIO", TANQUE: "INICIO", BACKUP: "AJUSTES" }[destino] || destino;
  $(`#abas button[data-ir="${aba}"]`)?.setAttribute("aria-current", "page");
  if (aberta) history.replaceState({ tela: destino }, "", location.pathname + location.search);
  window.scrollTo(0, 0);
  render().catch(mostrarErro);
  return true;
}

// O botão "voltar" do sistema nunca sai do estado atual de forma insegura.
history.pushState({ trava: true }, "", location.href);
window.addEventListener("popstate", () => {
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
  EmissaoPausada: "Emissão com este lastro está pausada. Resgates seguem livres.",
  SaidaMinimaNaoAtingida: "A cotação mudou. Atualize e tente de novo.",
  ForaDoRaio: "Você está a mais de 80 m do local.",
  CheckInObrigatorio: "Faça o check-in no local primeiro.",
  CodigoIncorreto: "Código incorreto.",
  RevisaoEmAndamento: "O cliente ainda tem prazo para revisar a entrega.",
  PrazoNaoVencido: "O prazo ainda não venceu.",
  PrazoInvalido: "Prazo inválido.",
  EstadoInvalido: "O trabalho mudou de situação. Atualize a tela.",
  JaAvaliou: "Você já avaliou este trabalho.",
  ERC20InsufficientBalance: "Saldo insuficiente.",
  ERC20InsufficientAllowance: "Autorização insuficiente.",
};

function traduzirErro(e) {
  const nome = e?.revert?.name || e?.info?.error?.data?.name;
  if (nome && MENSAGENS[nome]) return MENSAGENS[nome];
  const msg = String(e?.shortMessage || e?.message || e);
  if (/insufficient funds/i.test(msg)) return "POL insuficiente para a taxa da rede. Abasteça o tanque.";
  if (/user rejected|denied/i.test(msg)) return "Operação cancelada.";
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
  const rpcs = S.rede.rpcs;
  if (rpcs.length === 1) {
    S.provider = new E.JsonRpcProvider(rpcs[0], chainId, { staticNetwork: true, polling: true, pollingInterval: 1000 });
  } else {
    const net = E.Network.from(chainId);
    S.provider = new E.FallbackProvider(
      rpcs.map((u, i) => ({ provider: new E.JsonRpcProvider(u, net, { staticNetwork: net }), priority: i + 1, weight: 1, stallTimeout: 2500 })),
      net,
      { quorum: 1 },
    );
  }
  S.imp = await carregarImplantacao(chainId);
  S.escrow = S.imp ? new EscrowClient(S.provider, chainId, S.imp.EscrowTrabalho, S.imp.blocoInicial) : null;
  const chip = $("#rede");
  chip.textContent = S.rede.curto;
  chip.classList.toggle("teste", chainId !== 137);
  if (S.carteira) S.carteira = S.carteira.connect(S.provider);
  S.tokensInfo = await montarListaTokens();
}

async function montarListaTokens() {
  const lista = [];
  if (S.imp) lista.push({ simbolo: "xBRL", nome: "Real Soberano", endereco: S.imp.xBRL, decimais: 18, principal: true });
  const conhecidos = new Set(lista.map((t) => t.endereco.toLowerCase()));
  for (const t of S.rede.tokens) {
    if (!conhecidos.has(t.endereco.toLowerCase())) {
      lista.push(t);
      conhecidos.add(t.endereco.toLowerCase());
    }
  }
  for (const l of S.imp?.lastros || []) {
    if (conhecidos.has(l.toLowerCase())) continue;
    try {
      const c = new E.Contract(l, ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], S.provider);
      const [simbolo, decimais] = await Promise.all([c.symbol(), c.decimals()]);
      lista.push({ simbolo: String(simbolo).slice(0, 12), nome: "Lastro", endereco: l, decimais: Number(decimais), lastro: true });
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
    const auto = await G.abastecerSeNecessario(S.provider, S.carteira, S.chainId, preferidos, opts).catch(() => null);
    if (auto) toast(`⛽ Tanque abastecido com ${auto.simbolo}`);
    for (const [i, p] of passos.entries()) {
      modal(`<div class="giro"></div><h2>${esc(titulo)}</h2><p>Passo ${i + 1} de ${passos.length}: ${esc(p.rotulo)}</p><p class="mudo">Assinando no seu aparelho…</p>`);
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

/** Aprova só o necessário (nunca infinito). */
function passoAprovar(token, gastador, valor, rotulo = "Autorizar") {
  return {
    rotulo,
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

function bloquear() {
  S.carteira = null;
  S.frasePendente = null;
  S.pinPendente = null;
  fecharModal();
  S.tela = "BLOQUEADA";
  ir("BLOQUEADA");
}

["pointerdown", "keydown", "scroll"].forEach((ev) => addEventListener(ev, () => (S.ultimoUso = Date.now()), { passive: true }));
setInterval(() => {
  if (S.carteira && Date.now() - S.ultimoUso > SEGURANCA.bloqueioAutomaticoMs) bloquear();
}, 10_000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) S.ocultoEm = Date.now();
  else if (S.carteira && S.ocultoEm && Date.now() - S.ocultoEm > 60_000) bloquear();
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
  <div class="cartao ouro" style="text-align:center">
    <div class="marca" style="justify-content:center;font-size:30px"><span class="moeda" style="width:54px;height:54px;font-size:20px">R$</span><span>x<b>BRL</b></span></div>
    <h1>O Real soberano, no seu bolso</h1>
    <p class="mudo">Cada xBRL vale R$ 1, lastreado 1:1 em stablecoins de Real. Ninguém congela, ninguém confisca: a chave é só sua.</p>
  </div>
  <button class="btn prim" data-acao="criar">Criar minha carteira</button>
  <button class="btn sec" data-acao="restaurar">Já tenho as 12 palavras</button>
  <div class="aviso">Sem cadastro, sem servidor. Se você perder as 12 palavras, ninguém (nem nós) consegue recuperar seu dinheiro.</div>`);

TELAS.CRIAR_FRASE = () => {
  S.frasePendente ||= K.gerarFrase();
  const p = S.frasePendente.split(" ");
  tela(`
    <h1>Suas 12 palavras</h1>
    <p class="mudo">Elas SÃO a sua carteira. Anote no papel, na ordem, e guarde longe de fotos e nuvem.</p>
    <ol class="palavras borrado" id="palavras">${p.map((w) => `<li>${esc(w)}</li>`).join("")}</ol>
    <button class="btn sec" data-acao="revelar">👁️ Mostrar palavras</button>
    <div class="aviso">Nunca digite essas palavras em sites ou mensagens. Ninguém do xBRL vai pedir.</div>
    ${botaoSegurar("confirmar que anotei", "anotei")}
    <button class="btn sec" data-acao="voltar-boas-vindas">Voltar</button>`);
};

TELAS.CONFIRMAR_FRASE = () => {
  const pos = [];
  while (pos.length < 3) {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % 12;
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
  <h1>Restaurar carteira</h1><p class="mudo">Digite as 12 palavras separadas por espaço.</p>
  <textarea id="frase" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="12 palavras"></textarea>
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
  });

TELAS.BLOQUEADA = async () => {
  const bio = K.temBiometria();
  tela(`
    <div class="cartao ouro" style="text-align:center">
      <p class="mudo">Carteira</p><p class="endereco" style="text-align:center">${esc(curto(K.enderecoSalvo()))}</p>
      <h1>🔒 Bloqueada</h1>
    </div>
    <div class="deslizar"><input type="range" id="deslize" min="0" max="100" value="0" aria-label="Deslize para desbloquear"><span>Deslize para desbloquear ➜</span></div>
    ${bio ? `<button class="btn sec" data-acao="biometria">👆 Usar biometria</button>` : ""}
    <button class="btn sec" data-acao="esqueci" style="margin-top:30px">Esqueci o PIN (restaurar com 12 palavras)</button>`);
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
    ${S.imp ? "" : `<div class="aviso">O protocolo xBRL ainda não foi implantado na rede ${esc(S.rede.nome)}. Você já pode guardar e enviar POL e stablecoins.</div>`}
    <div class="cartao ouro">
      <p class="mudo">Saldo em xBRL</p>
      <div class="saldo">${fmt(saldoX)}<small>xBRL</small></div>
      <p class="mudo">≈ ${reais(saldoX)} · <span class="selo verde">inconfiscável</span></p>
    </div>
    <div class="grade">
      <button class="atalho" data-ir="ENVIAR"><span>📤</span>Enviar</button>
      <button class="atalho" data-ir="RECEBER"><span>📥</span>Receber</button>
      <button class="atalho" data-ir="RESERVA"><span>🪙</span>Comprar</button>
      <button class="atalho" data-acao="modo-resgatar"><span>💵</span>Resgatar</button>
      <button class="atalho" data-ir="TRABALHOS"><span>🤝</span>Trabalhos</button>
      <button class="atalho" data-ir="TANQUE"><span>⛽</span>Tanque</button>
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
  <p class="mudo">Envie para este endereço somente pela rede <b>${esc(S.rede.nome)}</b>: xBRL, POL, BRZ, BRLA, USDC.</p>
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
    <label for="env-para">Para (endereço 0x…)</label><input id="env-para" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="0x…">
    <label for="env-valor">Valor</label><input id="env-valor" class="grande" inputmode="decimal" placeholder="0,00">
    <div id="env-prev" class="mudo"></div>
    ${botaoSegurar("enviar", "enviar")}`);
  const atualizar = async () => {
    const out = $("#env-prev");
    try {
      const sel = $("#env-token").value;
      const t = sel === "nativo" ? null : S.tokensInfo[Number(sel)];
      const v = lerValor($("#env-valor").value, t ? t.decimais : 18);
      if (t?.principal) {
        const para = E.isAddress($("#env-para").value) ? $("#env-para").value : E.ZeroAddress;
        const [liq, taxa] = await c("xBRL").previewTransferencia(S.endereco, para, v);
        out.innerHTML = `Chega ao destino: <b>${fmt(liq)}</b> xBRL · taxa do protocolo (0,1%): ${fmt(taxa, 18, 4)}`;
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
  const [fase, total, colat, supply, janela] = await Promise.all([r.fase(), r.lastroTotal(), r.colateralizacaoBps(), c("xBRL").totalSupply(), r.resgateDisponivelNaJanela()]);
  const lastros = S.tokensInfo.filter((t) => t.lastro && S.imp.lastros.map((x) => x.toLowerCase()).includes(t.endereco.toLowerCase()));
  const modo = S.params.modo || "emitir";
  const colatTxt = colat > 10n ** 30n ? "—" : `${(Number(colat) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
  tela(`
    <h1>Reserva BRL</h1>
    <div class="cartao">
      <div class="linha"><span>Fase</span><b>${Number(fase) === 1 ? "1 · paridade estrita" : "2 · estabilização algorítmica"}</b></div>
      <div class="linha"><span>xBRL em circulação</span><b>${fmt(supply)}</b></div>
      <div class="linha"><span>Lastro total</span><b>${reais(total)}</b></div>
      <div class="linha"><span>Colateralização</span><b>${colatTxt}</b></div>
      ${Number(fase) === 2 ? `<div class="linha"><span>Resgate livre nas 24 h</span><b>${fmt(janela)}</b></div>` : ""}
    </div>
    <div class="seg" role="group" aria-label="Operação">
      <button data-acao="modo-emitir" aria-pressed="${modo === "emitir"}">Comprar xBRL</button>
      <button data-acao="modo-resgatar" aria-pressed="${modo === "resgatar"}">Resgatar em reais</button>
    </div>
    <label for="res-lastro">${modo === "emitir" ? "Pagar com" : "Receber em"}</label>
    <select id="res-lastro">${lastros.map((t, i) => `<option value="${i}">${esc(t.simbolo)}</option>`).join("")}</select>
    <label for="res-valor">${modo === "emitir" ? "Quantidade do lastro" : "Quantidade de xBRL"}</label>
    <input id="res-valor" class="grande" inputmode="decimal" placeholder="0,00">
    <div id="res-cot" class="mudo"></div>
    ${S.chainId !== 137 && lastros[0] ? `<button class="btn sec" data-acao="torneira">🚰 Pegar 10.000 ${esc(lastros[0].simbolo)} de teste</button>` : ""}
    ${botaoSegurar(modo === "emitir" ? "comprar xBRL" : "resgatar", "reserva")}
    <p class="mudo">Taxa fixa de 0,1%. Na Fase 2 pode haver spread de até 0,40%, que fica na reserva como lastro extra. Resgates nunca podem ser pausados.</p>`);
  S.params.lastros = lastros;
  const cotar = async () => {
    const out = $("#res-cot");
    try {
      const t = lastros[Number($("#res-lastro").value)];
      if (modo === "emitir") {
        const v = lerValor($("#res-valor").value, t.decimais);
        const [liq, taxa, spread] = await r.cotarEmissao(t.endereco, v);
        out.innerHTML = `Você recebe <b>${fmt(liq)} xBRL</b> · taxa ${fmt(taxa, 18, 4)}${spread ? ` · spread ${fmt(spread, 18, 4)}` : ""}`;
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

// ---------- Trabalhos ----------
const estrelasNivel = (n) => `<span class="nivel" title="Nível ${n}">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;

TELAS.TRABALHOS = async () => {
  if (!S.escrow) return tela(`<h1>Trabalhos</h1><div class="aviso">Protocolo ainda não implantado nesta rede.</div>`);
  const aba = S.params.aba || "meus";
  tela(`<h1>Trabalhos</h1><div class="cartao" id="sinc"><div class="giro"></div><p class="mudo" id="sinc-txt">Lendo a blockchain…</p></div>`);
  await S.escrow.sincronizar(({ bloco, atual }) => {
    const t = $("#sinc-txt");
    if (t) t.textContent = `Lendo a blockchain… bloco ${bloco.toLocaleString("pt-BR")} de ${atual.toLocaleString("pt-BR")}`;
  });
  const [{ meus, vagas }, rep] = await Promise.all([S.escrow.listar(S.endereco), S.escrow.reputacao(S.endereco)]);
  const lista = aba === "meus" ? meus : vagas;
  const card = (t) => {
    const m = ESCROW.modalidades[t.modalidade];
    const papel = t.cliente.toLowerCase() === S.endereco.toLowerCase() ? "Você contratou" : t.trabalhador.toLowerCase() === S.endereco.toLowerCase() ? "Você trabalha" : "Vaga aberta";
    return `<button class="item" data-trabalho="${esc(t.id)}"><span class="ic">${m.icone}</span><span class="meio"><b>${esc(t.descricao || m.nome)}</b><span class="mudo">#${esc(t.id)} · ${esc(m.nome)} · ${esc(papel)}</span></span><b>${fmt(t.valor)}</b></button>`;
  };
  tela(`
    <h1>Trabalhos</h1>
    <div class="cartao"><div class="linha"><span>Sua reputação</span><span>${estrelasNivel(rep.nivel)} <b>${esc(rep.nomeNivel)}</b></span></div>
      <p class="mudo">${Number(rep.concluidos)} concluídos · média ${rep.media.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ★ · ${Number(rep.disputas)} disputas</p></div>
    <button class="btn prim" data-ir="TRABALHO_NOVO">+ Contratar alguém</button>
    <div class="seg" role="group"><button data-acao="aba-meus" aria-pressed="${aba === "meus"}">Meus (${meus.length})</button><button data-acao="aba-vagas" aria-pressed="${aba === "vagas"}">Vagas abertas (${vagas.length})</button></div>
    ${lista.map(card).join("") || `<p class="mudo">Nada por aqui ainda.</p>`}`);
};

TELAS.TRABALHO_NOVO = () => {
  const m = Number(S.params.modalidade ?? 0);
  const presencial = m === 0 || m === 1;
  tela(`
    <h1>Contratar</h1>
    <div class="grade duas">${ESCROW.modalidades.map((x) => `<button class="atalho" data-acao="mod-${x.id}" aria-pressed="${x.id === m}" style="${x.id === m ? "border-color:var(--o400);background:rgba(212,175,55,.14)" : ""}"><span>${x.icone}</span>${esc(x.nome)}</button>`).join("")}</div>
    <p class="mudo">${esc(ESCROW.modalidades[m].resumo)}</p>
    <label for="tn-desc">O que precisa ser feito</label><input id="tn-desc" maxlength="140" placeholder="Ex.: Entregar 50 pastéis na Rua X">
    <label for="tn-valor">Pagamento (xBRL)</label><input id="tn-valor" class="grande" inputmode="decimal" placeholder="0,00">
    <label for="tn-prazo">Prazo (dias)</label><input id="tn-prazo" inputmode="numeric" value="7">
    ${m === 3 ? `<label for="tn-etapas">Número de etapas (2 a 50)</label><input id="tn-etapas" inputmode="numeric" value="3">` : ""}
    <label for="tn-trab">Trabalhador (opcional: vazio = vaga aberta)</label><input id="tn-trab" autocomplete="off" autocapitalize="none" placeholder="0x…">
    ${presencial ? `
      <label>Local ${m === 1 ? "de entrega" : "do serviço"}</label>
      <button class="btn sec" data-acao="tn-gps">📍 Usar minha localização atual</button>
      <div class="grade duas"><input id="tn-lat" inputmode="decimal" placeholder="Latitude (-19.932)" aria-label="Latitude"><input id="tn-lon" inputmode="decimal" placeholder="Longitude (-43.938)" aria-label="Longitude"></div>` : ""}
    ${m === 1 ? `<div class="ok">Um código de 5 palavras será gerado. Passe-o só para quem vai receber.</div>` : m !== 3 ? `<label class="linha" style="color:var(--txt)"><span>Exigir código para liberar</span><input type="checkbox" id="tn-cod" style="width:auto"></label>` : ""}
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
  S.params.t = t;
  const ROTULOS = {
    aceitar: "aceitar o trabalho", cancelar: "cancelar e reaver o valor", checkIn: "fazer check-in (GPS)", marcarEntregue: "marcar como entregue",
    liberar: t.modalidade === 3 && t.etapasPagas + 1 < t.etapas ? `liberar a etapa ${t.etapasPagas + 1}` : "aprovar e pagar", reivindicar: "receber (prazo de revisão vencido)",
    desistir: "desistir (devolve ao cliente)", aprovarCandidato: "aprovar este trabalhador", recusarCandidato: "recusar o candidato",
    retirarCandidatura: "retirar minha candidatura", abrirDisputa: "abrir disputa", reembolsarPorPrazo: "reaver (prazo vencido)", resolverPorTempo: "executar divisão 50/50",
  };
  tela(`
    <h1>${m.icone} ${esc(resumo?.descricao || m.nome)}</h1>
    <p class="mudo">#${esc(t.id)} · ${esc(m.nome)} · <span class="selo">${esc(t.estadoNome)}</span></p>
    <div class="cartao">
      <div class="linha"><span>Valor</span><b>${fmt(t.valor)} xBRL</b></div>
      <div class="linha"><span>Já pago</span><b>${fmt(t.pago)} xBRL</b></div>
      ${t.etapas > 1 ? `<div class="linha"><span>Etapas pagas</span><b>${t.etapasPagas} de ${t.etapas}</b></div>` : ""}
      <div class="linha"><span>Prazo</span><b>${new Date(t.prazo * 1000).toLocaleString("pt-BR")}</b></div>
      <div class="linha"><span>Cliente</span><span>${esc(curto(t.cliente))} ${estrelasNivel(rc.nivel)}</span></div>
      <div class="linha"><span>${t.pendenteAprovacao ? "Candidato" : "Trabalhador"}</span><span>${t.trabalhador === E.ZeroAddress ? "vaga aberta" : `${esc(curto(t.trabalhador))} ${estrelasNivel(rt.nivel)} ${rt ? `<small class="mudo">${Number(rt.concluidos)} feitos</small>` : ""}`}</span></div>
      ${t.pendenteAprovacao ? `<div class="linha"><span>Situação</span><b>aguardando o cliente aprovar</b></div>` : ""}
      ${t.modalidade <= 1 ? `<div class="linha"><span>Local</span><span>${(t.lat / 1e6).toFixed(6)}, ${(t.lon / 1e6).toFixed(6)} ${t.checkin ? '<span class="selo verde">check-in ok</span>' : ""}</span></div>` : ""}
      ${t.estado === 2 ? `<div class="linha"><span>Pagamento automático em</span><b>${new Date((t.entregueEm + ESCROW.prazoRevisaoDias * 86400) * 1000).toLocaleString("pt-BR")}</b></div>` : ""}
      ${t.estado === 3 ? `<div class="linha"><span>Propostas (ao trabalhador)</span><b>cliente ${t.propostaCliente ? (t.propostaCliente - 1) / 100 + "%" : "—"} · trabalhador ${t.propostaTrabalhador ? (t.propostaTrabalhador - 1) / 100 + "%" : "—"}</b></div>` : ""}
    </div>
    ${codigo ? `<p class="mudo">Código de liberação (entregue só a quem recebe):</p><div class="codigo">${esc(codigo)}</div>` : ""}
    ${acoes.includes("confirmarComCodigo") ? `<label for="tr-cod">Código de liberação</label><input id="tr-cod" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="5 palavras, ex.: abacate bolsa canela dente elogio">${botaoSegurar("confirmar com o código", "tr-codigo")}` : ""}
    ${acoes.includes("proporAcordo") ? `<label for="tr-acordo">Proposta: quanto do restante vai ao trabalhador? <b id="tr-acordo-v">50%</b></label><input type="range" id="tr-acordo" min="0" max="100" value="50">${botaoSegurar("propor acordo", "tr-acordo")}` : ""}
    ${acoes.includes("avaliar") ? `<h2>Avalie a outra parte</h2><div class="estrelas" role="group" aria-label="Estrelas">${[1, 2, 3, 4, 5].map((n) => `<button data-estrela="${n}" aria-label="${n} estrelas">★</button>`).join("")}</div>${botaoSegurar("enviar avaliação", "tr-avaliar")}` : ""}
    ${acoes.filter((a) => ROTULOS[a]).map((a) => (["abrirDisputa", "desistir", "cancelar", "recusarCandidato"].includes(a) ? `<button class="btn perigo segurar" data-confirmar="tr-${a}"><i>✋ Segure para ${esc(ROTULOS[a])}</i></button>` : botaoSegurar(ROTULOS[a], `tr-${a}`))).join("")}
    ${acoes.length === 0 ? `<p class="mudo">Nenhuma ação disponível para você agora.</p>` : ""}
    <button class="btn sec" data-ir="TRABALHOS">Voltar</button>`);
  $("#tr-acordo")?.addEventListener("input", (ev) => ($("#tr-acordo-v").textContent = `${ev.target.value}%`));
};

TELAS.AJUSTES = async () => {
  const bioDisp = await K.biometriaDisponivel();
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const redes = Object.values(REDES).filter((r) => !r.somenteDev || local);
  tela(`
    <h1>Ajustes</h1>
    <label for="aj-rede">Rede</label>
    <select id="aj-rede">${redes.map((r) => `<option value="${r.chainId}" ${r.chainId === S.chainId ? "selected" : ""}>${esc(r.nome)}</option>`).join("")}</select>
    <div class="cartao">
      <div class="linha"><span>Biometria (chave no chip)</span><b>${K.temBiometria() ? "ativada" : bioDisp ? "disponível" : "indisponível"}</b></div>
      ${bioDisp && !K.temBiometria() ? `<button class="btn sec" data-acao="bio-ativar">👆 Ativar biometria</button>` : ""}
      ${K.temBiometria() ? `<button class="btn sec" data-acao="bio-desativar">Desativar biometria</button>` : ""}
    </div>
    <button class="btn sec" data-ir="BACKUP">🔑 Ver minhas 12 palavras</button>
    <button class="btn sec" data-acao="trocar-pin">🔢 Trocar PIN</button>
    <button class="btn sec" data-acao="bloquear">🔒 Bloquear agora</button>
    <div class="cartao">
      <h2 style="margin-top:0">Sobre</h2>
      <div class="linha"><span>Versão</span><b>${esc(VERSAO)}</b></div>
      <div class="linha"><span>Sua carteira</span><a href="${esc(linkExplorer(S.chainId, "address", S.endereco))}" target="_blank" rel="noopener">${esc(curto(S.endereco))}</a></div>
      ${S.imp ? ["xBRL", "ReservaBRL", "EscrowTrabalho"].map((n) => `<div class="linha"><span>${n}</span><a href="${esc(linkExplorer(S.chainId, "address", S.imp[n]))}" target="_blank" rel="noopener">${esc(curto(S.imp[n]))}</a></div>`).join("") : ""}
      <div class="linha"><span>Taxa vitalícia 0,1% para</span><span>${esc(curto(CREATOR_TREASURY))}</span></div>
    </div>
    <h2>Zona de perigo</h2>
    <label for="aj-apagar">Para apagar a carteira deste aparelho, digite APAGAR</label><input id="aj-apagar" autocomplete="off">
    <button class="btn perigo segurar" data-confirmar="apagar"><i>✋ Segure para apagar deste aparelho</i></button>
    <p class="mudo">Apagar não mexe no dinheiro: ele continua na blockchain e volta com as 12 palavras.</p>`);
  $("#aj-rede").addEventListener("change", async (ev) => {
    const id = Number(ev.target.value);
    localStorage.setItem("xbrl.rede", String(id));
    await conectarRede(id);
    toast(`Rede: ${REDES[id].nome}`);
    ir("INICIO");
  });
};

TELAS.BACKUP = () =>
  tecladoPin("Confirme o PIN", "Para mostrar as 12 palavras.", async (pin) => {
    const frase = await K.abrirComPin(pin);
    tela(`<h1>Suas 12 palavras</h1><ol class="palavras">${frase.split(" ").map((w) => `<li>${esc(w)}</li>`).join("")}</ol>
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
      fecharModal();
      if (ABERTAS.includes(S.tela)) render().catch(mostrarErro);
      return;
    case "criar":
      S.frasePendente = null;
      return ir("CRIAR_FRASE");
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
      const ok = S.params.posicoes.every((i) => $(`#w${i}`).value.trim().toLowerCase() === p[i]);
      if (!ok) {
        $("#msg").innerHTML = `<div class="erro">Alguma palavra não confere. Veja de novo a sua anotação.</div>`;
        return;
      }
      return ir("DEFINIR_PIN");
    }
    case "restaurar-ok": {
      const f = $("#frase").value;
      if (!K.fraseValida(f)) {
        $("#msg").innerHTML = `<div class="erro">Frase inválida. Confira as 12 palavras e a ordem.</div>`;
        return;
      }
      S.frasePendente = K.normalizarFrase(f);
      return ir("DEFINIR_PIN");
    }
    case "esqueci":
      modal(`<h2>Restaurar com 12 palavras?</h2><p>Isso apaga a carteira cifrada deste aparelho. Seu dinheiro fica intacto e volta com as 12 palavras.</p>
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
      if (navigator.share) return navigator.share({ title: "Meu endereço xBRL (Polygon)", text: S.endereco });
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
      return ir("TRABALHOS", { aba: nome.slice(4) });
    case "tn-gps": {
      toast("Lendo GPS…");
      const g = await lerGps();
      if (g.precisao > ESCROW.precisaoMaxGpsMetros) toast(`Precisão baixa (${Math.round(g.precisao)} m). Vá para céu aberto e tente de novo.`);
      $("#tn-lat").value = g.lat.toFixed(6);
      $("#tn-lon").value = g.lon.toFixed(6);
      return;
    }
    case "tq-cotar": {
      const t = S.params.candidatos[Number($("#tq-token").value)];
      if (S.params.faltam === 0n) return toast("O tanque já está cheio");
      $("#tq-cot").innerHTML = `<div class="giro"></div>`;
      const cot = await G.cotarAbastecimento(S.provider, S.chainId, t.endereco, S.params.faltam, t);
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
        const minimo = (liq * 995n) / 1000n; // tolerância 0,5% (spread da Fase 2 pode mudar)
        await executar("Comprar xBRL", [passoAprovar(t.endereco, S.imp.ReservaBRL, v, `Autorizar ${t.simbolo}`), { rotulo: "Emitir xBRL", fn: (o) => r.emitir(t.endereco, v, minimo, o) }]);
      } else {
        const v = lerValor($("#res-valor").value, 18);
        const [pago] = await c("ReservaBRL").cotarResgate(t.endereco, v);
        const minimo = (pago * 995n) / 1000n;
        await executar("Resgatar", [passoAprovar(S.imp.xBRL, S.imp.ReservaBRL, v, "Autorizar xBRL"), { rotulo: `Receber ${t.simbolo}`, fn: (o) => r.resgatar(t.endereco, v, minimo, o) }]);
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
    case "criar-trabalho":
      return criarTrabalho();
    default:
      if (nome?.startsWith("tr-")) return acaoTrabalho(nome.slice(3));
  }
}

async function criarTrabalho() {
  const m = Number(S.params.modalidade ?? 0);
  const valor = lerValor($("#tn-valor").value, 18);
  if (valor === 0n) throw new Error("Informe o pagamento");
  const dias = Math.max(1, Math.min(365, Number($("#tn-prazo").value) || 7));
  const trabTxt = $("#tn-trab").value.trim();
  if (trabTxt && !E.isAddress(trabTxt)) throw new Error("Endereço do trabalhador inválido");
  let lat = 0;
  let lon = 0;
  if (m <= 1) {
    const la = Number($("#tn-lat").value.replace(",", "."));
    const lo = Number($("#tn-lon").value.replace(",", "."));
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (la === 0 && lo === 0)) throw new Error("Informe o local (use o GPS ou digite latitude e longitude)");
    lat = paraMicro(la);
    lon = paraMicro(lo);
  }
  let codigo = null;
  if (m === 1 || $("#tn-cod")?.checked) codigo = gerarCodigoEntrega(valor >= E.parseEther("1000") ? 6 : 5);
  const codigoHash = codigo ? hashCodigo(S.imp.EscrowTrabalho, S.endereco, codigo) : E.ZeroHash;
  if (codigo) guardarCodigo(codigoHash, codigo);
  const p = {
    modalidade: m,
    trabalhador: trabTxt ? E.getAddress(trabTxt) : E.ZeroAddress,
    valor,
    prazo: BigInt(agora() + dias * 86400),
    lat,
    lon,
    etapas: m === 3 ? Math.max(2, Math.min(50, Number($("#tn-etapas").value) || 2)) : 1,
    codigoHash,
    descricao: $("#tn-desc").value.trim().slice(0, 140),
  };
  await executar("Contratar", [passoAprovar(S.imp.xBRL, S.imp.EscrowTrabalho, valor, "Autorizar xBRL"), { rotulo: "Travar pagamento", fn: (o) => c("EscrowTrabalho", true).criarTrabalho(p, o) }]);
  if (codigo) {
    modal(`<h2>✅ Pagamento travado</h2><p>Código de liberação (5 palavras) — entregue <b>só</b> a quem vai receber o serviço/entrega:</p><div class="codigo">${esc(codigo)}</div>
      <p class="mudo">Ele também fica salvo neste aparelho, na tela do trabalho.</p><button class="btn prim" data-acao="fechar-modal">Entendi</button>`);
  }
  ir("TRABALHOS", { aba: "meus" });
}

async function acaoTrabalho(nome) {
  const t = S.params.t;
  const k = c("EscrowTrabalho", true);
  const id = BigInt(t.id);
  const f = {
    aceitar: () => executar("Aceitar trabalho", [{ rotulo: "Aceitar", fn: (o) => k.aceitar(id, o) }]),
    cancelar: () => executar("Cancelar", [{ rotulo: "Cancelar", fn: (o) => k.cancelar(id, o) }]),
    desistir: () => executar("Desistir", [{ rotulo: "Desistir", fn: (o) => k.desistir(id, o) }]),
    retirarCandidatura: () => executar("Retirar candidatura", [{ rotulo: "Retirar", fn: (o) => k.desistir(id, o) }]),
    aprovarCandidato: () => executar("Aprovar trabalhador", [{ rotulo: "Aprovar", fn: (o) => k.decidirCandidato(id, true, o) }]),
    recusarCandidato: () => executar("Recusar candidato", [{ rotulo: "Recusar", fn: (o) => k.decidirCandidato(id, false, o) }]),
    marcarEntregue: () => executar("Marcar entregue", [{ rotulo: "Marcar entregue", fn: (o) => k.marcarEntregue(id, o) }]),
    liberar: () => executar("Pagar trabalhador", [{ rotulo: "Liberar", fn: (o) => k.liberar(id, o) }]),
    reivindicar: () => executar("Receber pagamento", [{ rotulo: "Receber", fn: (o) => k.reivindicar(id, o) }]),
    abrirDisputa: () => executar("Abrir disputa", [{ rotulo: "Abrir disputa", fn: (o) => k.abrirDisputa(id, o) }]),
    reembolsarPorPrazo: () => executar("Reaver valor", [{ rotulo: "Reembolso", fn: (o) => k.reembolsarPorPrazo(id, o) }]),
    resolverPorTempo: () => executar("Dividir 50/50", [{ rotulo: "Resolver", fn: (o) => k.resolverPorTempo(id, o) }]),
    acordo: () => {
      const bps = Number($("#tr-acordo").value) * 100;
      return executar("Propor acordo", [{ rotulo: `Propor ${bps / 100}% ao trabalhador`, fn: (o) => k.proporAcordo(id, bps, o) }]);
    },
    avaliar: () => {
      if (!S.params.estrelas) throw new Error("Escolha de 1 a 5 estrelas");
      return executar("Avaliar", [{ rotulo: `${S.params.estrelas} estrelas`, fn: (o) => k.avaliar(id, S.params.estrelas, o) }]);
    },
    codigo: () => {
      const cod = normalizarCodigo($("#tr-cod").value);
      if (!codigoTemFormatoValido(cod)) throw new Error("O código tem 5 palavras. Confira com quem recebe.");
      if (hashCodigo(S.imp.EscrowTrabalho, t.cliente, cod) !== t.codigoHash) throw new Error("Código incorreto");
      return executar("Confirmar com código", [{ rotulo: "Liberar com código", fn: (o) => k.confirmarComCodigo(id, cod, o) }]);
    },
    checkIn: async () => {
      modal(`<div class="giro"></div><h2>Lendo GPS</h2><p class="mudo">Fique em céu aberto, perto do local.</p>`);
      const g = await lerGps();
      if (g.precisao > ESCROW.precisaoMaxGpsMetros) throw new Error(`GPS impreciso (±${Math.round(g.precisao)} m). Precisa de ±${ESCROW.precisaoMaxGpsMetros} m ou melhor.`);
      const lat = paraMicro(g.lat);
      const lon = paraMicro(g.lon);
      const d = distanciaMetros(t.lat, t.lon, lat, lon);
      if (d > ESCROW.raioMaxMetros) throw new Error(`Você está a ${Math.round(d)} m do local. Chegue a até ${ESCROW.raioMaxMetros} m.`);
      return executar(`Check-in a ${Math.round(d)} m`, [{ rotulo: "Registrar presença", fn: (o) => k.checkIn(id, lat, lon, o) }]);
    },
  }[nome];
  if (!f) return;
  await f();
  if (ABERTAS.includes(S.tela) && $("#modal").hidden) ir("TRABALHO", { id: t.id });
}

// ----------------------------------------------------------------------------
// Partida
// ----------------------------------------------------------------------------
async function iniciar() {
  S.tela = "CARREGANDO";
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
    let recarregou = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (recarregou) return;
      recarregou = true;
      if (!S.carteira) location.reload(); // nova versão: atualiza já (se a carteira estiver aberta, no próximo bloqueio)
    });
  }
  await conectarRede(escolherRedeInicial());
  ir(K.existeCofre() ? "BLOQUEADA" : "BOAS_VINDAS");
}

iniciar().catch((e) => {
  console.error(e);
  $("#tela").innerHTML = `<div class="erro">Falha ao iniciar: ${esc(traduzirErro(e))}</div>`;
});

// Exposto só para testes automatizados (sem chaves).
window.__xbrl = { estado: () => ({ tela: S.tela, chainId: S.chainId, endereco: S.endereco, implantado: !!S.imp, ocupado: S.ocupado > 0 }) };
