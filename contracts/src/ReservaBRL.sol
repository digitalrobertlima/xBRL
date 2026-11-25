// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface IxBRLEmissao is IERC20 {
    function mint(address para, uint256 valor) external;
    function burn(uint256 valor) external;
}

/// @title ReservaBRL — lastro 100%+ em stablecoins de Real, lista de lastros FIXA, proteções automáticas
/// @notice Emite e resgata xBRL contra stablecoins BRL (BRZ, BRLA, BRL1, WBRL). 1 xBRL = 1 real de lastro.
///
/// Taxa de 0,1% na emissão e no resgate: metade para o CREATOR_TREASURY, metade para o COLCHÃO (CofreCripto),
/// que guarda xBRL para cobrir eventuais prejuízos de liquidação do cofre de cripto.
///
/// Proteções (todas automáticas, sem decisão humana):
///   1. Lista de lastros gravada no deploy e IMUTÁVEL. Ninguém (nem o dono) consegue adicionar um token,
///      então não existe o golpe de "lastro falso". Migração futura (ex.: lastro em cripto
///      supercolateralizada) será um contrato NOVO, que as pessoas escolhem usar.
///   2. Spread de diversificação: com 2+ lastros e reserva >= 10.000, emitir com um lastro acima da sua fatia
///      (1/N) ou resgatar um lastro abaixo dela paga até +0,40%. O extra NÃO vai para ninguém: fica na
///      reserva como lastro a mais (> 100%). Isso paga arbitradores para manter a reserva equilibrada.
///   3. Teto diário de emissão POR lastro: no máximo o maior entre 50.000 e 10% da reserva por 24 h. Se um
///      lastro perder a paridade, robôs não conseguem trocá-lo pelo lastro bom de uma vez só.
///   4. Fase 2 (supply >= 1.000.000): resgate de até 20% do supply por 24 h (anti-corrida bancária).
///
/// Invariante central (testado por fuzzing): lastroTotal() >= totalSupply() - dívida do CofreCripto.
/// Versão beta: `TETO_RESERVA` limita o tamanho total da reserva (0 = sem limite).
/// O dono NÃO saca lastro, NÃO pausa resgates, NÃO muda taxas, NÃO adiciona lastro. Ele só pode pausar
/// a EMISSÃO com um lastro específico (ex.: emissor do lastro em crise). Resgate nunca é pausável.
contract ReservaBRL is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Lastro {
        bool aceito;
        bool emissaoAtiva;
        uint8 decimais;
        uint64 inicioJanela; // janela de 24 h do teto de emissão
        uint128 emitidoNaJanela; // em 18 casas
        uint128 limiteJanela; // fixado no início de cada janela
    }

    IxBRLEmissao public immutable XBRL;
    address public immutable CREATOR_TREASURY;
    address public immutable COLCHAO;
    uint256 public immutable TETO_RESERVA;

    uint256 public constant BPS = 10_000;
    uint256 public constant TAXA_BPS = 10; // 0,1% na emissão e no resgate
    uint256 public constant LIMIAR_FASE_2 = 1_000_000e18;
    uint256 public constant LIMIAR_SPREAD = 10_000e18;
    uint256 public constant CONCENTRACAO_MAX_BPS = 6_000; // spread máximo a partir de 60% de fatia
    uint256 public constant SPREAD_MAX_BPS = 40; // +0,40%
    uint256 public constant EMISSAO_JANELA_BPS = 1_000; // 10% da reserva por lastro a cada 24 h
    uint256 public constant EMISSAO_JANELA_MINIMO = 50_000e18;
    uint256 public constant FASE2_RESGATE_JANELA_BPS = 2_000; // 20% do supply
    uint256 public constant JANELA = 1 days;
    uint256 public constant MAX_LASTROS = 8;

    mapping(address => Lastro) public lastros;
    address[] private _listaLastros;

    uint64 public inicioJanela;
    uint256 public resgatadoNaJanela;
    uint256 public supplyInicioJanela;

    event LastroAtivado(address indexed token, uint8 decimais);
    event EmissaoLastroAlterada(address indexed token, bool ativa);
    event Emitido(
        address indexed usuario,
        address indexed lastro,
        uint256 depositado,
        uint256 xbrlLiquido,
        uint256 taxa,
        uint256 spread
    );
    event Resgatado(
        address indexed usuario,
        address indexed lastro,
        uint256 xbrlEntregue,
        uint256 pago,
        uint256 taxa,
        uint256 spread
    );

    error EnderecoZero();
    error ValorZero();
    error LastroDesconhecido(address token);
    error LastroJaExiste(address token);
    error EmissaoPausada(address token);
    error DecimaisInvalidos(uint8 decimais);
    error QuantidadeDeLastrosInvalida();
    error LimiteEmissaoDiaria(uint256 disponivel);
    error LimiteJanelaResgate(uint256 disponivel);
    error LastroInsuficiente(uint256 disponivel, uint256 necessario);
    error SaidaMinimaNaoAtingida(uint256 obtido, uint256 minimo);
    error TetoDaReservaAtingido(uint256 teto);

    constructor(
        address xbrl,
        address treasury,
        address colchao,
        address[] memory lastrosFixos,
        address dono,
        uint256 tetoReserva
    ) Ownable(dono) {
        if (xbrl == address(0) || treasury == address(0) || colchao == address(0)) {
            revert EnderecoZero();
        }
        COLCHAO = colchao;
        TETO_RESERVA = tetoReserva;
        if (lastrosFixos.length == 0 || lastrosFixos.length > MAX_LASTROS) {
            revert QuantidadeDeLastrosInvalida();
        }
        XBRL = IxBRLEmissao(xbrl);
        CREATOR_TREASURY = treasury;
        for (uint256 i = 0; i < lastrosFixos.length; ++i) {
            address token = lastrosFixos[i];
            if (token == address(0)) revert EnderecoZero();
            Lastro storage l = lastros[token];
            if (l.aceito) revert LastroJaExiste(token);
            uint8 dec = IERC20Metadata(token).decimals();
            if (dec > 18) revert DecimaisInvalidos(dec);
            l.aceito = true;
            l.emissaoAtiva = true;
            l.decimais = dec;
            _listaLastros.push(token);
            emit LastroAtivado(token, dec);
        }
    }

    // ------------------------------------------------------------------
    // Único poder do dono: pausar/retomar a EMISSÃO com um lastro
    // ------------------------------------------------------------------

    function definirEmissaoAtiva(address token, bool ativa) external onlyOwner {
        Lastro storage l = lastros[token];
        if (!l.aceito) revert LastroDesconhecido(token);
        l.emissaoAtiva = ativa;
        emit EmissaoLastroAlterada(token, ativa);
    }

    // ------------------------------------------------------------------
    // Leitura
    // ------------------------------------------------------------------

    function listaLastros() external view returns (address[] memory) {
        return _listaLastros;
    }

    /// @notice 1 = sem limite de resgate; 2 = resgate limitado a 20% do supply por 24 h.
    function fase() public view returns (uint8) {
        return XBRL.totalSupply() >= LIMIAR_FASE_2 ? 2 : 1;
    }

    function saldoNormalizado(address token) public view returns (uint256) {
        return _normalizar(IERC20(token).balanceOf(address(this)), lastros[token].decimais);
    }

    function lastroTotal() public view returns (uint256 total) {
        for (uint256 i = 0; i < _listaLastros.length; ++i) {
            total += saldoNormalizado(_listaLastros[i]);
        }
    }

    /// @notice Índice de colateralização em bps (10_000 = 100%). Com supply zero retorna o máximo.
    function colateralizacaoBps() external view returns (uint256) {
        uint256 supply = XBRL.totalSupply();
        if (supply == 0) return type(uint256).max;
        return (lastroTotal() * BPS) / supply;
    }

    /// @notice Quanto ainda pode ser emitido (bruto, 18 casas) com `token` na janela atual de 24 h.
    function emissaoDisponivelNaJanela(address token) public view returns (uint256) {
        Lastro memory l = lastros[token];
        if (!l.aceito) revert LastroDesconhecido(token);
        if (l.inicioJanela == 0 || block.timestamp >= uint256(l.inicioJanela) + JANELA) {
            return _limiteEmissaoNovo();
        }
        return l.limiteJanela > l.emitidoNaJanela ? l.limiteJanela - l.emitidoNaJanela : 0;
    }

    /// @notice Quanto ainda pode ser resgatado na janela atual (Fase 2). Na Fase 1 é ilimitado.
    function resgateDisponivelNaJanela() public view returns (uint256) {
        if (fase() == 1) return type(uint256).max;
        if (inicioJanela == 0 || block.timestamp >= uint256(inicioJanela) + JANELA) {
            return (XBRL.totalSupply() * FASE2_RESGATE_JANELA_BPS) / BPS;
        }
        uint256 limite = (supplyInicioJanela * FASE2_RESGATE_JANELA_BPS) / BPS;
        return limite > resgatadoNaJanela ? limite - resgatadoNaJanela : 0;
    }

    /// @notice Cotação de emissão: depositar `quantia` (unidades do lastro) gera quanto de xBRL.
    function cotarEmissao(address token, uint256 quantia)
        public
        view
        returns (uint256 liquido, uint256 taxa, uint256 spread)
    {
        Lastro memory l = lastros[token];
        if (!l.aceito) revert LastroDesconhecido(token);
        uint256 bruto = _normalizar(quantia, l.decimais);
        return _calcEmissao(bruto, saldoNormalizado(token) + bruto, lastroTotal() + bruto);
    }

    /// @notice Cotação de resgate: entregar `valorXbrl` paga quanto do lastro (unidades do lastro).
    function cotarResgate(address token, uint256 valorXbrl)
        public
        view
        returns (uint256 pago, uint256 taxa, uint256 spread)
    {
        Lastro memory l = lastros[token];
        if (!l.aceito) revert LastroDesconhecido(token);
        taxa = (valorXbrl * TAXA_BPS) / BPS;
        uint256 bruto = valorXbrl - taxa;
        spread = _spreadResgate(token, bruto);
        pago = _desnormalizar(bruto - spread, l.decimais);
    }

    // ------------------------------------------------------------------
    // Emissão e resgate
    // ------------------------------------------------------------------

    /// @notice Deposita `quantia` do lastro `token` e recebe xBRL (menos 0,1% e spread, se houver).
    function emitir(address token, uint256 quantia, uint256 minimoXbrl)
        external
        nonReentrant
        returns (uint256 liquido)
    {
        if (quantia == 0) revert ValorZero();
        Lastro storage l = lastros[token];
        if (!l.aceito) revert LastroDesconhecido(token);
        if (!l.emissaoAtiva) revert EmissaoPausada(token);

        // Mede o que realmente entrou (suporta tokens com taxa na transferência).
        uint256 antes = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), quantia);
        uint256 recebido = IERC20(token).balanceOf(address(this)) - antes;
        uint256 bruto = _normalizar(recebido, l.decimais);
        if (bruto == 0) revert ValorZero();
        if (TETO_RESERVA != 0 && lastroTotal() > TETO_RESERVA) revert TetoDaReservaAtingido(TETO_RESERVA);
        _consumirEmissao(l, bruto);

        uint256 taxa;
        uint256 spread;
        (liquido, taxa, spread) = _calcEmissao(bruto, saldoNormalizado(token), lastroTotal());
        if (liquido < minimoXbrl) revert SaidaMinimaNaoAtingida(liquido, minimoXbrl);

        // Protegido por nonReentrant; o lastro já entrou e foi medido pelo saldo.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        XBRL.mint(msg.sender, liquido);
        if (taxa != 0) {
            // forge-lint: disable-next-line(reentrancy-no-eth)
            XBRL.mint(CREATOR_TREASURY, taxa - taxa / 2);
            // forge-lint: disable-next-line(reentrancy-no-eth)
            XBRL.mint(COLCHAO, taxa / 2);
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit Emitido(msg.sender, token, recebido, liquido, taxa, spread);
    }

    /// @notice Entrega `valorXbrl` e recebe o lastro `token` 1:1 (menos 0,1% e spread, se houver).
    function resgatar(address token, uint256 valorXbrl, uint256 minimoLastro)
        external
        nonReentrant
        returns (uint256 pago)
    {
        if (valorXbrl == 0) revert ValorZero();
        Lastro memory l = lastros[token];
        if (!l.aceito) revert LastroDesconhecido(token);

        uint256 taxa = (valorXbrl * TAXA_BPS) / BPS;
        uint256 bruto = valorXbrl - taxa; // xBRL que será queimado
        _consumirJanelaResgate(bruto);

        uint256 spread = _spreadResgate(token, bruto);
        pago = _desnormalizar(bruto - spread, l.decimais);
        if (pago == 0) revert ValorZero();
        if (pago < minimoLastro) revert SaidaMinimaNaoAtingida(pago, minimoLastro);
        uint256 disponivel = IERC20(token).balanceOf(address(this));
        if (pago > disponivel) revert LastroInsuficiente(disponivel, pago);

        IERC20(address(XBRL)).safeTransferFrom(msg.sender, address(this), valorXbrl);
        if (taxa != 0) {
            IERC20(address(XBRL)).safeTransfer(CREATOR_TREASURY, taxa - taxa / 2);
            IERC20(address(XBRL)).safeTransfer(COLCHAO, taxa / 2);
        }
        // Protegido por nonReentrant; a janela de resgate já foi atualizada antes das chamadas.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        XBRL.burn(bruto);
        IERC20(token).safeTransfer(msg.sender, pago);
        // forge-lint: disable-next-line(reentrancy-events)
        emit Resgatado(msg.sender, token, valorXbrl, pago, taxa, spread);
    }

    // ------------------------------------------------------------------
    // Internos
    // ------------------------------------------------------------------

    function _calcEmissao(uint256 bruto, uint256 saldoDepois, uint256 totalDepois)
        private
        view
        returns (uint256 liquido, uint256 taxa, uint256 spread)
    {
        taxa = (bruto * TAXA_BPS) / BPS;
        uint256 n = _listaLastros.length;
        if (n > 1 && totalDepois >= LIMIAR_SPREAD) {
            uint256 participacao = (saldoDepois * BPS) / totalDepois;
            uint256 alvo = BPS / n;
            if (participacao >= CONCENTRACAO_MAX_BPS) {
                spread = (bruto * SPREAD_MAX_BPS) / BPS;
            } else if (participacao > alvo) {
                spread =
                    (bruto * (participacao - alvo) * SPREAD_MAX_BPS) / ((CONCENTRACAO_MAX_BPS - alvo) * BPS);
            }
        }
        liquido = bruto - taxa - spread;
    }

    function _spreadResgate(address token, uint256 bruto) private view returns (uint256) {
        uint256 n = _listaLastros.length;
        if (n < 2) return 0;
        uint256 total = lastroTotal();
        if (total < LIMIAR_SPREAD) return 0;
        uint256 saldo = saldoNormalizado(token);
        if (total <= bruto || saldo <= bruto) return (bruto * SPREAD_MAX_BPS) / BPS;
        // Depois do resgate, a fatia deste lastro fica abaixo do alvo (1/N)? Paga spread proporcional à falta.
        uint256 restoTotal = total - bruto;
        uint256 restoLastroN = (saldo - bruto) * n;
        if (restoLastroN >= restoTotal) return 0;
        return (bruto * (restoTotal - restoLastroN) * SPREAD_MAX_BPS) / (restoTotal * BPS);
    }

    function _limiteEmissaoNovo() private view returns (uint256) {
        uint256 proporcional = (lastroTotal() * EMISSAO_JANELA_BPS) / BPS;
        return proporcional > EMISSAO_JANELA_MINIMO ? proporcional : EMISSAO_JANELA_MINIMO;
    }

    function _consumirEmissao(Lastro storage l, uint256 bruto) private {
        if (l.inicioJanela == 0 || block.timestamp >= uint256(l.inicioJanela) + JANELA) {
            l.inicioJanela = SafeCast.toUint64(block.timestamp);
            l.emitidoNaJanela = 0;
            // Base = reserva ANTES deste depósito (o depósito já está no saldo).
            uint256 proporcional = ((lastroTotal() - bruto) * EMISSAO_JANELA_BPS) / BPS;
            l.limiteJanela = SafeCast.toUint128(
                proporcional > EMISSAO_JANELA_MINIMO ? proporcional : EMISSAO_JANELA_MINIMO
            );
        }
        uint256 novo = uint256(l.emitidoNaJanela) + bruto;
        if (novo > l.limiteJanela) {
            revert LimiteEmissaoDiaria(l.limiteJanela > l.emitidoNaJanela
                    ? l.limiteJanela - l.emitidoNaJanela
                    : 0);
        }
        l.emitidoNaJanela = SafeCast.toUint128(novo);
    }

    function _consumirJanelaResgate(uint256 bruto) private {
        if (fase() == 1) return;
        if (inicioJanela == 0 || block.timestamp >= uint256(inicioJanela) + JANELA) {
            inicioJanela = SafeCast.toUint64(block.timestamp);
            resgatadoNaJanela = 0;
            supplyInicioJanela = XBRL.totalSupply();
        }
        uint256 limite = (supplyInicioJanela * FASE2_RESGATE_JANELA_BPS) / BPS;
        uint256 novo = resgatadoNaJanela + bruto;
        if (novo > limite) {
            revert LimiteJanelaResgate(limite > resgatadoNaJanela ? limite - resgatadoNaJanela : 0);
        }
        resgatadoNaJanela = novo;
    }

    function _normalizar(uint256 quantia, uint8 decimais) private pure returns (uint256) {
        return quantia * (10 ** (18 - uint256(decimais)));
    }

    function _desnormalizar(uint256 valor18, uint8 decimais) private pure returns (uint256) {
        return valor18 / (10 ** (18 - uint256(decimais)));
    }
}
