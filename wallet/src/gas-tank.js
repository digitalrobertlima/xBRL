// =====================================================================
// xBRL — Tanque de Gás Transparente
// Mantém até 3,0 POL na carteira para pagar as taxas da rede. Quando o tanque fica abaixo de 1,0 POL,
// troca um token da própria carteira (xBRL, BRZ, BRLA ou USDC) por POL na Uniswap V3:
//   - cotação na hora pelo QuoterV2 (sem servidor);
//   - slippage máximo de 1% (amountInMaximum = cotação × 1,01) — se o preço piorar, a troca falha e nada é gasto;
//   - prazo de 5 min; aprovação exata (nunca "infinita");
//   - tudo registrado no histórico local e exibido antes de assinar.
// =====================================================================
import { REDES, TANQUE } from "./config.js";

const e = () => globalThis.ethers;
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002"; // constante do SwapRouter02
const HISTORICO = "xbrl.tanque.historico";
const AUTO = "xbrl.tanque.auto";

const ABI_QUOTER = [
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactOutput(bytes path,uint256 amountOut) returns (uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
];
const ABI_ROUTER = [
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
  "function exactOutput((bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum) params) payable returns (uint256 amountIn)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
];
const ABI_ERC20 = [
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

export function autoAtivo() {
  return localStorage.getItem(AUTO) === "1";
}

export function definirAuto(ativo) {
  localStorage.setItem(AUTO, ativo ? "1" : "0");
}

export function historico() {
  try {
    return JSON.parse(localStorage.getItem(HISTORICO) || "[]");
  } catch {
    return [];
  }
}

function registrar(item) {
  const h = historico();
  h.unshift({ ...item, quando: Date.now() });
  localStorage.setItem(HISTORICO, JSON.stringify(h.slice(0, 50)));
}

/** Situação do tanque. */
export async function estadoTanque(provider, endereco) {
  const saldo = await provider.getBalance(endereco);
  const alvo = e().parseEther(TANQUE.alvoPol);
  const gatilho = e().parseEther(TANQUE.gatilhoPol);
  const nivelPct = Number((saldo * 1000n) / alvo) / 10;
  return {
    saldo,
    alvo,
    gatilho,
    nivelPct: Math.min(100, nivelPct),
    precisaAbastecer: saldo < gatilho,
    faltam: saldo >= alvo ? 0n : alvo - saldo,
    podePagarSwap: saldo >= e().parseEther(TANQUE.minimoParaOperarPol),
  };
}

/** Caminho Uniswap V3 codificado para exactOutput (ordem invertida: saída → entrada). */
function caminhoReverso(tokens, taxas) {
  const tipos = [];
  const valores = [];
  for (let i = 0; i < tokens.length; i++) {
    tipos.push("address");
    valores.push(tokens[i]);
    if (i < taxas.length) {
      tipos.push("uint24");
      valores.push(taxas[i]);
    }
  }
  return e().solidityPacked(tipos, valores);
}

/**
 * Cota quanto de `tokenEntrada` é preciso para obter `quantidadePol` (wei) de POL.
 * Tenta pool direto em várias taxas e, se não houver, rota via USDC. Escolhe o mais barato.
 */
export async function cotarAbastecimento(provider, chainId, tokenEntrada, quantidadePol) {
  const rede = REDES[chainId];
  if (!rede?.uniswap) throw new Error("Auto-swap indisponível nesta rede");
  const u = rede.uniswap;
  const quoter = new (e().Contract)(u.quoterV2, ABI_QUOTER, provider);
  const rotas = [];

  for (const taxa of u.taxasPool) {
    try {
      const r = await quoter.quoteExactOutputSingle.staticCall({
        tokenIn: tokenEntrada,
        tokenOut: u.wpol,
        amount: quantidadePol,
        fee: taxa,
        sqrtPriceLimitX96: 0,
      });
      rotas.push({ tipo: "direta", taxas: [taxa], entrada: r.amountIn });
    } catch {
      /* pool inexistente ou sem liquidez */
    }
  }
  if (tokenEntrada.toLowerCase() !== u.usdc.toLowerCase()) {
    for (const t1 of [500, 3000, 100]) {
      for (const t2 of [500, 3000]) {
        try {
          // saída WPOL ← t2 ← USDC ← t1 ← entrada
          const path = caminhoReverso([u.wpol, u.usdc, tokenEntrada], [t2, t1]);
          const r = await quoter.quoteExactOutput.staticCall(path, quantidadePol);
          rotas.push({ tipo: "via USDC", taxas: [t1, t2], path, entrada: r.amountIn });
        } catch {
          /* rota indisponível */
        }
      }
    }
  }
  if (!rotas.length) throw new Error("Sem liquidez para trocar este token por POL agora");
  rotas.sort((a, b) => (a.entrada < b.entrada ? -1 : 1));
  const melhor = rotas[0];
  const maximo = (melhor.entrada * (10_000n + TANQUE.slippageMaxBps)) / 10_000n;
  return {
    chainId,
    tokenEntrada,
    quantidadePol,
    entradaCotada: melhor.entrada,
    entradaMaxima: maximo,
    slippageBps: TANQUE.slippageMaxBps,
    rota: melhor,
    validoAte: Math.floor(Date.now() / 1000) + TANQUE.validadeSegundos,
  };
}

/** Executa a troca cotada. Devolve o recibo da transação. */
export async function abastecer(signer, cotacao, opcoesTx = {}) {
  const rede = REDES[cotacao.chainId];
  const u = rede.uniswap;
  const dono = await signer.getAddress();
  if (Math.floor(Date.now() / 1000) > cotacao.validoAte) throw new Error("Cotação expirada. Cote de novo.");

  const token = new (e().Contract)(cotacao.tokenEntrada, ABI_ERC20, signer);
  const saldo = await token.balanceOf(dono);
  if (saldo < cotacao.entradaMaxima) throw new Error("Saldo insuficiente do token escolhido");
  const permitido = await token.allowance(dono, u.swapRouter02);
  if (permitido < cotacao.entradaMaxima) {
    // Aprovação EXATA do máximo desta troca (nunca infinita).
    const txA = await token.approve(u.swapRouter02, cotacao.entradaMaxima, opcoesTx);
    await txA.wait();
  }

  const router = new (e().Contract)(u.swapRouter02, ABI_ROUTER, signer);
  const iface = router.interface;
  let chamadaSwap;
  if (cotacao.rota.tipo === "direta") {
    chamadaSwap = iface.encodeFunctionData("exactOutputSingle", [{
      tokenIn: cotacao.tokenEntrada,
      tokenOut: u.wpol,
      fee: cotacao.rota.taxas[0],
      recipient: ADDRESS_THIS,
      amountOut: cotacao.quantidadePol,
      amountInMaximum: cotacao.entradaMaxima,
      sqrtPriceLimitX96: 0,
    }]);
  } else {
    chamadaSwap = iface.encodeFunctionData("exactOutput", [{
      path: cotacao.rota.path,
      recipient: ADDRESS_THIS,
      amountOut: cotacao.quantidadePol,
      amountInMaximum: cotacao.entradaMaxima,
    }]);
  }
  const desembrulhar = iface.encodeFunctionData("unwrapWETH9", [cotacao.quantidadePol, dono]);
  const tx = await router.multicall(cotacao.validoAte, [chamadaSwap, desembrulhar], opcoesTx);
  const recibo = await tx.wait();
  registrar({
    hash: recibo.hash,
    token: cotacao.tokenEntrada,
    entradaMaxima: cotacao.entradaMaxima.toString(),
    entradaCotada: cotacao.entradaCotada.toString(),
    pol: cotacao.quantidadePol.toString(),
    rota: cotacao.rota.tipo,
  });
  return recibo;
}

/**
 * Abastecimento automático (se o usuário ativou): escolhe o primeiro token da lista com saldo suficiente.
 * `tokensPreferidos` = [{endereco, simbolo}] na ordem de preferência.
 */
export async function abastecerSeNecessario(provider, signer, chainId, tokensPreferidos, opcoesTx = {}) {
  if (!autoAtivo() || !REDES[chainId]?.uniswap) return null;
  const dono = await signer.getAddress();
  const est = await estadoTanque(provider, dono);
  if (!est.precisaAbastecer || !est.podePagarSwap) return null;
  for (const t of tokensPreferidos) {
    try {
      const cot = await cotarAbastecimento(provider, chainId, t.endereco, est.faltam);
      const bal = await new (e().Contract)(t.endereco, ABI_ERC20, provider).balanceOf(dono);
      if (bal >= cot.entradaMaxima) {
        const recibo = await abastecer(signer, cot, opcoesTx);
        return { recibo, cotacao: cot, simbolo: t.simbolo };
      }
    } catch {
      /* tenta o próximo token */
    }
  }
  return null;
}
