// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IAgregadorChainlink {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IPoolUniswapV3 {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface IxBRLCofre is IERC20 {
    function mint(address para, uint256 valor) external;
    function burn(uint256 valor) external;
}

/// @title CofreCripto — xBRL supercolateralizado em ETH e POL, 100% autônomo
/// @notice Cada pessoa deposita a SUA cripto (WETH ou WPOL) e emite xBRL até uma fração do valor dela:
///   - WETH: garantia mínima de 200% para emitir; pode ser liquidada abaixo de 150%.
///   - WPOL: 250% para emitir; liquidável abaixo de 175%.
/// A cripto é da pessoa: o cofre NUNCA vende nada por conta própria. O único "rebalanceamento" é a
/// LIQUIDAÇÃO: quando a garantia de uma posição fica fraca, qualquer pessoa paga a dívida dela em xBRL
/// (que é queimado) e leva a garantia equivalente com 10% de bônus; o que sobra continua do dono.
///
/// Preço: Chainlink (ativo/USD e BRL/USD) conferido com a média de 30 minutos (TWAP) da pool Uniswap V3 do
/// ativo contra USDC. Divergência > 5% = preço indisponível. Chainlink parada = usa o TWAP (se existir).
/// Preço indisponível trava EMITIR, RETIRAR com dívida e LIQUIDAR; DEPOSITAR e QUITAR nunca travam.
///
/// COLCHÃO: este contrato guarda xBRL de segurança (metade das taxas de todo o protocolo vem para cá).
/// Ele só é usado para queimar dívida que uma liquidação não conseguiu cobrir (queda rápida demais).
/// O que nem o colchão cobrir fica registrado, público, em `dividaRuim`.
///
/// Sem dono, sem pausa, sem upgrade. Tetos de dívida por ativo são fixos (versão beta usa tetos baixos).
contract CofreCripto is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct ConfigAtivo {
        address token;
        address feedUsd; // Chainlink ativo/USD
        uint32 heartbeat; // idade máxima aceita da resposta da Chainlink
        address pool; // Uniswap V3 ativo/USDC (0 = sem conferência TWAP)
        bool ativoEhToken0;
        uint8 decimaisPar; // casas do outro token da pool (USDC = 6)
        uint16 crEmissaoBps; // ex.: 20_000 = 200%
        uint16 crLiquidacaoBps; // ex.: 15_000 = 150%
        uint128 tetoDivida; // dívida máxima somada neste ativo (xBRL)
    }

    struct Ativo {
        address token;
        address feedUsd;
        uint32 heartbeat;
        uint8 decimais;
        uint8 decimaisFeed;
        address pool;
        bool ativoEhToken0;
        uint8 decimaisPar;
        uint16 crEmissaoBps;
        uint16 crLiquidacaoBps;
        uint128 tetoDivida;
        uint128 dividaTotal;
    }

    struct Posicao {
        uint128 colateral;
        uint128 divida;
    }

    IxBRLCofre public immutable XBRL;
    address public immutable CREATOR_TREASURY;
    IAgregadorChainlink public immutable FEED_BRL_USD;
    uint32 public immutable HEARTBEAT_BRL;
    uint8 private immutable DECIMAIS_FEED_BRL;

    uint256 public constant BPS = 10_000;
    uint256 public constant TAXA_EMISSAO_BPS = 50; // 0,5% somado à dívida: metade Treasury, metade colchão
    uint256 public constant BONUS_LIQUIDACAO_BPS = 1_000; // 10%
    uint256 public constant DESVIO_MAX_TWAP_BPS = 500; // 5%
    uint32 public constant JANELA_TWAP = 1_800; // 30 minutos
    uint256 public constant DIVIDA_MINIMA = 10e18;
    int256 private constant TICK_MAX = 600_000;

    Ativo[] private _ativos;
    mapping(uint256 => mapping(address => Posicao)) private _posicoes;
    uint256 public dividaTotalGlobal;
    uint256 public dividaRuim;

    event Depositado(uint256 indexed ativo, address indexed conta, uint256 quantidade);
    event Retirado(uint256 indexed ativo, address indexed conta, uint256 quantidade);
    event Emitido(uint256 indexed ativo, address indexed conta, uint256 valor, uint256 taxa);
    event Quitado(uint256 indexed ativo, address indexed conta, address indexed pagador, uint256 valor);
    event Liquidado(
        uint256 indexed ativo,
        address indexed conta,
        address indexed liquidante,
        uint256 dividaQuitada,
        uint256 colateralEntregue,
        uint256 cobertoPeloColchao,
        uint256 novaDividaRuim
    );

    error EnderecoZero();
    error ConfigInvalida();
    error AtivoInexistente();
    error ValorZero();
    error PrecoIndisponivel();
    error GarantiaInsuficiente(uint256 razaoBps, uint256 minimoBps);
    error TetoDeDivida(uint256 disponivel);
    error DividaMinima();
    error PosicaoSaudavel(uint256 razaoBps);
    error ColateralInsuficiente();

    constructor(
        address xbrl,
        address treasury,
        ConfigAtivo[] memory ativos,
        address feedBrlUsd,
        uint32 heartbeatBrl
    ) {
        if (xbrl == address(0) || treasury == address(0) || feedBrlUsd == address(0)) {
            revert EnderecoZero();
        }
        if (ativos.length == 0 || ativos.length > 8) revert ConfigInvalida();
        XBRL = IxBRLCofre(xbrl);
        CREATOR_TREASURY = treasury;
        FEED_BRL_USD = IAgregadorChainlink(feedBrlUsd);
        HEARTBEAT_BRL = heartbeatBrl;
        DECIMAIS_FEED_BRL = IAgregadorChainlink(feedBrlUsd).decimals();
        for (uint256 i = 0; i < ativos.length; ++i) {
            ConfigAtivo memory c = ativos[i];
            if (c.token == address(0) || c.feedUsd == address(0)) revert EnderecoZero();
            // A liquidação precisa caber o bônus com folga, e a emissão precisa de folga sobre a liquidação.
            if (c.crLiquidacaoBps < 12_000 || c.crEmissaoBps < uint256(c.crLiquidacaoBps) + 2_000) {
                revert ConfigInvalida();
            }
            uint8 dec = IERC20Metadata(c.token).decimals();
            if (dec > 18) revert ConfigInvalida();
            _ativos.push(
                Ativo({
                    token: c.token,
                    feedUsd: c.feedUsd,
                    heartbeat: c.heartbeat,
                    decimais: dec,
                    decimaisFeed: IAgregadorChainlink(c.feedUsd).decimals(),
                    pool: c.pool,
                    ativoEhToken0: c.ativoEhToken0,
                    decimaisPar: c.decimaisPar,
                    crEmissaoBps: c.crEmissaoBps,
                    crLiquidacaoBps: c.crLiquidacaoBps,
                    tetoDivida: c.tetoDivida,
                    dividaTotal: 0
                })
            );
        }
    }

    // ------------------------------------------------------------------
    // Leitura
    // ------------------------------------------------------------------

    function totalAtivos() external view returns (uint256) {
        return _ativos.length;
    }

    function ativo(uint256 i) external view returns (Ativo memory) {
        return _a(i);
    }

    function posicao(uint256 i, address conta) external view returns (Posicao memory) {
        return _posicoes[i][conta];
    }

    /// @notice xBRL guardado como colchão de segurança.
    function colchao() public view returns (uint256) {
        return XBRL.balanceOf(address(this));
    }

    /// @notice Quanto ainda cabe de dívida neste ativo.
    function emissaoDisponivel(uint256 i) external view returns (uint256) {
        Ativo storage a = _a(i);
        return a.tetoDivida > a.dividaTotal ? a.tetoDivida - a.dividaTotal : 0;
    }

    /// @notice Garantia/dívida em bps (type(uint256).max sem dívida). `ok=false` se o preço estiver indisponível.
    function razaoGarantia(uint256 i, address conta) public view returns (uint256 razaoBps, bool ok) {
        Posicao memory p = _posicoes[i][conta];
        if (p.divida == 0) return (type(uint256).max, true);
        uint256 preco;
        (preco, ok) = precoBrl(i);
        if (!ok) return (0, false);
        razaoBps = (_valor(_a(i), p.colateral, preco) * BPS) / p.divida;
    }

    /// @notice Preço de 1 unidade inteira do ativo em reais (18 casas), com conferência dupla. Usado na
    /// liquidação e nas telas: com as duas fontes, elas precisam concordar; com uma só fora do ar, vale a outra
    /// (para a liquidação nunca parar numa queda real). Emitir/retirar usam `precoParaEmitir`, mais rígido.
    function precoBrl(uint256 i) public view returns (uint256 preco, bool ok) {
        Ativo storage a = _a(i);
        (uint256 brlUsd, bool okBrl) = _chainlink(FEED_BRL_USD, DECIMAIS_FEED_BRL, HEARTBEAT_BRL);
        if (!okBrl) return (0, false);
        (uint256 usdCl, bool okCl) = _chainlink(IAgregadorChainlink(a.feedUsd), a.decimaisFeed, a.heartbeat);
        (uint256 usdTw, bool okTw) = precoTwapUsd(i);
        uint256 usd;
        if (okCl && okTw) {
            uint256 desvio = usdCl > usdTw ? usdCl - usdTw : usdTw - usdCl;
            if (desvio * BPS > usdTw * DESVIO_MAX_TWAP_BPS) return (0, false);
            usd = usdCl;
        } else if (okCl) {
            usd = usdCl;
        } else if (okTw) {
            usd = usdTw;
        } else {
            return (0, false);
        }
        return (Math.mulDiv(usd, 1e18, brlUsd), true);
    }

    /// @notice Preço CONSERVADOR usado para emitir e para retirar garantia com dívida (operações que aumentam
    /// o risco do sistema). Exige Chainlink atualizada; se o ativo tem pool configurada, exige também o TWAP
    /// e que os dois concordem (desvio <= 5%), usando o MENOR dos dois. Assim, nem uma Chainlink parada nem
    /// uma pool manipulada permitem emitir xBRL a mais.
    function precoParaEmitir(uint256 i) public view returns (uint256 preco, bool ok) {
        Ativo storage a = _a(i);
        (uint256 brlUsd, bool okBrl) = _chainlink(FEED_BRL_USD, DECIMAIS_FEED_BRL, HEARTBEAT_BRL);
        if (!okBrl) return (0, false);
        (uint256 usd, bool okCl) = _chainlink(IAgregadorChainlink(a.feedUsd), a.decimaisFeed, a.heartbeat);
        if (!okCl) return (0, false);
        if (a.pool != address(0)) {
            (uint256 usdTw, bool okTw) = precoTwapUsd(i);
            if (!okTw) return (0, false);
            uint256 desvio = usd > usdTw ? usd - usdTw : usdTw - usd;
            if (desvio * BPS > usdTw * DESVIO_MAX_TWAP_BPS) return (0, false);
            if (usdTw < usd) usd = usdTw;
        }
        return (Math.mulDiv(usd, 1e18, brlUsd), true);
    }

    /// @notice Preço médio de 30 min na Uniswap V3 (USD, 18 casas por unidade inteira do ativo).
    function precoTwapUsd(uint256 i) public view returns (uint256 usd, bool ok) {
        Ativo storage a = _a(i);
        if (a.pool == address(0)) return (0, false);
        uint32[] memory janela = new uint32[](2);
        janela[0] = JANELA_TWAP;
        try IPoolUniswapV3(a.pool).observe(janela) returns (int56[] memory acumulados, uint160[] memory) {
            int256 delta = int256(acumulados[1]) - int256(acumulados[0]);
            int256 tick = delta / int256(uint256(JANELA_TWAP));
            if (delta < 0 && delta % int256(uint256(JANELA_TWAP)) != 0) --tick; // arredonda para baixo
            if (tick > TICK_MAX || tick < -TICK_MAX) return (0, false);
            uint256 razaoQ128 = razaoDoTick(tick); // token1 por token0 (unidades mínimas), Q128
            if (razaoQ128 == 0) return (0, false);
            uint256 escalaAtivo = 10 ** uint256(a.decimais);
            uint256 escalaPar = 10 ** uint256(a.decimaisPar);
            if (a.ativoEhToken0) {
                usd = Math.mulDiv(razaoQ128, escalaAtivo * 1e18, escalaPar << 128);
            } else {
                usd = Math.mulDiv(uint256(1) << 128, escalaAtivo * 1e18, Math.mulDiv(razaoQ128, escalaPar, 1));
            }
            ok = usd != 0;
        } catch {
            return (0, false);
        }
    }

    /// @notice 1,0001^tick em ponto fixo Q128 (mesmo princípio do TickMath da Uniswap, sem raiz quadrada).
    function razaoDoTick(int256 tick) public pure returns (uint256 r) {
        uint256 abs = SafeCast.toUint256(tick < 0 ? -tick : tick);
        r = uint256(1) << 128;
        if (abs & 0x1 != 0) r = (r * 0xfff97272373d413259a46990580e2139) >> 128;
        if (abs & 0x2 != 0) r = (r * 0xfff2e50f5f656932ef12357cf3c7fdcb) >> 128;
        if (abs & 0x4 != 0) r = (r * 0xffe5caca7e10e4e61c3624eaa0941ccf) >> 128;
        if (abs & 0x8 != 0) r = (r * 0xffcb9843d60f6159c9db58835c926643) >> 128;
        if (abs & 0x10 != 0) r = (r * 0xff973b41fa98c081472e6896dfb254bf) >> 128;
        if (abs & 0x20 != 0) r = (r * 0xff2ea16466c96a3843ec78b326b52860) >> 128;
        if (abs & 0x40 != 0) r = (r * 0xfe5dee046a99a2a811c461f1969c3052) >> 128;
        if (abs & 0x80 != 0) r = (r * 0xfcbe86c7900a88aedcffc83b479aa3a3) >> 128;
        if (abs & 0x100 != 0) r = (r * 0xf987a7253ac413176f2b074cf7815e53) >> 128;
        if (abs & 0x200 != 0) r = (r * 0xf3392b0822b70005940c7a398e4b70f2) >> 128;
        if (abs & 0x400 != 0) r = (r * 0xe7159475a2c29b7443b29c7fa6e889d8) >> 128;
        if (abs & 0x800 != 0) r = (r * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (abs & 0x1000 != 0) r = (r * 0xa9f746462d870fdf8a65dc1f90e061e4) >> 128;
        if (abs & 0x2000 != 0) r = (r * 0x70d869a156d2a1b890bb3df62baf32f6) >> 128;
        if (abs & 0x4000 != 0) r = (r * 0x31be135f97d08fd981231505542fcfa5) >> 128;
        if (abs & 0x8000 != 0) r = (r * 0x9aa508b5b7a84e1c677de54f3e99bc8) >> 128;
        if (abs & 0x10000 != 0) r = (r * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (abs & 0x20000 != 0) r = (r * 0x2216e584f5fa1ea926041bedfe97) >> 128;
        if (abs & 0x40000 != 0) r = (r * 0x48a170391f7dc42444e8fa2) >> 128;
        if (abs & 0x80000 != 0) r = (r * 0x149b34ee7ac262) >> 128;
        if (tick > 0) {
            if (r == 0) return 0;
            r = type(uint256).max / r; // inverso em Q128
        }
    }

    // ------------------------------------------------------------------
    // Operações do dono da posição
    // ------------------------------------------------------------------
    // Todas as funções que movem valor são nonReentrant e atualizam o estado antes de transferir; as chamadas
    // externas anteriores são leituras de oráculo (view) e o xBRL/garantias não têm ganchos de reentrada.
    // forge-lint: disable-start(reentrancy-no-eth, reentrancy-events)

    /// @notice Deposita garantia (nunca trava, mesmo sem preço).
    function depositar(uint256 i, uint256 quantidade) external nonReentrant {
        Ativo storage a = _a(i);
        if (quantidade == 0) revert ValorZero();
        uint256 antes = IERC20(a.token).balanceOf(address(this));
        IERC20(a.token).safeTransferFrom(msg.sender, address(this), quantidade);
        uint256 recebido = IERC20(a.token).balanceOf(address(this)) - antes;
        Posicao storage p = _posicoes[i][msg.sender];
        p.colateral = SafeCast.toUint128(uint256(p.colateral) + recebido);
        emit Depositado(i, msg.sender, recebido);
    }

    /// @notice Retira garantia. Com dívida aberta, precisa de preço e de manter a garantia mínima de emissão.
    function retirar(uint256 i, uint256 quantidade) external nonReentrant {
        Ativo storage a = _a(i);
        Posicao storage p = _posicoes[i][msg.sender];
        if (quantidade == 0) revert ValorZero();
        if (quantidade > p.colateral) revert ColateralInsuficiente();
        p.colateral -= SafeCast.toUint128(quantidade);
        if (p.divida != 0) _exigirGarantia(i, a, p, a.crEmissaoBps);
        IERC20(a.token).safeTransfer(msg.sender, quantidade);
        emit Retirado(i, msg.sender, quantidade);
    }

    /// @notice Emite `valor` xBRL contra a garantia depositada. Soma 0,5% de taxa à dívida.
    function emitir(uint256 i, uint256 valor) external nonReentrant {
        Ativo storage a = _a(i);
        if (valor == 0) revert ValorZero();
        Posicao storage p = _posicoes[i][msg.sender];
        uint256 taxa = (valor * TAXA_EMISSAO_BPS) / BPS;
        uint256 acrescimo = valor + taxa;
        uint256 disponivel = a.tetoDivida > a.dividaTotal ? a.tetoDivida - a.dividaTotal : 0;
        if (acrescimo > disponivel) revert TetoDeDivida(disponivel);
        uint256 novaDivida = uint256(p.divida) + acrescimo;
        if (novaDivida < DIVIDA_MINIMA) revert DividaMinima();
        p.divida = SafeCast.toUint128(novaDivida);
        a.dividaTotal = SafeCast.toUint128(uint256(a.dividaTotal) + acrescimo);
        dividaTotalGlobal += acrescimo;
        _exigirGarantia(i, a, p, a.crEmissaoBps);

        XBRL.mint(msg.sender, valor);
        if (taxa != 0) {
            XBRL.mint(CREATOR_TREASURY, taxa - taxa / 2);
            XBRL.mint(address(this), taxa / 2); // colchão
        }
        emit Emitido(i, msg.sender, valor, taxa);
    }

    /// @notice Paga dívida (de qualquer posição) com xBRL, que é queimado. Nunca trava.
    function quitar(uint256 i, address conta, uint256 valor) external nonReentrant {
        Ativo storage a = _a(i);
        Posicao storage p = _posicoes[i][conta];
        if (valor > p.divida) valor = p.divida;
        if (valor == 0) revert ValorZero();
        uint256 resta = uint256(p.divida) - valor;
        if (resta != 0 && resta < DIVIDA_MINIMA) revert DividaMinima();
        p.divida = SafeCast.toUint128(resta);
        a.dividaTotal -= SafeCast.toUint128(valor);
        dividaTotalGlobal -= valor;
        IERC20(address(XBRL)).safeTransferFrom(msg.sender, address(this), valor);
        XBRL.burn(valor);
        emit Quitado(i, conta, msg.sender, valor);
    }

    // ------------------------------------------------------------------
    // Liquidação (qualquer pessoa)
    // ------------------------------------------------------------------

    /// @notice Liquida uma posição abaixo da garantia de liquidação. O liquidante paga a dívida inteira em xBRL
    /// (queimado) e recebe garantia valendo a dívida + 10%. O restante da garantia continua do dono.
    /// Se a garantia não cobrir isso (queda brusca), o liquidante paga o que ela vale / 1,10, leva toda a
    /// garantia, e a diferença é queimada do colchão; o que faltar vira `dividaRuim` (público).
    function liquidar(uint256 i, address conta) external nonReentrant {
        Ativo storage a = _a(i);
        Posicao storage p = _posicoes[i][conta];
        PlanoLiquidacao memory q = _planejarLiquidacao(i, a, p);

        p.divida = 0;
        p.colateral -= SafeCast.toUint128(q.entregar);
        a.dividaTotal -= SafeCast.toUint128(q.divida);
        dividaTotalGlobal -= q.divida;
        dividaRuim += q.ruim;

        if (q.pagar != 0) IERC20(address(XBRL)).safeTransferFrom(msg.sender, address(this), q.pagar);
        if (q.pagar + q.coberto != 0) XBRL.burn(q.pagar + q.coberto);
        IERC20(a.token).safeTransfer(msg.sender, q.entregar);
        emit Liquidado(i, conta, msg.sender, q.divida, q.entregar, q.coberto, q.ruim);
    }

    // forge-lint: disable-end(reentrancy-no-eth, reentrancy-events)

    struct PlanoLiquidacao {
        uint256 divida;
        uint256 entregar;
        uint256 pagar;
        uint256 coberto;
        uint256 ruim;
    }

    /// @notice Simula a liquidação (útil para a carteira e para robôs liquidantes).
    function simularLiquidacao(uint256 i, address conta) external view returns (PlanoLiquidacao memory) {
        return _planejarLiquidacao(i, _a(i), _posicoes[i][conta]);
    }

    function _planejarLiquidacao(uint256 i, Ativo storage a, Posicao storage p)
        private
        view
        returns (PlanoLiquidacao memory q)
    {
        q.divida = p.divida;
        if (q.divida == 0) revert PosicaoSaudavel(type(uint256).max);
        (uint256 preco, bool ok) = precoBrl(i);
        if (!ok) revert PrecoIndisponivel();
        uint256 valorColateral = _valor(a, p.colateral, preco);
        uint256 razao = (valorColateral * BPS) / q.divida;
        if (razao >= a.crLiquidacaoBps) revert PosicaoSaudavel(razao);
        uint256 alvo = (q.divida * (BPS + BONUS_LIQUIDACAO_BPS)) / BPS;
        if (valorColateral >= alvo) {
            q.entregar = Math.mulDiv(alvo, 10 ** uint256(a.decimais), preco);
            if (q.entregar > p.colateral) q.entregar = p.colateral;
            q.pagar = q.divida;
        } else {
            q.entregar = p.colateral;
            q.pagar = (valorColateral * BPS) / (BPS + BONUS_LIQUIDACAO_BPS);
        }
        uint256 faltante = q.divida - q.pagar;
        uint256 saldoColchao = colchao();
        q.coberto = faltante > saldoColchao ? saldoColchao : faltante;
        q.ruim = faltante - q.coberto;
    }

    // ------------------------------------------------------------------
    // Internos
    // ------------------------------------------------------------------

    function _a(uint256 i) private view returns (Ativo storage) {
        if (i >= _ativos.length) revert AtivoInexistente();
        return _ativos[i];
    }

    function _valor(Ativo storage a, uint256 quantidade, uint256 preco) private view returns (uint256) {
        return Math.mulDiv(quantidade, preco, 10 ** uint256(a.decimais));
    }

    function _exigirGarantia(uint256 i, Ativo storage a, Posicao storage p, uint256 minimoBps) private view {
        (uint256 preco, bool ok) = precoParaEmitir(i);
        if (!ok) revert PrecoIndisponivel();
        uint256 razao = (_valor(a, p.colateral, preco) * BPS) / p.divida;
        if (razao < minimoBps) revert GarantiaInsuficiente(razao, minimoBps);
    }

    function _chainlink(IAgregadorChainlink feed, uint8 decimais, uint256 heartbeat)
        private
        view
        returns (uint256 preco, bool ok)
    {
        try feed.latestRoundData() returns (
            uint80 roundId, int256 resposta, uint256, uint256 atualizado, uint80 resp
        ) {
            if (resposta <= 0 || atualizado == 0 || atualizado > block.timestamp) return (0, false);
            if (block.timestamp - atualizado > heartbeat || resp < roundId) return (0, false);
            preco = SafeCast.toUint256(resposta) * 10 ** (18 - uint256(decimais));
            ok = true;
        } catch {
            return (0, false);
        }
    }
}
