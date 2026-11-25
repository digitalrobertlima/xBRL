// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CofreRendimento — poupança ERC-4626 em xBRL, rendimento só de receita real
/// @notice Quem deposita xBRL recebe cotas cxBRL. O rendimento NÃO é impresso: ele vem exclusivamente
/// de receita real depositada por qualquer pessoa/empresa via `depositarReceita` (ex.: faturamento de um
/// comércio parceiro). Essa receita é liberada aos poucos, com teto de 17% ao ano efetivo sobre o saldo do
/// cofre. O que passar do teto fica na fila e é liberado nos períodos seguintes. Sem receita, rendimento = 0.
///
/// - Sem dono, sem pausa, sem taxa de entrada/saída: saque a qualquer momento.
/// - Liberação linear por segundo impede "sanduíche" (depositar antes da receita e sair logo depois).
/// - Offset de 6 casas virtuais nas cotas mitiga o ataque de inflação do primeiro depositante.
contract CofreRendimento is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @notice Teto exibido ao usuário: 17% ao ano efetivo (com capitalização contínua).
    uint256 public constant TETO_APY_BPS = 1_700;
    /// @notice Taxa contínua equivalente: ln(1,17) = 0,15700 → 1.570 bps por ano.
    uint256 public constant TAXA_CONTINUA_MAX_BPS = 1_570;
    uint256 public constant ANO = 365 days;

    /// @notice Receita depositada ainda não liberada aos cotistas.
    uint256 public receitaPendente;
    /// @notice Último momento em que a liberação foi contabilizada.
    uint64 public ultimaLiberacao;
    /// @notice Total de receita real já recebida (histórico).
    uint256 public receitaTotalRecebida;

    event ReceitaDepositada(address indexed origem, uint256 valor, string referencia);
    event ReceitaLiberada(uint256 valor, uint256 pendenteRestante);

    error ValorZero();

    constructor(IERC20 xbrl) ERC20("Cofre xBRL", "cxBRL") ERC4626(xbrl) {
        ultimaLiberacao = uint64(block.timestamp);
    }

    // ------------------------------------------------------------------
    // Receita real
    // ------------------------------------------------------------------

    /// @notice Deposita receita real (em xBRL) para ser distribuída aos cotistas. Qualquer um pode chamar.
    /// @param referencia texto livre auditável (ex.: "Pastelândia — faturamento nov/2026").
    function depositarReceita(uint256 valor, string calldata referencia) external nonReentrant {
        if (valor == 0) revert ValorZero();
        _liberar();
        uint256 antes = IERC20(asset()).balanceOf(address(this));
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), valor);
        uint256 recebido = IERC20(asset()).balanceOf(address(this)) - antes;
        receitaPendente += recebido;
        receitaTotalRecebida += recebido;
        emit ReceitaDepositada(msg.sender, recebido, referencia);
    }

    /// @notice Contabiliza a liberação acumulada até agora (qualquer um pode chamar).
    function acumular() external {
        _liberar();
    }

    /// @notice Quanto da receita pendente já pode ser liberado neste instante.
    function liberavelAgora() public view returns (uint256) {
        uint256 pendente = receitaPendente;
        if (pendente == 0) return 0;
        uint256 base = IERC20(asset()).balanceOf(address(this)) - pendente;
        uint256 dt = block.timestamp - ultimaLiberacao;
        uint256 maximo = (base * TAXA_CONTINUA_MAX_BPS * dt) / (BPS * ANO);
        return maximo < pendente ? maximo : pendente;
    }

    /// @notice Taxa anual (bps, contínua) que o cofre está pagando agora com a receita em fila.
    /// Retorna 0 se não há receita; no máximo TAXA_CONTINUA_MAX_BPS.
    function taxaAtualBps() external view returns (uint256) {
        uint256 pendente = receitaPendente - liberavelAgora();
        uint256 base = totalAssets();
        if (pendente == 0 || base == 0) return 0;
        // Se a fila cobre ao menos 1 dia no teto, paga o teto; senão, proporcional.
        uint256 umDiaNoTeto = (base * TAXA_CONTINUA_MAX_BPS * 1 days) / (BPS * ANO);
        if (umDiaNoTeto == 0 || pendente >= umDiaNoTeto) return TAXA_CONTINUA_MAX_BPS;
        return (TAXA_CONTINUA_MAX_BPS * pendente) / umDiaNoTeto;
    }

    // ------------------------------------------------------------------
    // ERC-4626
    // ------------------------------------------------------------------

    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - (receitaPendente - liberavelAgora());
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        _liberar();
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        _liberar();
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _liberar() private {
        uint256 liberar = liberavelAgora();
        if (liberar != 0) {
            receitaPendente -= liberar;
            emit ReceitaLiberada(liberar, receitaPendente);
        }
        ultimaLiberacao = uint64(block.timestamp);
    }
}
