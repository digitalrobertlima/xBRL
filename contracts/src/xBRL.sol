// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title xBRL — O Real Soberano & Inconfiscável (Polygon PoS)
/// @notice ERC-20 com 18 casas, pareado 1:1 ao Real via ReservaBRL.
///
/// Invariantes de soberania (não há como mudar depois do deploy):
///  - Sem blacklist, sem congelamento, sem pausa, sem `burnFrom` administrativo, sem proxy/upgrade.
///  - Só a ReservaBRL pode emitir (mint). Queimar (burn) só o próprio saldo de quem chama.
///  - Taxa vitalícia de 0,1% (10 bps) em transferências entre carteiras comuns, enviada ao CREATOR_TREASURY.
///    Contratos do protocolo (Reserva, Cofre, Escrow) e o próprio Treasury são isentos, para não quebrar
///    a contabilidade deles; Reserva e Escrow cobram a mesma taxa de 0,1% explicitamente.
///  - A lista de isentos é gravada uma única vez em `inicializar` e fica imutável para sempre.
contract xBRL is ERC20, ERC20Permit {
    /// @notice Carteira que recebe a taxa vitalícia de 0,1%.
    address public immutable CREATOR_TREASURY;

    /// @notice Taxa em pontos-base (10 = 0,1%).
    uint256 public constant TAXA_BPS = 10;
    uint256 public constant BPS = 10_000;

    /// @notice EIP-712: transferência paga em xBRL ao relayer (quem não tem POL consegue transacionar).
    /// `relayer == address(0)` permite qualquer relayer.
    bytes32 public constant TRANSFER_WITH_GAS_TYPEHASH = keccak256(
        "TransferWithGas(address from,address to,uint256 value,address relayer,uint256 gasFee,uint256 nonce,uint256 deadline)"
    );

    /// @notice Única emissora de xBRL (definida uma vez em `inicializar`).
    address public reserva;

    /// @notice Pedido de transferência paga em xBRL ao relayer.
    struct PedidoComGas {
        address de;
        address para;
        uint256 valor;
        address relayer;
        uint256 taxaGas;
        uint256 deadline;
    }

    /// @notice Endereços isentos da taxa de transferência (definidos uma única vez).
    mapping(address => bool) public isentoDeTaxa;

    address private _inicializador;

    event Inicializado(address indexed reserva);
    event IsencaoRegistrada(address indexed conta);
    event TaxaCobrada(address indexed de, uint256 taxa);
    event TransferenciaComGas(
        address indexed de, address indexed para, address indexed relayer, uint256 valor, uint256 taxaGas
    );

    error EnderecoZero();
    error NaoAutorizado();
    error AssinaturaExpirada(uint256 deadline);
    error AssinaturaInvalida();
    error RelayerNaoAutorizado(address esperado, address recebido);

    constructor(address treasury, address inicializador)
        ERC20("xBRL Real Soberano", "xBRL")
        ERC20Permit("xBRL Real Soberano")
    {
        if (treasury == address(0) || inicializador == address(0)) {
            revert EnderecoZero();
        }
        CREATOR_TREASURY = treasury;
        _inicializador = inicializador;
        isentoDeTaxa[treasury] = true;
        emit IsencaoRegistrada(treasury);
    }

    // ------------------------------------------------------------------
    // Inicialização única
    // ------------------------------------------------------------------

    /// @notice Conecta a Reserva e registra os contratos isentos. Só pode ser chamada UMA vez,
    /// apenas pelo inicializador definido no construtor. Depois disso o token fica sem nenhum papel administrativo.
    function inicializar(address reserva_, address[] calldata isentos) external {
        if (msg.sender != _inicializador) revert NaoAutorizado();
        if (reserva_ == address(0)) revert EnderecoZero();
        _inicializador = address(0);
        reserva = reserva_;
        isentoDeTaxa[reserva_] = true;
        emit IsencaoRegistrada(reserva_);
        for (uint256 i = 0; i < isentos.length; ++i) {
            if (isentos[i] == address(0)) revert EnderecoZero();
            isentoDeTaxa[isentos[i]] = true;
            emit IsencaoRegistrada(isentos[i]);
        }
        emit Inicializado(reserva_);
    }

    /// @notice `true` depois que `inicializar` foi executada (token 100% sem administração).
    function inicializado() external view returns (bool) {
        return reserva != address(0);
    }

    // ------------------------------------------------------------------
    // Emissão e queima
    // ------------------------------------------------------------------

    /// @notice Emite xBRL. Somente a ReservaBRL (que recebeu o lastro antes).
    function mint(address para, uint256 valor) external {
        if (msg.sender != reserva) revert NaoAutorizado();
        _mint(para, valor);
    }

    /// @notice Queima xBRL do PRÓPRIO saldo. Ninguém pode queimar o saldo de outra pessoa.
    function burn(uint256 valor) external {
        _burn(msg.sender, valor);
    }

    // ------------------------------------------------------------------
    // Taxa vitalícia
    // ------------------------------------------------------------------

    /// @notice Simula quanto chega ao destino numa transferência de `valor` de `de` para `para`.
    function previewTransferencia(address de, address para, uint256 valor)
        public
        view
        returns (uint256 liquido, uint256 taxa)
    {
        if (isentoDeTaxa[de] || isentoDeTaxa[para]) return (valor, 0);
        taxa = (valor * TAXA_BPS) / BPS;
        liquido = valor - taxa;
    }

    function _update(address de, address para, uint256 valor) internal override {
        if (de == address(0) || para == address(0)) {
            super._update(de, para, valor);
            return;
        }
        (uint256 liquido, uint256 taxa) = previewTransferencia(de, para, valor);
        if (taxa != 0) {
            super._update(de, CREATOR_TREASURY, taxa);
            emit TaxaCobrada(de, taxa);
        }
        super._update(de, para, liquido);
    }

    // ------------------------------------------------------------------
    // transferWithGas — transação sem POL, paga em xBRL ao relayer
    // ------------------------------------------------------------------

    /// @notice Executa uma transferência assinada por `de` (EIP-712). Quem submete (relayer) paga o gás em POL
    /// e recebe `taxaGas` em xBRL de `de`. O nonce é o mesmo do `permit` (anti-replay único).
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
