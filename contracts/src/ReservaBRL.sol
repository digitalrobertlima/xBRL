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

/// @title ReservaBRL — lastro 100% em stablecoins de Real, com estabilização algorítmica em 2 fases
/// @notice Emite e resgata xBRL contra stablecoins BRL (BRZ, BRLA...).
///
/// FASE 1 (supply < 1.000.000 xBRL): paridade estrita 1:1, taxa fixa de 0,1% ao Treasury, sem limites.
/// FASE 2 (supply >= 1.000.000 xBRL): continua 1:1 e 100% lastreado, mais regras automáticas:
///   a) Alvo de diversificação: com N lastros, o alvo é 1/N da reserva para cada um.
///   b) Spread dinâmico: emitir com um lastro acima do alvo paga um extra que sobe linearmente até +0,40%
///      quando ele chega a 60% da reserva (e fica em 0,40% acima disso); resgatar um lastro abaixo do alvo
///      também paga até +0,40%. Esse extra NÃO vai para ninguém: fica na reserva como sobrecolateral
///      (lastro > 100%), protegendo todos contra o depeg de um lastro concentrado. Nunca bloqueia.
///   c) Janela de resgate: até 20% do supply por 24h (proteção contra corrida bancária / depeg de um lastro).
///
/// Invariante central (testado por fuzzing): soma do lastro normalizado >= totalSupply de xBRL.
/// O dono NÃO consegue sacar lastro, congelar resgates nem alterar taxas. Ele só pode:
///   - propor um novo lastro (ativa só após 7 dias, tempo para todos saírem se discordarem);
///   - pausar a EMISSÃO com um lastro específico (ex.: depeg). Resgate nunca é pausável.
contract ReservaBRL is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Lastro {
        bool aceito; // ativo para resgate (para sempre, depois de aceito)
        bool emissaoAtiva; // pode ser usado para emitir
        uint8 decimais;
        uint64 ativavelEm; // > 0 enquanto proposto e ainda não ativado
    }

    IxBRLEmissao public immutable XBRL;
    address public immutable CREATOR_TREASURY;

    uint256 public constant BPS = 10_000;
    uint256 public constant TAXA_BPS = 10; // 0,1%
    uint256 public constant LIMIAR_FASE_2 = 1_000_000e18;
    uint256 public constant PRAZO_NOVO_LASTRO = 7 days;
    uint256 public constant FASE2_CONCENTRACAO_MAX_BPS = 6_000; // 60%
    uint256 public constant FASE2_SPREAD_MAX_BPS = 40; // +0,40%
    uint256 public constant FASE2_RESGATE_JANELA_BPS = 2_000; // 20% do supply
    uint256 public constant JANELA = 1 days;
    uint256 public constant MAX_LASTROS = 8;

    mapping(address => Lastro) public lastros;
    address[] private _listaLastros;

    uint64 public inicioJanela;
    uint256 public resgatadoNaJanela;
    uint256 public supplyInicioJanela;

    event LastroProposto(address indexed token, uint64 ativavelEm);
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
    error PrazoNaoCumprido(uint64 ativavelEm);
    error LimiteDeLastros();
    error LimiteJanelaResgate(uint256 disponivel);
    error LastroInsuficiente(uint256 disponivel, uint256 necessario);
    error SaidaMinimaNaoAtingida(uint256 obtido, uint256 minimo);

    constructor(address xbrl, address treasury, address[] memory lastrosIniciais, address dono)
        Ownable(dono)
    {
        if (xbrl == address(0) || treasury == address(0)) revert EnderecoZero();
        XBRL = IxBRLEmissao(xbrl);
        CREATOR_TREASURY = treasury;
        for (uint256 i = 0; i < lastrosIniciais.length; ++i) {
            _ativar(lastrosIniciais[i]);
        }
    }

    // ------------------------------------------------------------------
    // Governança mínima (sem poder sobre fundos)
    // ------------------------------------------------------------------

    function proporLastro(address token) external onlyOwner {
        if (token == address(0)) revert EnderecoZero();
        Lastro storage l = lastros[token];
        if (l.aceito || l.ativavelEm != 0) revert LastroJaExiste(token);
        if (_listaLastros.length >= MAX_LASTROS) revert LimiteDeLastros();
        uint64 quando = SafeCast.toUint64(block.timestamp + PRAZO_NOVO_LASTRO);
        l.ativavelEm = quando;
        emit LastroProposto(token, quando);
    }

    /// @notice Qualquer pessoa pode ativar um lastro proposto depois de 7 dias.
    function ativarLastro(address token) external {
        Lastro storage l = lastros[token];
        if (l.aceito || l.ativavelEm == 0) revert LastroDesconhecido(token);
        if (block.timestamp < l.ativavelEm) revert PrazoNaoCumprido(l.ativavelEm);
        _ativar(token);
    }

    /// @notice Pausa/retoma apenas a EMISSÃO com um lastro. Resgates seguem sempre abertos.
    function definirEmissaoAtiva(address token, bool ativa) external onlyOwner {
        Lastro storage l = lastros[token];
        if (!l.aceito) revert LastroDesconhecido(token);
        l.emissaoAtiva = ativa;
        emit EmissaoLastroAlterada(token, ativa);
    }

    function _ativar(address token) private {
        if (token == address(0)) revert EnderecoZero();
        Lastro storage l = lastros[token];
        if (l.aceito) revert LastroJaExiste(token);
        if (_listaLastros.length >= MAX_LASTROS) revert LimiteDeLastros();
        uint8 dec = IERC20Metadata(token).decimals();
        if (dec > 18) revert DecimaisInvalidos(dec);
        l.aceito = true;
        l.emissaoAtiva = true;
        l.decimais = dec;
        l.ativavelEm = 0;
        _listaLastros.push(token);
        emit LastroAtivado(token, dec);
    }

    // ------------------------------------------------------------------
    // Leitura
    // ------------------------------------------------------------------

    function listaLastros() external view returns (address[] memory) {
        return _listaLastros;
    }

    /// @notice 1 = paridade estrita; 2 = estabilização algorítmica.
    function fase() public view returns (uint8) {
        return XBRL.totalSupply() >= LIMIAR_FASE_2 ? 2 : 1;
    }

    /// @notice Saldo de um lastro normalizado para 18 casas.
    function saldoNormalizado(address token) public view returns (uint256) {
        return _normalizar(IERC20(token).balanceOf(address(this)), lastros[token].decimais);
    }

    /// @notice Soma de todo o lastro (18 casas).
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
        return _cotarEmissao(token, _normalizar(quantia, l.decimais));
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
        spread = (bruto * _spreadResgateBps(token, bruto)) / BPS;
        pago = _desnormalizar(bruto - spread, l.decimais);
    }

    // ------------------------------------------------------------------
    // Emissão e resgate
    // ------------------------------------------------------------------

    /// @notice Deposita `quantia` do lastro `token` e recebe xBRL (menos 0,1% e spread de Fase 2, se houver).
    function emitir(address token, uint256 quantia, uint256 minimoXbrl)
        external
        nonReentrant
        returns (uint256 liquido)
    {
        if (quantia == 0) revert ValorZero();
        Lastro memory l = lastros[token];
        if (!l.aceito) revert LastroDesconhecido(token);
        if (!l.emissaoAtiva) revert EmissaoPausada(token);

        // Mede o que realmente entrou (suporta tokens com taxa na transferência).
        uint256 antes = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), quantia);
        uint256 recebido = IERC20(token).balanceOf(address(this)) - antes;
        uint256 bruto = _normalizar(recebido, l.decimais);
        if (bruto == 0) revert ValorZero();

        uint256 taxa;
        uint256 spread;
        (liquido, taxa, spread) = _cotarEmissaoPos(token, bruto);
        if (liquido < minimoXbrl) revert SaidaMinimaNaoAtingida(liquido, minimoXbrl);

        XBRL.mint(msg.sender, liquido);
        if (taxa != 0) XBRL.mint(CREATOR_TREASURY, taxa);
        emit Emitido(msg.sender, token, recebido, liquido, taxa, spread);
    }

    /// @notice Entrega `valorXbrl` e recebe o lastro `token` 1:1 (menos 0,1% e spread de Fase 2, se houver).
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
        _consumirJanela(bruto);

        uint256 spread = (bruto * _spreadResgateBps(token, bruto)) / BPS;
        pago = _desnormalizar(bruto - spread, l.decimais);
        if (pago == 0) revert ValorZero();
        if (pago < minimoLastro) revert SaidaMinimaNaoAtingida(pago, minimoLastro);
        uint256 disponivel = IERC20(token).balanceOf(address(this));
        if (pago > disponivel) revert LastroInsuficiente(disponivel, pago);

        IERC20(address(XBRL)).safeTransferFrom(msg.sender, address(this), valorXbrl);
        if (taxa != 0) IERC20(address(XBRL)).safeTransfer(CREATOR_TREASURY, taxa);
        XBRL.burn(bruto);
        IERC20(token).safeTransfer(msg.sender, pago);
        emit Resgatado(msg.sender, token, valorXbrl, pago, taxa, spread);
    }

    // ------------------------------------------------------------------
    // Internos
    // ------------------------------------------------------------------

    function _cotarEmissao(address token, uint256 bruto)
        private
        view
        returns (uint256 liquido, uint256 taxa, uint256 spread)
    {
        // Simula a reserva já com o depósito somado.
        return _calcEmissao(bruto, saldoNormalizado(token) + bruto, lastroTotal() + bruto);
    }

    function _cotarEmissaoPos(address token, uint256 bruto)
        private
        view
        returns (uint256 liquido, uint256 taxa, uint256 spread)
    {
        // O depósito já está no saldo.
        return _calcEmissao(bruto, saldoNormalizado(token), lastroTotal());
    }

    function _calcEmissao(uint256 bruto, uint256 saldoDepois, uint256 totalDepois)
        private
        view
        returns (uint256 liquido, uint256 taxa, uint256 spread)
    {
        taxa = (bruto * TAXA_BPS) / BPS;
        uint256 n = _listaLastros.length;
        // Fase 2 é avaliada pelo supply após a emissão.
        if (n > 1 && XBRL.totalSupply() + bruto >= LIMIAR_FASE_2) {
            uint256 participacao = (saldoDepois * BPS) / totalDepois;
            uint256 alvo = BPS / n;
            if (participacao >= FASE2_CONCENTRACAO_MAX_BPS) {
                spread = (bruto * FASE2_SPREAD_MAX_BPS) / BPS;
            } else if (participacao > alvo) {
                uint256 spreadBps =
                    ((participacao - alvo) * FASE2_SPREAD_MAX_BPS) / (FASE2_CONCENTRACAO_MAX_BPS - alvo);
                spread = (bruto * spreadBps) / BPS;
            }
        }
        liquido = bruto - taxa - spread;
    }

    function _spreadResgateBps(address token, uint256 bruto) private view returns (uint256) {
        uint256 n = _listaLastros.length;
        if (n < 2 || fase() == 1) return 0;
        uint256 total = lastroTotal();
        uint256 saldo = saldoNormalizado(token);
        if (total <= bruto || saldo <= bruto) return FASE2_SPREAD_MAX_BPS;
        uint256 participacaoDepois = ((saldo - bruto) * BPS) / (total - bruto);
        uint256 alvo = BPS / n;
        if (participacaoDepois >= alvo) return 0;
        return ((alvo - participacaoDepois) * FASE2_SPREAD_MAX_BPS) / alvo;
    }

    function _consumirJanela(uint256 bruto) private {
        if (fase() == 1) return;
        if (inicioJanela == 0 || block.timestamp >= uint256(inicioJanela) + JANELA) {
            inicioJanela = uint64(block.timestamp);
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
