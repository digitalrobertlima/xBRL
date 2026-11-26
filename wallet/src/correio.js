// =====================================================================
// BRLS — Correio dos pedidos sem gás
// Quem está sem POL assina a ação de graça (semgas.js). Antes, o pedido só saía por QR/link — inútil
// quando a outra parte está longe (o motorista ainda vai buscar o passageiro). Agora o pedido também
// vai para uma caixa de correio pública do trabalho, e o app da outra parte, aberto, mostra:
//   "Seu motorista quer aceitar a corrida, mas está sem POL. Aceita?"  → ela decide (aceitar/recusar).
//
// Sem servidor nosso: a caixa é um tópico do ntfy (dois servidores públicos e gratuitos, só HTTP; no APK passa
// pela ponte da Caixa Forte, pelo Tor). O tópico é derivado do trabalho; o conteúdo é só o pedido
// assinado, que de todo jeito ficaria público ao entrar na blockchain. Ninguém consegue alterar ou
// falsificar: o app confere a assinatura, o prazo e a ação antes de mostrar, e a pessoa confirma.
// Se o serviço cair, o QR/link continua funcionando.
// =====================================================================
const E = () => globalThis.ethers;
// Dois servidores públicos (mesmo software, donos diferentes): posta nos dois, lê dos dois.
// Se os dois caírem, o QR/link continua funcionando — e tudo que vale dinheiro está na blockchain.
export const SERVIDORES = ["https://ntfy.sh", "https://ntfy.4d2.org"];
const MAX = 4000;
const ESPERA_MS = 12000;

const comPrazo = (p) => Promise.race([p, new Promise((_, n) => setTimeout(() => n(new Error("tempo")), ESPERA_MS))]);

/** Tópico da caixa de correio de um trabalho (não dá para adivinhar sem saber rede + contrato + id). */
export function topico(chainId, escrow, id) {
  const h = E().keccak256(E().AbiCoder.defaultAbiCoder().encode(["string", "uint256", "address", "uint256"], ["brls-correio-v1", BigInt(chainId), escrow, BigInt(id)]));
  return "brls_" + h.slice(2, 34);
}

/** Tópico de uma pessoa (pedidos para uma loja ou para quem vende BRLS por Pix). */
export function topicoDe(chainId, conta, canal = "pedidos") {
  const h = E().keccak256(E().AbiCoder.defaultAbiCoder().encode(["string", "uint256", "address", "string"], ["brls-caixa-v1", BigInt(chainId), conta, canal]));
  return "brls_" + h.slice(2, 34);
}

/** Posta um texto num tópico (em todos os servidores). true se pelo menos um aceitou. */
export async function postarTopico(top, texto) {
  if (!texto || texto.length > MAX) return false;
  const r = await Promise.allSettled(SERVIDORES.map((s) => comPrazo(fetch(`${s}/${top}`, { method: "POST", body: texto, headers: { "content-type": "text/plain" } }))));
  return r.some((x) => x.status === "fulfilled" && x.value.ok);
}

/** Textos postados num tópico nas últimas `desde` (ex.: "3h"), juntando os servidores, sem repetir. */
export async function lerTopico(top, desde = "3h", prefixo = "brls:") {
  const r = await Promise.allSettled(SERVIDORES.map((s) => comPrazo(fetch(`${s}/${top}/json?poll=1&since=${desde}`, { headers: { accept: "application/x-ndjson" } }).then((x) => (x.ok ? x.text() : "")))));
  const vistos = new Set();
  const out = [];
  for (const x of r) {
    if (x.status !== "fulfilled") continue;
    for (const linha of x.value.split("\n").slice(-80)) {
      try {
        const m = JSON.parse(linha);
        const t = String(m?.message || "");
        if (m?.event === "message" && t.startsWith(prefixo) && t.length <= MAX && !vistos.has(t)) {
          vistos.add(t);
          out.push(t);
        }
      } catch { /* linha estranha: ignora */ }
    }
  }
  return out;
}

/** Deixa um pedido assinado na caixa do trabalho. Falhar aqui não é grave: ainda há o QR. */
export const postar = (chainId, escrow, id, texto) => postarTopico(topico(chainId, escrow, id), texto);
/** Pedidos deixados nas últimas 3 horas (os pedidos valem 2 h). */
export const ler = (chainId, escrow, id) => lerTopico(topico(chainId, escrow, id));

// Pedidos que a pessoa já recusou ou enviou (não mostra de novo)
const CHAVE = "xbrl.correio.resolvidos";
const marca = (texto) => E().id(texto).slice(0, 18);
export function jaResolvido(texto) {
  try { return (JSON.parse(localStorage.getItem(CHAVE) || "[]")).includes(marca(texto)); } catch { return false; }
}
export function resolver(texto) {
  try {
    const l = JSON.parse(localStorage.getItem(CHAVE) || "[]").filter((x) => x !== marca(texto));
    l.push(marca(texto));
    localStorage.setItem(CHAVE, JSON.stringify(l.slice(-200)));
  } catch { /* sem armazenamento */ }
}
