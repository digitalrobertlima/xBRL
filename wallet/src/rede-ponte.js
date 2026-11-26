// =====================================================================
// BRLS — Rede pela Caixa Forte (app Android com Tor)
// Dentro do APK da Caixa Forte, esta janela NÃO tem internet: tudo que sai do celular passa pelo Tor
// embutido, e só a Caixa Forte fala com ele. Então, quando o BRLS abre com "?tor=ponte", cada pedido
// à blockchain vai por mensagem para a Caixa Forte, que faz o pedido pelo Tor e devolve a resposta.
//
// Mensagens (com { brls: 1, ... }), só com a janela-mãe e a origem que respondeu ao "olá":
//   filho → mãe  { tipo: "rede", id, url, method, headers, corpo }
//   mãe → filho  { tipo: "rede-resposta", id, status, conteudo, corpo, b64? } | { ..., erro }
//                (b64 = corpo em base64: imagens do mapa)
//   filho → mãe  { tipo: "copiar", texto }   (área de transferência do celular, apagada sozinha)
//   filho → mãe  { tipo: "gps", lat, lon, app }   (abrir o ponto no app de GPS: só com toque da pessoa)
//   filho → mãe  { tipo: "tela-acesa", liga }   (corrida em andamento / motorista online: tela não apaga)
// "?tor=pai": janela dentro do próprio BRLS (o comprovante) usa a rede da janela de cima.
// Este arquivo tem de ser o PRIMEIRO import de cada página.
// =====================================================================
const modo = new URLSearchParams(location.search).get("tor");
const dentro = window.parent !== window;

export const REDE_PELA_PONTE = dentro && (modo === "ponte" || modo === "pai");

if (dentro && modo === "ponte") instalarPonte();
else if (dentro && modo === "pai") instalarPai();

function instalarPonte() {
  globalThis.BRLS_REDE_LENTA = true; // o Tor demora mais: o rpc.js espera mais
  const original = globalThis.fetch.bind(globalThis);
  const pendentes = new Map();
  let proximo = 1;
  let origem = null; // origem da Caixa Forte; "direto" se ela não oferecer a rede
  let avisar;
  const pronta = new Promise((r) => (avisar = r));

  addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.brls !== 1 || ev.source !== window.parent) return;
    if (d.tipo === "ponte" && !origem) {
      origem = d.rede ? ev.origin : "direto";
      avisar();
    }
    if (d.tipo === "rede-resposta" && ev.origin === origem && pendentes.has(d.id)) {
      const p = pendentes.get(d.id);
      pendentes.delete(d.id);
      if (d.erro) return p.falha(new TypeError(String(d.erro).slice(0, 200)));
      const st = Number(d.status) || 502;
      const semCorpo = st === 204 || st === 304;
      // Imagens (mapa) chegam em base64 (d.b64): a mensagem só leva texto.
      const corpo = semCorpo ? null : d.b64 ? Uint8Array.from(atob(String(d.corpo || "")), (c) => c.charCodeAt(0)) : String(d.corpo ?? "");
      p.ok(new Response(corpo, { status: st >= 200 && st <= 599 ? st : 502, headers: { "content-type": String(d.conteudo || "application/json") } }));
    }
  });
  // "*" só no olá: ainda não sabemos a origem da mãe, e o olá não leva nada.
  const ola = () => !origem && window.parent.postMessage({ brls: 1, tipo: "ola" }, "*");
  ola();
  const repetir = setInterval(ola, 1000);
  pronta.then(() => clearInterval(repetir));
  setTimeout(() => {
    if (origem) return;
    origem = "direto"; // ninguém respondeu: tenta a rede normal (fora do app Android)
    avisar();
  }, 20_000);

  globalThis.fetch = async function (entrada, init = {}) {
    const req = typeof Request !== "undefined" && entrada instanceof Request ? entrada : null;
    const url = new URL(req ? req.url : String(entrada), location.href);
    if (url.origin === location.origin || url.protocol === "data:" || url.protocol === "blob:") return original(entrada, init);
    await pronta;
    if (origem === "direto") return original(entrada, init);
    const method = String(init.method || req?.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new TypeError("Pedido não suportado pela Caixa Forte.");
    const corpo = init.body ?? null;
    if (corpo != null && typeof corpo !== "string") throw new TypeError("Pedido não suportado pela Caixa Forte.");
    const headers = {};
    new Headers(init.headers || req?.headers || {}).forEach((v, k) => {
      if (k === "content-type" || k === "accept") headers[k] = v;
    });
    const sinal = init.signal;
    if (sinal?.aborted) throw new DOMException("Cancelado", "AbortError");
    return new Promise((ok, falha) => {
      const id = proximo++;
      pendentes.set(id, { ok, falha });
      sinal?.addEventListener("abort", () => {
        if (pendentes.delete(id)) falha(new DOMException("Cancelado", "AbortError"));
      });
      window.parent.postMessage({ brls: 1, tipo: "rede", id, url: url.href, method, headers, corpo }, origem);
    });
  };
  globalThis.__brlsRede = globalThis.fetch;

  // Copiar pelo celular (marcado como sensível e apagado sozinho), não pela área de transferência desta janela.
  const copiar = async (texto) => {
    await pronta;
    if (origem === "direto") throw new Error("sem área de transferência");
    window.parent.postMessage({ brls: 1, tipo: "copiar", texto: String(texto).slice(0, 4000) }, origem);
  };
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => ({ writeText: copiar, readText: () => Promise.reject(new Error("Cole digitando ou lendo o QR.")) }) });
  } catch (e) { /* fica a do navegador */ }
}

function instalarPai() {
  let pai;
  try {
    pai = window.parent.__brlsRede; // só existe se a janela de cima for o BRLS (mesma origem)
  } catch (e) {
    pai = null;
  }
  if (typeof pai !== "function") return;
  globalThis.BRLS_REDE_LENTA = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (entrada, init) => {
    const url = new URL(entrada instanceof Request ? entrada.url : String(entrada), location.href);
    return url.origin === location.origin ? original(entrada, init) : pai(entrada, init);
  };
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => window.parent.navigator.clipboard });
  } catch (e) { /* fica a do navegador */ }
}
