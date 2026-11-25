// =====================================================================
// BRLS — conexão com a Polygon por vários servidores públicos (troca sozinho se um recusar)
// =====================================================================
const E = globalThis.ethers;

// RPC que troca sozinho de servidor quando um nó público recusa (403, limite, "archive", fora do ar).
// Erros legítimos da própria transação (revert, saldo, nonce) não trocam de servidor: voltam para a tela.
const ERRO_LEGITIMO = /revert|execution|insufficient funds|nonce|underpriced|already known|known transaction|intrinsic gas|gas required exceeds/i;
export class ProvedorRotativo extends E.JsonRpcApiProvider {
  constructor(urls, chainId) {
    const net = E.Network.from(chainId);
    super(net, { staticNetwork: net, batchMaxCount: 1, cacheTimeout: -1, polling: true, pollingInterval: urls[0].includes("127.0.0.1") ? 1000 : 2000 });
    this._urls = urls;
    this._atual = 0;
  }

  async _send(payload) {
    const corpo = JSON.stringify(payload);
    const unico = Array.isArray(payload) ? payload[0] : payload;
    let ultimo;
    for (let n = 0; n < this._urls.length; n++) {
      const k = (this._atual + n) % this._urls.length;
      const url = this._urls[k];
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: corpo, signal: AbortSignal.timeout(12_000) });
        if (!r.ok) throw new Error(`servidor ${new URL(url).host} respondeu ${r.status}`);
        const j = await r.json();
        const lista = Array.isArray(j) ? j : [j];
        // Transação já enviada por um servidor anterior: não é erro, devolve o hash.
        if (unico?.method === "eth_sendRawTransaction" && lista[0]?.error && /already known|known transaction/i.test(String(lista[0].error.message))) {
          return [{ jsonrpc: "2.0", id: unico.id, result: E.keccak256(unico.params[0]) }];
        }
        const ruim = lista.find((x) => x?.error && x.error.code !== 3 && !ERRO_LEGITIMO.test(String(x.error.message || "")));
        if (ruim) throw new Error(`servidor ${new URL(url).host}: ${ruim.error.message}`);
        this._atual = k;
        return lista;
      } catch (e) {
        ultimo = e;
      }
    }
    throw ultimo;
  }
}

