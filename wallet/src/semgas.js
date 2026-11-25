// =====================================================================
// BRLS — Ações sem gás (ERC-2771)
// Quem está sem POL assina a ação no próprio aparelho (de graça) e mostra um QR ou manda um link.
// Qualquer pessoa — normalmente a outra parte do trabalho — lê e envia à rede, pagando o gás.
// O contrato enxerga quem ASSINOU como autor. A assinatura vale uma vez, por 2 horas, só nesta rede,
// só para o contrato e a ação exatos que aparecem na tela de quem envia.
//
// Formato compacto (para caber num QR legível):
//   "brls:" + base64url( 0x01 | flags | n | n × [from 20 | to 20 | gas 4 | deadline 6 | sig 65 | len 2 | data]
//                        | permit? [valor 32 | deadline 6 | sig 65] )
//   permit (opcional) = autorização do BRLS para o 1º destino, assinada por quem pediu (EIP-2612).
// =====================================================================
import { ABIS } from "./config.js";

const E = () => globalThis.ethers;
export const PREFIXO = "brls:";
const VALIDADE_S = 2 * 60 * 60;

const TIPOS_PEDIDO = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};
const TIPOS_PERMIT = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function dominio(contrato) {
  const d = await contrato.eip712Domain();
  return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract };
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function deB64url(txt) {
  const s = atob(txt.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
const num = (v, n) => E().getBytes(E().toBeHex(BigInt(v), n));

/**
 * Assina uma ou mais chamadas (na ordem) e devolve o texto do QR.
 * @param chamadas [{ to, data, gas }]
 * @param permit   { token, valor } — autoriza o 1º destino a puxar `valor` do token (opcional)
 */
export async function assinar(carteira, provider, enderecoEncaminhador, chamadas, permit = null) {
  const fwd = new (E().Contract)(enderecoEncaminhador, ABIS.Encaminhador, provider);
  const dom = await dominio(fwd);
  let nonce = await fwd.nonces(carteira.address);
  // Prazo pelo relógio da própria blockchain (o do aparelho pode estar errado).
  const agora = Number((await provider.getBlock("latest")).timestamp);
  const prazo = agora + VALIDADE_S;
  const partes = [Uint8Array.of(1, permit ? 1 : 0, chamadas.length)];
  for (const ch of chamadas) {
    const gas = BigInt(ch.gas || 500_000);
    const msg = { from: carteira.address, to: ch.to, value: 0n, gas, nonce, deadline: prazo, data: ch.data };
    const sig = E().getBytes(await carteira.signTypedData(dom, TIPOS_PEDIDO, msg));
    const dados = E().getBytes(ch.data);
    partes.push(E().getBytes(carteira.address), E().getBytes(ch.to), num(gas, 4), num(prazo, 6), sig, num(dados.length, 2), dados);
    nonce += 1n;
  }
  if (permit) {
    const tk = new (E().Contract)(permit.token, ABIS.xBRL, provider);
    const domT = await dominio(tk);
    const msg = { owner: carteira.address, spender: chamadas[0].to, value: permit.valor, nonce: await tk.nonces(carteira.address), deadline: prazo };
    const sig = E().getBytes(await carteira.signTypedData(domT, TIPOS_PERMIT, msg));
    partes.push(num(permit.valor, 32), num(prazo, 6), sig);
  }
  return PREFIXO + b64url(E().getBytes(E().concat(partes)));
}

/** Lê o texto do QR/link. Lança erro se não for um pedido válido. */
export function decodificar(texto) {
  const i = String(texto).indexOf(PREFIXO);
  if (i < 0) throw new Error("Este QR não é um pedido sem gás do BRLS");
  const b = deB64url(String(texto).slice(i + PREFIXO.length).split(/[&\s#]/)[0]);
  let p = 0;
  const ler = (n) => {
    if (p + n > b.length) throw new Error("Pedido incompleto");
    const x = b.slice(p, p + n);
    p += n;
    return x;
  };
  const [versao, flags, n] = ler(3);
  if (versao !== 1 || n < 1 || n > 4) throw new Error("Pedido em formato desconhecido");
  const pedidos = [];
  for (let k = 0; k < n; k++) {
    const from = E().getAddress(E().hexlify(ler(20)));
    const to = E().getAddress(E().hexlify(ler(20)));
    const gas = BigInt(E().hexlify(ler(4)));
    const deadline = Number(BigInt(E().hexlify(ler(6))));
    const signature = E().hexlify(ler(65));
    const len = Number(BigInt(E().hexlify(ler(2))));
    const data = E().hexlify(ler(len));
    pedidos.push({ from, to, value: 0n, gas, deadline, data, signature });
  }
  let permit = null;
  if (flags & 1) {
    const valor = BigInt(E().hexlify(ler(32)));
    const deadline = BigInt(E().hexlify(ler(6)));
    const sig = E().Signature.from(E().hexlify(ler(65)));
    permit = { owner: pedidos[0].from, spender: pedidos[0].to, valor, deadline, v: sig.v, r: sig.r, s: sig.s };
  }
  if (pedidos.some((x) => x.from !== pedidos[0].from)) throw new Error("Pedido misturado de pessoas diferentes");
  return { pedidos, permit };
}

/** Descreve em português o que o pedido faz (para quem vai enviar conferir antes). */
export function descrever(pedido, imp) {
  const alvo = pedido.to.toLowerCase();
  if (alvo === imp.EscrowTrabalho?.toLowerCase()) {
    const it = new (E().Interface)(ABIS.EscrowTrabalho);
    const f = it.parseTransaction({ data: pedido.data });
    const id = f.args[0]?.toString?.() ?? "";
    const nomes = {
      aceitar: `aceitar o trabalho #${id}`,
      confirmarChegada: `registrar a chegada no trabalho #${id} (com o código do local)`,
      marcarEntregue: `marcar como entregue o trabalho #${id}`,
      confirmarComCodigo: `liberar o pagamento do trabalho #${id} com o código`,
      confirmarDevolucao: `confirmar a devolução no trabalho #${id}`,
      desistir: `desistir do trabalho #${id}`,
      reivindicar: `receber o pagamento do trabalho #${id} (prazo de revisão vencido)`,
      abrirDisputa: `abrir disputa no trabalho #${id}`,
      proporAcordo: `propor acordo no trabalho #${id}: ${Number(f.args[1]) / 100}% ao trabalhador`,
      avaliar: `dar ${f.args[1]} estrela(s) no trabalho #${id}`,
      liberar: `liberar o pagamento do trabalho #${id}`,
      confirmarChegadaPeloCliente: `confirmar a chegada no trabalho #${id}`,
      arbitrar: `propor como árbitro ${Number(f.args[1]) / 100}% ao trabalhador no trabalho #${id}`,
      cancelar: `cancelar o trabalho #${id}`,
      decidirCandidato: `${f.args[1] ? "aprovar" : "recusar"} o candidato do trabalho #${id}`,
      sacarGasPendente: "sacar o POL pendente",
    };
    if (!(f.name in nomes)) throw new Error("Ação não permitida por este caminho");
    return nomes[f.name];
  }
  if (alvo === imp.Mensageiro?.toLowerCase()) {
    const it = new (E().Interface)(ABIS.Mensageiro);
    const f = it.parseTransaction({ data: pedido.data });
    if (f.name === "enviar") return "enviar uma mensagem cifrada na conversa do trabalho";
    if (f.name === "registrarChave") return "ativar a conversa cifrada";
  }
  throw new Error("Este pedido não é para o protocolo BRLS");
}

/** Confere tudo sem gastar nada: assinatura, prazo e se a ação passaria. */
export async function conferir(provider, imp, decod) {
  const fwd = new (E().Contract)(imp.Encaminhador, ABIS.Encaminhador, provider);
  const agora = Number((await provider.getBlock("latest")).timestamp);
  for (const p of decod.pedidos) {
    if (p.deadline < agora) throw new Error("Este pedido venceu (vale 2 horas). Peça um QR novo.");
  }
  const ok = await fwd.verify(decod.pedidos[0]);
  if (!ok) throw new Error("Assinatura inválida ou já usada. Peça um QR novo.");
}

/** Envia (quem chama paga o gás). Retorna as transações, na ordem. */
export function passosParaEnviar(carteira, imp, decod) {
  const fwd = new (E().Contract)(imp.Encaminhador, ABIS.Encaminhador, carteira);
  const passos = [];
  if (decod.permit) {
    const tk = new (E().Contract)(imp.xBRL, ABIS.xBRL, carteira);
    const pm = decod.permit;
    passos.push({
      rotulo: "Autorização de BRLS assinada",
      fn: async (o) => ((await tk.allowance(pm.owner, pm.spender)) >= pm.valor ? null : tk.permit(pm.owner, pm.spender, pm.valor, pm.deadline, pm.v, pm.r, pm.s, o)),
    });
  }
  decod.pedidos.forEach((p, i) => passos.push({ rotulo: `Ação assinada ${i + 1}`, fn: (o) => fwd.execute(p, { ...o, gasLimit: p.gas + 120_000n }) }));
  return passos;
}
