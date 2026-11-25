// =====================================================================
// BRLS — Carteira externa (Caixa Forte, MetaMask, Rabby…)
// O BRLS pode rodar "conectado": em vez de guardar as 12 palavras, pede à carteira de fora para
// assinar. Duas formas:
//   1) Dentro da Caixa Forte (iframe): conversa por postMessage com a carteira-mãe ("ponte BRLS").
//   2) Navegador com carteira injetada (window.ethereum, padrão EIP-1193).
// Leituras e estimativas continuam pelos servidores do próprio BRLS; a carteira de fora só ASSINA.
// =====================================================================
const E = globalThis.ethers;

// ---------- 1) Ponte com a Caixa Forte ----------
// Protocolo (mensagens com { brls: 1, ... }):
//   filho → mãe  { brls: 1, tipo: "ola" }
//   mãe → filho  { brls: 1, tipo: "ponte", endereco, chainId, nome }
//   filho → mãe  { brls: 1, tipo: "pedido", id, method, params, descricao }
//   mãe → filho  { brls: 1, tipo: "resposta", id, result } | { ..., erro: { code, message } }
// Só aceita respostas da janela-mãe e da origem que respondeu ao "olá".
let mae = null;
const pendentes = new Map();
let proximoId = 1;

addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || d.brls !== 1 || !mae || ev.source !== window.parent || ev.origin !== mae.origem) return;
  if (d.tipo === "resposta" && pendentes.has(d.id)) {
    const { ok, falha } = pendentes.get(d.id);
    pendentes.delete(d.id);
    if (d.erro) {
      const e = new Error(d.erro.message || "Recusado na carteira");
      e.code = d.erro.code;
      falha(e);
    } else ok(d.result);
  }
  if (d.tipo === "conta" && mae.aoTrocarConta) mae.aoTrocarConta(d.endereco);
});

/** Procura a Caixa Forte em volta (até 1,5 s). Retorna { endereco, chainId, nome, request } ou null. */
export function procurarPonte(espera = 1500) {
  if (window.parent === window) return Promise.resolve(null);
  return new Promise((resolve) => {
    const fim = setTimeout(() => {
      removeEventListener("message", ouvir);
      resolve(null);
    }, espera);
    function ouvir(ev) {
      const d = ev.data;
      if (!d || d.brls !== 1 || d.tipo !== "ponte" || ev.source !== window.parent) return;
      if (!E.isAddress(d.endereco)) return;
      clearTimeout(fim);
      removeEventListener("message", ouvir);
      mae = { origem: ev.origin, aoTrocarConta: null };
      resolve({
        tipo: "ponte",
        nome: String(d.nome || "Caixa Forte").slice(0, 40),
        endereco: E.getAddress(d.endereco),
        chainId: Number(d.chainId),
        request: ({ method, params, descricao }) =>
          new Promise((ok, falha) => {
            const id = proximoId++;
            pendentes.set(id, { ok, falha });
            window.parent.postMessage({ brls: 1, tipo: "pedido", id, method, params: params || [], descricao: descricao || "" }, mae.origem);
          }),
        aoTrocarConta: (fn) => (mae.aoTrocarConta = fn),
      });
    }
    addEventListener("message", ouvir);
    // "*" só no olá (ainda não sabemos a origem da mãe; não leva nada secreto)
    window.parent.postMessage({ brls: 1, tipo: "ola" }, "*");
  });
}

// ---------- 2) Carteira injetada (MetaMask, Rabby…) ----------
export function temInjetada() {
  return !!(globalThis.ethereum && typeof globalThis.ethereum.request === "function");
}

export async function conectarInjetada(chainId) {
  const eth = globalThis.ethereum;
  const [conta] = await eth.request({ method: "eth_requestAccounts" });
  const atual = Number(await eth.request({ method: "eth_chainId" }));
  if (atual !== Number(chainId)) {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: E.toQuantity(chainId) }] });
  }
  return { tipo: "injetada", nome: eth.isRabby ? "Rabby" : eth.isMetaMask ? "MetaMask" : "carteira do navegador", endereco: E.getAddress(conta), chainId: Number(chainId), request: ({ method, params }) => eth.request({ method, params }) };
}

// ---------- Assinante ----------
/** Signer do ethers v6 que lê pelo provedor do BRLS e só pede à carteira de fora para assinar/enviar. */
export class AssinanteExterno extends E.AbstractSigner {
  constructor(conexao, provider, descrever = () => "") {
    super(provider);
    this.conexao = conexao;
    this.address = conexao.endereco;
    this.descrever = descrever;
  }

  connect(provider) {
    return new AssinanteExterno(this.conexao, provider, this.descrever);
  }

  async getAddress() {
    return this.address;
  }

  async signTransaction() {
    throw new Error("Use sendTransaction: a carteira conectada assina e envia.");
  }

  async sendTransaction(tx) {
    const pop = await this.populateTransaction(tx);
    const q = (v) => (v == null ? undefined : E.toQuantity(v));
    const pedido = { from: this.address, to: pop.to, data: pop.data || "0x", value: q(pop.value || 0n), gas: q(pop.gasLimit) };
    if (pop.maxFeePerGas != null) {
      pedido.maxFeePerGas = q(pop.maxFeePerGas);
      pedido.maxPriorityFeePerGas = q(pop.maxPriorityFeePerGas);
    } else if (pop.gasPrice != null) pedido.gasPrice = q(pop.gasPrice);
    const hash = await this.conexao.request({ method: "eth_sendTransaction", params: [pedido], descricao: this.descrever() });
    // Espera o servidor de leitura enxergar a transação (até ~40 s)
    for (let i = 0; i < 40; i++) {
      const r = await this.provider.getTransaction(hash).catch(() => null);
      if (r) return r;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    throw new Error(`Transação enviada (${hash}), mas ainda não apareceu na rede. Confira o extrato em instantes.`);
  }

  async signMessage(msg) {
    const m = typeof msg === "string" ? E.hexlify(E.toUtf8Bytes(msg)) : E.hexlify(msg);
    return this.conexao.request({ method: "personal_sign", params: [m, this.address], descricao: this.descrever() });
  }

  async signTypedData(domain, types, value) {
    const dados = E.TypedDataEncoder.getPayload(domain, types, value);
    return this.conexao.request({ method: "eth_signTypedData_v4", params: [this.address, JSON.stringify(dados, (_, v) => (typeof v === "bigint" ? v.toString() : v))], descricao: this.descrever() });
  }

  /** Conversa cifrada: só a Caixa Forte oferece (MetaMask/Rabby não fazem ECDH). */
  get temConversa() {
    return this.conexao.tipo === "ponte";
  }

  async chavePublica64() {
    if (!this.temConversa) throw new Error("A conversa cifrada funciona na carteira BRLS ou dentro da Caixa Forte.");
    return this.conexao.request({ method: "brls_chavePublica", params: [] });
  }

  async segredoCom(pub64) {
    if (!this.temConversa) throw new Error("A conversa cifrada funciona na carteira BRLS ou dentro da Caixa Forte.");
    return this.conexao.request({ method: "brls_segredo", params: [pub64] });
  }
}
