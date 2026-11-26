// =====================================================================
// BRLS — Correio dos pedidos sem gás
// Quem está sem POL assina a ação de graça (semgas.js). Antes, o pedido só saía por QR/link — inútil
// quando a outra parte está longe (o motorista ainda vai buscar o passageiro). Agora o pedido também
// vai para uma caixa de correio pública do trabalho, e o app da outra parte, aberto, mostra:
//   "Seu motorista quer aceitar a corrida, mas está sem POL. Aceita?"  → ela decide (aceitar/recusar).
//
// Sem servidor nosso: a caixa é um tópico do ntfy.sh (serviço público e gratuito, só HTTP; no APK passa
// pela ponte da Caixa Forte, pelo Tor). O tópico é derivado do trabalho; o conteúdo é só o pedido
// assinado, que de todo jeito ficaria público ao entrar na blockchain. Ninguém consegue alterar ou
// falsificar: o app confere a assinatura, o prazo e a ação antes de mostrar, e a pessoa confirma.
// Se o serviço cair, o QR/link continua funcionando.
// =====================================================================
const E = () => globalThis.ethers;
const SERVIDOR = "https://ntfy.sh";
const MAX = 4000;

/** Tópico da caixa de correio de um trabalho (não dá para adivinhar sem saber rede + contrato + id). */
export function topico(chainId, escrow, id) {
  const h = E().keccak256(E().AbiCoder.defaultAbiCoder().encode(["string", "uint256", "address", "uint256"], ["brls-correio-v1", BigInt(chainId), escrow, BigInt(id)]));
  return "brls_" + h.slice(2, 34);
}

/** Deixa um pedido assinado na caixa do trabalho. Falhar aqui não é grave: ainda há o QR. */
export async function postar(chainId, escrow, id, texto) {
  if (!texto || texto.length > MAX) return false;
  const r = await fetch(`${SERVIDOR}/${topico(chainId, escrow, id)}`, { method: "POST", body: texto, headers: { "content-type": "text/plain" } });
  return r.ok;
}

/** Pedidos deixados nas últimas 3 horas (os pedidos valem 2 h). */
export async function ler(chainId, escrow, id) {
  const r = await fetch(`${SERVIDOR}/${topico(chainId, escrow, id)}/json?poll=1&since=3h`, { headers: { accept: "application/x-ndjson" } });
  if (!r.ok) return [];
  const vistos = new Set();
  const out = [];
  for (const linha of (await r.text()).split("\n").slice(-60)) {
    try {
      const m = JSON.parse(linha);
      const t = String(m?.message || "");
      if (m?.event === "message" && t.startsWith("brls:") && t.length <= MAX && !vistos.has(t)) {
        vistos.add(t);
        out.push(t);
      }
    } catch { /* linha estranha: ignora */ }
  }
  return out;
}

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
