// =====================================================================
// xBRL — Conversa cifrada entre as partes de um trabalho (sem servidor)
// - As mensagens ficam em eventos do contrato Mensageiro, cifradas de ponta a ponta.
// - Chave de cada mensagem: ECDH secp256k1 (a mesma curva da carteira) + SHA-256 → AES-256-GCM.
// - Cada mensagem é cifrada separadamente para cada participante (inclusive para quem envia, que
//   assim consegue reler o que escreveu em outro aparelho).
// - A chave pública de alguém vem do registro no Mensageiro OU de qualquer transação que a pessoa já
//   assinou no Escrow (a assinatura revela a chave pública). Sempre conferida contra o endereço.
// =====================================================================
import { ABIS } from "./config.js";

const E = () => globalThis.ethers;
const DOMINIO = new TextEncoder().encode("xBRL.chat.v1");
export const MAX_CARACTERES = 1_000;

/** Chave pública sem o prefixo 0x04 (64 bytes), como o Mensageiro guarda. */
export async function chavePublica64(carteira) {
  if (carteira.signingKey) return "0x" + carteira.signingKey.publicKey.slice(4);
  return carteira.chavePublica64(); // carteira conectada (Caixa Forte)
}

async function chaveAes(carteira, pub64, usos) {
  // Só o X do ponto compartilhado (32 bytes). Carteira conectada calcula do lado dela, sem expor a chave.
  const bruto = carteira.signingKey ? E().getBytes(carteira.signingKey.computeSharedSecret("0x04" + pub64.slice(2))) : E().getBytes(await carteira.segredoCom(pub64));
  const x = bruto.length === 65 ? bruto.slice(1, 33) : bruto.slice(0, 32);
  const material = new Uint8Array([...x, ...DOMINIO]);
  const hash = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, usos);
}

async function cifrar(carteira, pub64, texto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await chaveAes(carteira, pub64, ["encrypt"]);
  const dados = new TextEncoder().encode(JSON.stringify({ t: texto, em: Math.floor(Date.now() / 1000) }));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, dados));
  return E().hexlify(new Uint8Array([...iv, ...c]));
}

async function decifrar(carteira, pub64, hex) {
  const b = E().getBytes(hex);
  const k = await chaveAes(carteira, pub64, ["decrypt"]);
  const claro = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, k, b.slice(12));
  const j = JSON.parse(new TextDecoder().decode(claro));
  return { texto: String(j.t ?? "").slice(0, MAX_CARACTERES), em: Number(j.em) || 0 };
}

export class Chat {
  /** @param txsConhecidas mapa endereço → hash de transação que a pessoa assinou (para achar a chave pública) */
  constructor(provider, endereco, blocoInicial = 0) {
    this.provider = provider;
    this.contrato = new (E().Contract)(endereco, ABIS.Mensageiro, provider);
    this.blocoInicial = Number(blocoInicial) || 0;
    this.chaves = new Map();
  }

  /** Busca a chave pública de uma conta (registro on-chain → transações conhecidas). Null se ainda não houver. */
  async chaveDe(conta, txsConhecidas = []) {
    const k = conta.toLowerCase();
    if (this.chaves.has(k)) return this.chaves.get(k);
    let pub = null;
    try {
      const r = await this.contrato.chavePublica(conta);
      if (r && E().dataLength(r) === 64) pub = r;
    } catch { /* RPC instável: tenta pela transação */ }
    for (const hash of txsConhecidas) {
      if (pub || !hash) break;
      try {
        const tx = await this.provider.getTransaction(hash);
        if (!tx) continue;
        if (tx.from.toLowerCase() !== k) {
          pub = await this.chaveDoPedidoSemGas(tx, k); // quem estava sem POL assinou o pedido; outra pessoa enviou
          continue;
        }
        const completa = E().Transaction.from({
          type: tx.type, to: tx.to, nonce: tx.nonce, gasLimit: tx.gasLimit, gasPrice: tx.type === 2 ? null : tx.gasPrice,
          maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, data: tx.data, value: tx.value,
          chainId: tx.chainId, accessList: tx.accessList, signature: tx.signature,
        });
        const p = completa.fromPublicKey;
        if (p && E().computeAddress(p).toLowerCase() === k) pub = "0x" + p.slice(4);
      } catch { /* transação ilegível: ignora */ }
    }
    if (pub) {
      if (E().computeAddress("0x04" + pub.slice(2)).toLowerCase() !== k) pub = null; // nunca aceita chave de outro
      else this.chaves.set(k, pub);
    }
    return pub;
  }

  /**
   * Pedido sem gás (ERC-2771): a transação é de quem enviou, mas o pedido dentro dela foi assinado por `conta`.
   * A chave pública sai dessa assinatura (EIP-712), com o nonce que o Encaminhador registrou no evento.
   */
  async chaveDoPedidoSemGas(tx, conta) {
    if (!this.encaminhador || tx.to?.toLowerCase() !== this.encaminhador.toLowerCase()) return null;
    const it = new (E().Interface)(ABIS.Encaminhador);
    const f = it.parseTransaction({ data: tx.data });
    if (f?.name !== "execute") return null;
    const r = f.args[0];
    if (r.from.toLowerCase() !== conta) return null;
    const recibo = await this.provider.getTransactionReceipt(tx.hash);
    const ev = recibo?.logs.map((l) => { try { return l.address.toLowerCase() === this.encaminhador.toLowerCase() ? it.parseLog(l) : null; } catch { return null; } }).find((x) => x?.name === "ExecutedForwardRequest" && x.args.signer.toLowerCase() === conta);
    if (!ev) return null;
    const fwd = new (E().Contract)(this.encaminhador, ABIS.Encaminhador, this.provider);
    const d = await fwd.eip712Domain();
    const tipos = { ForwardRequest: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "gas", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint48" }, { name: "data", type: "bytes" }] };
    const h = E().TypedDataEncoder.hash({ name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract }, tipos, { from: r.from, to: r.to, value: r.value, gas: r.gas, nonce: ev.args.nonce, deadline: r.deadline, data: r.data });
    const p = E().SigningKey.recoverPublicKey(h, r.signature);
    return E().computeAddress(p).toLowerCase() === conta ? "0x" + p.slice(4) : null;
  }

  /** Lê e decifra as mensagens da conversa que são para `carteira`. */
  async ler(conversa, carteira) {
    const eu = carteira.address.toLowerCase();
    const filtro = this.contrato.filters.Mensagem(conversa);
    const atual = await this.provider.getBlockNumber();
    const logs = [];
    let de = this.blocoInicial;
    let passo = 50_000;
    while (de <= atual) {
      const ate = Math.min(atual, de + passo - 1);
      try {
        logs.push(...(await this.contrato.queryFilter(filtro, de, ate)));
        de = ate + 1;
      } catch (erro) {
        if (passo <= 500) throw erro;
        passo = Math.floor(passo / 4);
      }
    }
    const saida = [];
    for (const log of logs) {
      const { de: remetente, para, cifrados } = log.args;
      const i = para.findIndex((p) => p.toLowerCase() === eu);
      if (i < 0) continue;
      try {
        const pub = await this.chaveDe(remetente);
        if (!pub) continue;
        const m = await decifrar(carteira, pub, cifrados[i]);
        saida.push({ de: remetente, ...m, bloco: log.blockNumber, tx: log.transactionHash });
      } catch {
        saida.push({ de: remetente, texto: "🔒 (mensagem que este aparelho não consegue abrir)", em: 0, bloco: log.blockNumber });
      }
    }
    return saida;
  }

  /** Prepara o envio: cifra para cada participante que já tem chave conhecida. */
  async preparar(conversa, carteira, participantes, texto, txsPorConta = {}) {
    const limpo = String(texto || "").trim().slice(0, MAX_CARACTERES);
    if (!limpo) throw new Error("Escreva a mensagem");
    const eu = carteira.address.toLowerCase();
    const unicos = [...new Set([carteira.address, ...participantes].map((p) => E().getAddress(p)))];
    const para = [];
    const cifrados = [];
    const semChave = [];
    for (const p of unicos) {
      const pub = p.toLowerCase() === eu ? await chavePublica64(carteira) : await this.chaveDe(p, txsPorConta[p.toLowerCase()] || []);
      if (!pub) {
        semChave.push(p);
        continue;
      }
      para.push(p);
      cifrados.push(await cifrar(carteira, pub, limpo));
    }
    if (para.length < 2) throw new Error("A outra parte ainda não pode receber mensagens. Ela precisa abrir este trabalho na carteira uma vez.");
    let registrar = "0x";
    try {
      const atual = await this.contrato.chavePublica(carteira.address);
      if (E().dataLength(atual) !== 64) registrar = await chavePublica64(carteira);
    } catch {
      registrar = await chavePublica64(carteira);
    }
    return { conversa, para, cifrados, registrar, semChave };
  }
}
