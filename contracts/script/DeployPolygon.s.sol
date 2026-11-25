// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {xBRL} from "../src/xBRL.sol";
import {ReservaBRL} from "../src/ReservaBRL.sol";
import {EscrowTrabalho} from "../src/EscrowTrabalho.sol";
import {CofreCripto} from "../src/CofreCripto.sol";
import {Mensageiro} from "../src/Mensageiro.sol";

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

/// @notice Cripto de teste (tWETH/tWPOL) com torneira — SÓ testnet/local.
contract CriptoTeste is ERC20 {
    uint256 public immutable TORNEIRA;

    constructor(string memory nome, string memory simbolo, uint256 porTorneira) ERC20(nome, simbolo) {
        TORNEIRA = porTorneira;
    }

    function torneira() external {
        _mint(msg.sender, TORNEIRA);
    }
}

/// @notice Oráculo de teste no formato Chainlink, preço ajustável por qualquer um — SÓ testnet/local.
contract OraculoTeste {
    int256 public resposta;
    uint256 public atualizadoEm;
    uint80 public rodada;
    string public description;

    constructor(string memory desc, int256 inicial) {
        description = desc;
        definir(inicial);
    }

    function definir(int256 novo) public {
        resposta = novo;
        atualizadoEm = block.timestamp;
        ++rodada;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (rodada, resposta, atualizadoEm, atualizadoEm, rodada);
    }
}

interface IAgregadorLeitura {
    function description() external view returns (string memory);
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IFabricaV3 {
    function getPool(address a, address b, uint24 taxa) external view returns (address);
}

/// @title DeployPolygon — implantação determinística (CREATE2) do ecossistema xBRL
/// @notice Use o workflow "Deploy dos contratos (automático)" (chave descartável no runner).
/// Na Polygon (137) esta é a versão BETA: tetos baixos embutidos (reserva até 1.000 xBRL, dívida do cofre até
/// 500 xBRL por ativo). Todos os endereços externos (lastros, Chainlink, pools) são conferidos na própria rede
/// antes de implantar — qualquer divergência aborta sem gastar nada.
/// O dono da Reserva é o CREATOR_TREASURY desde o construtor: a chave de deploy é descartável.
contract DeployPolygon is Script {
    address public constant CREATOR_TREASURY = 0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1;
    bytes32 public constant SALT = keccak256("xBRL.soberano.beta2");

    // Polygon PoS (137) — stablecoins de Real (lastro 1:1, lista imutável)
    address public constant BRZ = 0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc;
    address public constant BRLA = 0xE6A537a407488807F0bbeb0038B79004f19DDDFb;
    address public constant BRL1 = 0x5C067C80C00eCd2345b05E83A3e758eF799C40B5;
    // Cripto do cofre e pools de conferência (Uniswap V3)
    address public constant WETH = 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619;
    address public constant WPOL = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    address public constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address public constant USDC_E = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address public constant FABRICA_V3 = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    // Chainlink (Polygon) — conferidos por descrição e faixa de preço antes do deploy
    address public constant FEED_ETH_USD = 0xF9680D99D6C9589e2a93a78A04A279e509205945;
    address public constant FEED_POL_USD = 0xAB594600376Ec9fD91F8e885dADF0CE036862dE0;
    address public constant FEED_BRL_USD = 0xB90DA3ff54C3ED09115abf6FbA0Ff4645586af2c;

    uint256 public constant POLYGON = 137;
    uint256 public constant TETO_RESERVA_BETA = 1_000e18;
    uint128 public constant TETO_DIVIDA_BETA = 500e18;

    struct Implantacao {
        address token;
        address reserva;
        address escrow;
        address cofre;
        address mensageiro;
        address[] lastros;
        address[] criptos;
        address deployer;
        uint256 blocoInicial;
        bool beta;
        bytes argsCofre; // argumentos do construtor do cofre (para verificação no Sourcify)
    }

    function run() external returns (Implantacao memory imp) {
        imp.blocoInicial = block.number;
        imp.beta = true;
        if (block.chainid == POLYGON) _conferirPolygon();
        vm.startBroadcast();
        (, imp.deployer,) = vm.readCallers();

        imp.token = _criar(type(xBRL).creationCode, abi.encode(imp.deployer));
        (CofreCripto.ConfigAtivo[] memory ativos, address feedBrl) = _ativosCofre();
        imp.criptos = new address[](ativos.length);
        for (uint256 i = 0; i < ativos.length; ++i) {
            imp.criptos[i] = ativos[i].token;
        }
        imp.argsCofre = abi.encode(imp.token, CREATOR_TREASURY, ativos, feedBrl, uint32(26 hours));
        imp.cofre = _criar(type(CofreCripto).creationCode, imp.argsCofre);
        imp.lastros = _lastros();
        imp.reserva = _criar(
            type(ReservaBRL).creationCode,
            abi.encode(
                imp.token, CREATOR_TREASURY, imp.cofre, imp.lastros, CREATOR_TREASURY, TETO_RESERVA_BETA
            )
        );
        imp.escrow =
            _criar(type(EscrowTrabalho).creationCode, abi.encode(imp.token, CREATOR_TREASURY, imp.cofre));
        imp.mensageiro = _criar(type(Mensageiro).creationCode, "");

        if (!xBRL(imp.token).inicializado()) xBRL(imp.token).inicializar(imp.reserva, imp.cofre);
        vm.stopBroadcast();

        _validar(imp);
        _registrar(imp);
    }

    // ------------------------------------------------------------------
    // Configuração por rede
    // ------------------------------------------------------------------

    function _lastros() internal returns (address[] memory lista) {
        if (block.chainid == POLYGON) {
            lista = new address[](3);
            lista[0] = BRZ;
            lista[1] = BRLA;
            lista[2] = BRL1;
        } else {
            lista = new address[](1);
            lista[0] = _criar(type(BRLTeste).creationCode, "");
        }
    }

    function _ativosCofre() internal returns (CofreCripto.ConfigAtivo[] memory a, address feedBrl) {
        a = new CofreCripto.ConfigAtivo[](2);
        if (block.chainid == POLYGON) {
            feedBrl = FEED_BRL_USD;
            a[0] = _config(WETH, FEED_ETH_USD, _melhorPool(WETH), 20_000, 15_000);
            a[1] = _config(WPOL, FEED_POL_USD, _melhorPool(WPOL), 25_000, 17_500);
        } else {
            // Testnet/local: cripto e oráculos de teste com preço ajustável (nunca na Polygon).
            address weth = _criar(type(CriptoTeste).creationCode, abi.encode("ETH de Teste", "tWETH", 1e18));
            address wpol =
                _criar(type(CriptoTeste).creationCode, abi.encode("POL de Teste", "tWPOL", 10_000e18));
            address fEth = _criar(type(OraculoTeste).creationCode, abi.encode("ETH / USD", int256(2_500e8)));
            address fPol = _criar(type(OraculoTeste).creationCode, abi.encode("POL / USD", int256(0.12e8)));
            feedBrl = _criar(type(OraculoTeste).creationCode, abi.encode("BRL / USD", int256(0.18e8)));
            a[0] = _config(weth, fEth, address(0), 20_000, 15_000);
            a[1] = _config(wpol, fPol, address(0), 25_000, 17_500);
        }
    }

    function _config(address token, address feed, address pool, uint16 crEmissao, uint16 crLiquidacao)
        internal
        view
        returns (CofreCripto.ConfigAtivo memory c)
    {
        c.token = token;
        c.feedUsd = feed;
        c.heartbeat = 2 hours;
        c.pool = pool;
        c.ativoEhToken0 = pool != address(0) && token < _outroDaPool(pool, token);
        c.decimaisPar = 6;
        c.crEmissaoBps = crEmissao;
        c.crLiquidacaoBps = crLiquidacao;
        c.tetoDivida = TETO_DIVIDA_BETA;
    }

    /// @dev Pool Uniswap V3 ativo/USDC (nativo ou USDC.e, taxa 0,05% ou 0,3%) com mais saldo do ativo.
    function _melhorPool(address token) internal view returns (address melhor) {
        address[2] memory usdcs = [USDC, USDC_E];
        uint24[2] memory taxas = [uint24(500), uint24(3000)];
        uint256 maior;
        for (uint256 u = 0; u < 2; ++u) {
            for (uint256 f = 0; f < 2; ++f) {
                address p = IFabricaV3(FABRICA_V3).getPool(token, usdcs[u], taxas[f]);
                if (p == address(0) || !_temHistorico(p)) continue;
                uint256 saldo = IERC20(token).balanceOf(p);
                if (saldo > maior) {
                    maior = saldo;
                    melhor = p;
                }
            }
        }
        console2.log("Pool de conferencia", melhor);
    }

    /// @dev Só usa pools com histórico de 30 min (cardinalidade suficiente); senão o TWAP travaria a emissão.
    function _temHistorico(address pool) internal view returns (bool) {
        uint32[] memory janela = new uint32[](2);
        janela[0] = 1800;
        (bool ok,) = pool.staticcall(abi.encodeWithSignature("observe(uint32[])", janela));
        return ok;
    }

    function _outroDaPool(address pool, address token) internal view returns (address) {
        (bool ok0, bytes memory r0) = pool.staticcall(abi.encodeWithSignature("token0()"));
        (bool ok1, bytes memory r1) = pool.staticcall(abi.encodeWithSignature("token1()"));
        require(ok0 && ok1, "pool sem token0/token1");
        address t0 = abi.decode(r0, (address));
        address t1 = abi.decode(r1, (address));
        require(t0 == token || t1 == token, "pool nao tem o ativo");
        return t0 == token ? t1 : t0;
    }

    /// @dev Confere na própria Polygon que cada endereço é o que esperamos. Qualquer falha aborta o deploy.
    function _conferirPolygon() internal view {
        _conferirFeed(FEED_ETH_USD, "ETH / USD", "", 500e8, 20_000e8);
        _conferirFeed(FEED_POL_USD, "POL / USD", "MATIC / USD", 0.01e8, 10e8);
        _conferirFeed(FEED_BRL_USD, "BRL / USD", "", 0.08e8, 0.5e8);
        require(ERC20(WETH).decimals() == 18 && ERC20(WPOL).decimals() == 18, "cripto com casas inesperadas");
        address[3] memory l = [BRZ, BRLA, BRL1];
        for (uint256 i = 0; i < 3; ++i) {
            require(l[i].code.length != 0, "lastro sem codigo");
            require(ERC20(l[i]).decimals() <= 18, "lastro com casas invalidas");
            console2.log("Lastro", ERC20(l[i]).symbol(), ERC20(l[i]).decimals());
        }
    }

    function _conferirFeed(address feed, string memory desc, string memory alt, int256 minimo, int256 maximo)
        internal
        view
    {
        IAgregadorLeitura f = IAgregadorLeitura(feed);
        bytes32 d = keccak256(bytes(f.description()));
        require(
            d == keccak256(bytes(desc)) || (bytes(alt).length != 0 && d == keccak256(bytes(alt))),
            "feed errado"
        );
        require(f.decimals() == 8, "feed com casas inesperadas");
        (, int256 resposta,, uint256 atualizado,) = f.latestRoundData();
        require(resposta >= minimo && resposta <= maximo, "preco fora da faixa");
        require(block.timestamp - atualizado < 2 days, "feed parado");
        console2.log(f.description(), resposta);
    }

    // ------------------------------------------------------------------
    // CREATE2, validação e registro
    // ------------------------------------------------------------------

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
        require(t.reserva() == imp.reserva && t.cofre() == imp.cofre, "emissores nao conectados");
        require(ReservaBRL(imp.reserva).CREATOR_TREASURY() == CREATOR_TREASURY, "treasury divergente");
        require(ReservaBRL(imp.reserva).COLCHAO() == imp.cofre, "colchao divergente");
        require(ReservaBRL(imp.reserva).owner() == CREATOR_TREASURY, "dono da reserva divergente");
        require(EscrowTrabalho(imp.escrow).COLCHAO() == imp.cofre, "colchao do escrow divergente");
        require(address(CofreCripto(imp.cofre).XBRL()) == imp.token, "cofre com token errado");
        require(address(EscrowTrabalho(imp.escrow).XBRL()) == imp.token, "escrow com token errado");
        // O cofre precisa nascer com preço utilizável para emitir (Chainlink + TWAP quando houver pool).
        for (uint256 i = 0; i < CofreCripto(imp.cofre).totalAtivos(); ++i) {
            (uint256 preco, bool ok) = CofreCripto(imp.cofre).precoParaEmitir(i);
            require(ok, "cofre sem preco para emitir");
            console2.log("Preco inicial (R$ 1e18) do ativo", i, preco);
        }
    }

    function _registrar(Implantacao memory imp) internal {
        console2.log("chainId", block.chainid);
        console2.log("xBRL", imp.token);
        console2.log("ReservaBRL", imp.reserva);
        console2.log("EscrowTrabalho", imp.escrow);
        console2.log("CofreCripto", imp.cofre);
        console2.log("Mensageiro", imp.mensageiro);
        if (!vm.envOr("XBRL_GRAVAR_JSON", true)) return;

        string memory k = "implantacao";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "blocoInicial", imp.blocoInicial);
        vm.serializeBool(k, "beta", imp.beta);
        vm.serializeAddress(k, "deployer", imp.deployer);
        vm.serializeAddress(k, "treasury", CREATOR_TREASURY);
        vm.serializeAddress(k, "xBRL", imp.token);
        vm.serializeAddress(k, "ReservaBRL", imp.reserva);
        vm.serializeAddress(k, "EscrowTrabalho", imp.escrow);
        vm.serializeAddress(k, "CofreCripto", imp.cofre);
        vm.serializeAddress(k, "Mensageiro", imp.mensageiro);
        vm.serializeAddress(k, "criptos", imp.criptos);
        vm.serializeBytes(k, "argsCofre", imp.argsCofre);
        string memory json = vm.serializeAddress(k, "lastros", imp.lastros);
        string memory caminho = string.concat(
            vm.projectRoot(), "/../wallet/src/deployments/", vm.toString(block.chainid), ".json"
        );
        vm.writeJson(json, caminho);
        console2.log("Gravado:", caminho);
    }
}
