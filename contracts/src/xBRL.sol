// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title xBRL — O Real Soberano & Inconfiscável (Polygon PoS)
/// @notice ERC-20 padrão, 18 casas, pareado 1:1 ao Real via ReservaBRL. 100% compatível com Uniswap e DeFi:
/// NÃO há taxa na transferência (as taxas de 0,1% ficam só na emissão/resgate da Reserva e nos pagamentos
/// do Escrow).
///
/// Invariantes de soberania (não há como mudar depois do deploy):
///  - Sem blacklist, sem congelamento, sem pausa, sem `burnFrom` administrativo, sem proxy/upgrade.
///  - Só a ReservaBRL pode emitir (mint). Queimar (burn) só o próprio saldo de quem chama.
///  - A Reserva é gravada uma única vez em `inicializar`; depois disso o token não tem nenhum administrador.
contract xBRL is ERC20, ERC20Permit {
    /// @notice EIP-712: transferência paga em xBRL ao relayer (quem não tem POL consegue transacionar).
    /// `relayer == address(0)` permite qualquer relayer.
    bytes32 public constant TRANSFER_WITH_GAS_TYPEHASH = keccak256(
        "TransferWithGas(address from,address to,uint256 value,address relayer,uint256 gasFee,uint256 nonce,uint256 deadline)"
    );

    /// @notice Pedido de transferência paga em xBRL ao relayer.
    struct PedidoComGas {
        address de;
        address para;
        uint256 valor;
        address relayer;
        uint256 taxaGas;
        uint256 deadline;
    }

    /// @notice Única emissora de xBRL (definida uma vez em `inicializar`).
    address public reserva;

    address private _inicializador;

    event Inicializado(address indexed reserva);
    event TransferenciaComGas(
        address indexed de, address indexed para, address indexed relayer, uint256 valor, uint256 taxaGas
    );

    error EnderecoZero();
    error NaoAutorizado();
    error AssinaturaExpirada(uint256 deadline);
    error AssinaturaInvalida();
    error RelayerNaoAutorizado(address esperado, address recebido);

    constructor(address inicializador) ERC20("xBRL Real Soberano", "xBRL") ERC20Permit("xBRL Real Soberano") {
        if (inicializador == address(0)) revert EnderecoZero();
        _inicializador = inicializador;
    }

    /// @notice Conecta a Reserva. Só pode ser chamada UMA vez, apenas pelo inicializador definido no construtor.
    function inicializar(address reserva_) external {
        if (msg.sender != _inicializador) revert NaoAutorizado();
        if (reserva_ == address(0)) revert EnderecoZero();
        // O evento Inicializado (abaixo) registra o fim do papel de inicializador.
        // forge-lint: disable-next-line(missing-events-access-control)
        _inicializador = address(0);
        reserva = reserva_;
        emit Inicializado(reserva_);
    }

    /// @notice `true` depois que `inicializar` foi executada (token 100% sem administração).
    function inicializado() external view returns (bool) {
        return reserva != address(0);
    }

    /// @notice Emite xBRL. Somente a ReservaBRL (que recebeu o lastro antes).
    function mint(address para, uint256 valor) external {
        if (msg.sender != reserva) revert NaoAutorizado();
        _mint(para, valor);
    }

    /// @notice Queima xBRL do PRÓPRIO saldo. Ninguém pode queimar o saldo de outra pessoa.
    function burn(uint256 valor) external {
        _burn(msg.sender, valor);
    }

    /// @notice Executa uma transferência assinada por `p.de` (EIP-712). Quem submete (relayer) paga o gás em POL
    /// e recebe `p.taxaGas` em xBRL de `p.de`. O nonce é o mesmo do `permit` (anti-replay único).
    /// `assinatura` = 65 bytes (r, s, v) ou 64 bytes (EIP-2098).
    function transferWithGas(PedidoComGas calldata p, bytes calldata assinatura) external returns (bool) {
        if (block.timestamp > p.deadline) revert AssinaturaExpirada(p.deadline);
        if (p.relayer != address(0) && p.relayer != msg.sender) {
            revert RelayerNaoAutorizado(p.relayer, msg.sender);
        }

        bytes32 digest = _digestTransferWithGas(p, _useNonce(p.de));
        if (ECDSA.recover(digest, assinatura) != p.de) revert AssinaturaInvalida();

        _transfer(p.de, p.para, p.valor);
        if (p.taxaGas != 0) _transfer(p.de, msg.sender, p.taxaGas);
        emit TransferenciaComGas(p.de, p.para, msg.sender, p.valor, p.taxaGas);
        return true;
    }

    /// @notice Digest EIP-712 que `p.de` precisa assinar para `transferWithGas` com o `nonce` dado.
    function hashTransferWithGas(PedidoComGas calldata p, uint256 nonce) external view returns (bytes32) {
        return _digestTransferWithGas(p, nonce);
    }

    function _digestTransferWithGas(PedidoComGas calldata p, uint256 nonce) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRANSFER_WITH_GAS_TYPEHASH, p.de, p.para, p.valor, p.relayer, p.taxaGas, nonce, p.deadline
                )
            )
        );
    }
}
