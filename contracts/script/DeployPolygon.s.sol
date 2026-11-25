// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {xBRL} from "../src/xBRL.sol";
import {ReservaBRL} from "../src/ReservaBRL.sol";
import {EscrowTrabalho} from "../src/EscrowTrabalho.sol";

/// @notice Stablecoin de Real SÓ PARA TESTNET (Amoy/local), com torneira pública.
contract BRLTeste is ERC20 {
    uint256 public constant TORNEIRA = 10_000e18;
    uint256 public constant INTERVALO = 1 hours;
    mapping(address => uint256) public ultimaTorneira;

    error AguardeTorneira(uint256 liberaEm);

    constructor() ERC20("BRL de Teste (Amoy)", "tBRL") {}

    function torneira() external {
        uint256 libera = ultimaTorneira[msg.sender] + INTERVALO;
        if (ultimaTorneira[msg.sender] != 0 && block.timestamp < libera) revert AguardeTorneira(libera);
        ultimaTorneira[msg.sender] = block.timestamp;
        _mint(msg.sender, TORNEIRA);
    }
}

/// @title DeployPolygon — implantação determinística (CREATE2) do ecossistema xBRL
/// @notice Uso (a chave NUNCA fica em arquivo — importe com `cast wallet import xbrl-deployer --interactive`):
///   forge script script/DeployPolygon.s.sol:DeployPolygon --rpc-url amoy    --account xbrl-deployer --broadcast --verify
///   forge script script/DeployPolygon.s.sol:DeployPolygon --rpc-url polygon --account xbrl-deployer --broadcast --verify
/// Mesmo deployer + mesmo SALT = mesmos endereços de xBRL e Escrow em qualquer rede.
/// O dono da Reserva é o CREATOR_TREASURY desde o construtor: a chave de deploy é descartável.
/// Reexecutar é seguro: contratos já existentes são reaproveitados e a inicialização só ocorre uma vez.
/// Ao final grava `wallet/src/deployments/<chainId>.json`, lido pela carteira e pela landing page.
contract DeployPolygon is Script {
    address public constant CREATOR_TREASURY = 0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1;
    bytes32 public constant SALT = keccak256("xBRL.soberano.v1");

    // Polygon PoS (137) — stablecoins de Real com 18 casas. Conferir no PolygonScan antes do deploy.
    address public constant BRZ_POLYGON = 0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc;
    address public constant BRLA_POLYGON = 0xE6A537a407488807F0bbeb0038B79004f19DDDFb;

    uint256 public constant POLYGON = 137;
    uint256 public constant AMOY = 80_002;

    struct Implantacao {
        address token;
        address reserva;
        address escrow;
        address[] lastros;
        address deployer;
        uint256 blocoInicial;
    }

    function run() external returns (Implantacao memory imp) {
        imp.blocoInicial = block.number;
        vm.startBroadcast();
        (, imp.deployer,) = vm.readCallers();

        imp.lastros = _lastros();
        imp.token = _criar(type(xBRL).creationCode, abi.encode(CREATOR_TREASURY, imp.deployer));
        imp.reserva = _criar(
            type(ReservaBRL).creationCode,
            abi.encode(imp.token, CREATOR_TREASURY, imp.lastros, CREATOR_TREASURY)
        );
        imp.escrow = _criar(type(EscrowTrabalho).creationCode, abi.encode(imp.token, CREATOR_TREASURY));

        if (!xBRL(imp.token).inicializado()) {
            address[] memory isentos = new address[](1);
            isentos[0] = imp.escrow;
            xBRL(imp.token).inicializar(imp.reserva, isentos);
        }
        vm.stopBroadcast();

        _validar(imp);
        _registrar(imp);
    }

    function _lastros() internal returns (address[] memory lista) {
        if (block.chainid == POLYGON) {
            lista = new address[](2);
            lista[0] = BRZ_POLYGON;
            lista[1] = BRLA_POLYGON;
        } else {
            // Amoy / rede local: stablecoin de teste com torneira.
            lista = new address[](1);
            lista[0] = _criar(type(BRLTeste).creationCode, "");
        }
    }

    /// @dev CREATE2 via fábrica determinística padrão (0x4e59…956C). Reaproveita se já existir.
    function _criar(bytes memory creationCode, bytes memory args) internal returns (address endereco) {
        bytes memory initCode = abi.encodePacked(creationCode, args);
        endereco = vm.computeCreate2Address(SALT, keccak256(initCode));
        if (endereco.code.length != 0) {
            console2.log("Reaproveitado:", endereco);
            return endereco;
        }
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(SALT, initCode));
        require(ok && endereco.code.length != 0, "CREATE2 falhou");
        console2.log("Implantado:", endereco);
    }

    function _validar(Implantacao memory imp) internal view {
        xBRL t = xBRL(imp.token);
        require(t.reserva() == imp.reserva, "reserva nao conectada");
        require(t.isentoDeTaxa(imp.escrow), "isencao ausente");
        require(t.CREATOR_TREASURY() == CREATOR_TREASURY, "treasury divergente");
        require(address(ReservaBRL(imp.reserva).XBRL()) == imp.token, "reserva com token errado");
        require(ReservaBRL(imp.reserva).owner() == CREATOR_TREASURY, "dono da reserva divergente");
        require(address(EscrowTrabalho(imp.escrow).XBRL()) == imp.token, "escrow com token errado");
    }

    function _registrar(Implantacao memory imp) internal {
        console2.log("chainId", block.chainid);
        console2.log("xBRL", imp.token);
        console2.log("ReservaBRL", imp.reserva);
        console2.log("EscrowTrabalho", imp.escrow);
        if (!vm.envOr("XBRL_GRAVAR_JSON", true)) return;

        string memory k = "implantacao";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "blocoInicial", imp.blocoInicial);
        vm.serializeAddress(k, "deployer", imp.deployer);
        vm.serializeAddress(k, "treasury", CREATOR_TREASURY);
        vm.serializeAddress(k, "xBRL", imp.token);
        vm.serializeAddress(k, "ReservaBRL", imp.reserva);
        vm.serializeAddress(k, "EscrowTrabalho", imp.escrow);
        string memory json = vm.serializeAddress(k, "lastros", imp.lastros);
        string memory caminho = string.concat(
            vm.projectRoot(), "/../wallet/src/deployments/", vm.toString(block.chainid), ".json"
        );
        vm.writeJson(json, caminho);
        console2.log("Gravado:", caminho);
    }
}
