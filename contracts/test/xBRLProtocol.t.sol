// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {xBRL} from "../src/xBRL.sol";
import {ReservaBRL} from "../src/ReservaBRL.sol";
import {EscrowTrabalho} from "../src/EscrowTrabalho.sol";
import {CofreCripto} from "../src/CofreCripto.sol";
import {Mensageiro} from "../src/Mensageiro.sol";
import {DeployPolygon, OraculoTeste} from "../script/DeployPolygon.s.sol";

// =====================================================================
// Mocks
// =====================================================================

contract MockBRL is ERC20 {
    uint8 private immutable DEC;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        DEC = d;
    }

    function decimals() public view override returns (uint8) {
        return DEC;
    }

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

/// @dev Stablecoin que cobra 1% em toda transferência (testa medição pelo saldo).
contract MockTaxado is ERC20 {
    constructor() ERC20("Taxado", "TAX") {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }

    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 t = v / 100;
            super._update(from, address(0xdead), t);
            super._update(from, to, v - t);
        } else {
            super._update(from, to, v);
        }
    }
}

contract MockFeed {
    int256 public resposta;
    uint256 public atualizado;
    uint8 public immutable decimals;
    bool public quebrado;

    constructor(int256 r, uint8 d) {
        decimals = d;
        definir(r);
    }

    function definir(int256 r) public {
        resposta = r;
        atualizado = block.timestamp;
    }

    function quebrar(bool q) external {
        quebrado = q;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!quebrado, "feed fora do ar");
        return (1, resposta, atualizado, atualizado, 1);
    }
}

/// @dev Pool Uniswap V3 falsa: TWAP constante no tick configurado.
contract MockPool {
    int56 public tick;
    bool public semHistorico;

    constructor(int56 t) {
        tick = t;
    }

    function definir(int56 t) external {
        tick = t;
    }

    function semDados(bool s) external {
        semHistorico = s;
    }

    function observe(uint32[] calldata segundos)
        external
        view
        returns (int56[] memory c, uint160[] memory l)
    {
        require(!semHistorico, "OLD");
        c = new int56[](2);
        l = new uint160[](2);
        c[0] = 0;
        c[1] = tick * int56(uint56(segundos[0]));
    }
}

// =====================================================================
// Base: sistema inteiro
// =====================================================================

abstract contract Base is Test {
    address internal constant TREASURY = 0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1;
    int56 internal constant TICK_ETH_2500 = -198_080;

    xBRL internal token;
    ReservaBRL internal reserva;
    EscrowTrabalho internal escrow;
    CofreCripto internal cofre;
    MockBRL internal brz; // 18 casas
    MockBRL internal brla; // 6 casas (testa normalização)
    MockBRL internal weth;
    MockBRL internal wpol;
    MockFeed internal feedEth;
    MockFeed internal feedPol;
    MockFeed internal feedBrl;
    MockPool internal poolEth;

    address internal alice;
    uint256 internal alicePk;
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal relayer = makeAddr("relayer");
    address internal dono = makeAddr("dono");

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        (alice, alicePk) = makeAddrAndKey("alice");
        brz = new MockBRL("BRZ", "BRZ", 18);
        brla = new MockBRL("BRLA", "BRLA", 6);
        weth = new MockBRL("WETH", "WETH", 18);
        wpol = new MockBRL("WPOL", "WPOL", 18);
        feedEth = new MockFeed(2_500e8, 8);
        feedPol = new MockFeed(0.12e8, 8);
        feedBrl = new MockFeed(0.2e8, 8); // 1 BRL = 0,20 USD → ETH = R$ 12.500
        poolEth = new MockPool(TICK_ETH_2500);

        token = new xBRL(address(this));
        cofre = _novoCofre(1_000_000e18);
        address[] memory lastros = new address[](2);
        lastros[0] = address(brz);
        lastros[1] = address(brla);
        reserva = new ReservaBRL(address(token), TREASURY, address(cofre), lastros, dono, 0);
        escrow = new EscrowTrabalho(address(token), TREASURY, address(cofre));
        token.inicializar(address(reserva), address(cofre));
    }

    function _comPool() internal view virtual returns (bool) {
        return true;
    }

    function _novoCofre(uint128 teto) internal returns (CofreCripto) {
        CofreCripto.ConfigAtivo[] memory a = new CofreCripto.ConfigAtivo[](2);
        a[0] = CofreCripto.ConfigAtivo({
            token: address(weth),
            feedUsd: address(feedEth),
            heartbeat: 2 hours,
            pool: _comPool() ? address(poolEth) : address(0),
            ativoEhToken0: true,
            decimaisPar: 6,
            crEmissaoBps: 20_000,
            crLiquidacaoBps: 15_000,
            tetoDivida: teto
        });
        a[1] = CofreCripto.ConfigAtivo({
            token: address(wpol),
            feedUsd: address(feedPol),
            heartbeat: 2 hours,
            pool: address(0),
            ativoEhToken0: false,
            decimaisPar: 6,
            crEmissaoBps: 25_000,
            crLiquidacaoBps: 17_500,
            tetoDivida: teto
        });
        return new CofreCripto(address(token), TREASURY, a, address(feedBrl), 26 hours);
    }

    function _emitirBrz(address quem, uint256 valor18) internal returns (uint256 liquido) {
        brz.mint(quem, valor18);
        vm.startPrank(quem);
        brz.approve(address(reserva), valor18);
        liquido = reserva.emitir(address(brz), valor18, 0);
        vm.stopPrank();
    }

    function _emitirBrla(address quem, uint256 valor6) internal returns (uint256 liquido) {
        brla.mint(quem, valor6);
        vm.startPrank(quem);
        brla.approve(address(reserva), valor6);
        liquido = reserva.emitir(address(brla), valor6, 0);
        vm.stopPrank();
    }

    function _crescerAte(address quem, uint256 supplyAlvo) internal {
        while (token.totalSupply() < supplyAlvo) {
            uint256 falta = supplyAlvo - token.totalSupply();
            uint256 metade = falta / 2 + 1e18;
            uint256 dz = reserva.emissaoDisponivelNaJanela(address(brz));
            uint256 dl = reserva.emissaoDisponivelNaJanela(address(brla));
            uint256 vz = metade < dz ? metade : dz;
            uint256 vl = metade < dl ? metade : dl;
            if (vz > 1e18) _emitirBrz(quem, vz);
            if (vl > 1e18) _emitirBrla(quem, vl / 1e12);
            vm.warp(block.timestamp + 1 days);
            feedEth.definir(feedEth.resposta());
            feedPol.definir(feedPol.resposta());
            feedBrl.definir(feedBrl.resposta());
        }
    }

    /// @dev Deposita `qtd` WETH e emite `valor` xBRL para `quem`.
    function _abrirEth(address quem, uint256 qtd, uint256 valor) internal {
        weth.mint(quem, qtd);
        vm.startPrank(quem);
        weth.approve(address(cofre), qtd);
        cofre.depositar(0, qtd);
        if (valor != 0) cofre.emitir(0, valor);
        vm.stopPrank();
    }

    /// @dev Move o preço do ETH na Chainlink e no TWAP juntos.
    function _precoEth(int256 usd8, int56 tick) internal {
        feedEth.definir(usd8);
        poolEth.definir(tick);
    }

    /// @dev Invariante global: todo xBRL existe porque há stablecoin na reserva ou dívida no cofre.
    /// (A dívida ruim, se houver, fica pública e entra na conta para não esconder nada.)
    function _sistemaCoberto() internal view {
        assertGe(
            reserva.lastroTotal() + cofre.dividaTotalGlobal() + cofre.dividaRuim(),
            token.totalSupply(),
            "INVARIANTE: xBRL sem lastro"
        );
    }
}

// =====================================================================
// Token xBRL
// =====================================================================

contract XBRLTokenTest is Base {
    function test_Metadados() public view {
        assertEq(token.name(), "xBRL Real Soberano");
        assertEq(token.symbol(), "xBRL");
        assertEq(token.decimals(), 18);
        assertEq(token.reserva(), address(reserva));
        assertEq(token.cofre(), address(cofre));
        assertTrue(token.inicializado());
    }

    function test_InicializarSoUmaVez() public {
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        token.inicializar(address(0xBEEF), address(0xCAFE));
    }

    function test_InicializarValida() public {
        xBRL t = new xBRL(carol);
        vm.prank(bob);
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        t.inicializar(address(1), address(2));
        vm.startPrank(carol);
        vm.expectRevert(xBRL.EnderecoZero.selector);
        t.inicializar(address(0), address(2));
        vm.expectRevert(xBRL.EnderecoZero.selector);
        t.inicializar(address(1), address(1));
        vm.stopPrank();
        vm.expectRevert(xBRL.EnderecoZero.selector);
        new xBRL(address(0));
    }

    function test_SoEmissoresEmitem() public {
        vm.prank(alice);
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        token.mint(alice, 1e18);
        vm.prank(address(reserva));
        token.mint(alice, 1e18);
        vm.prank(address(cofre));
        token.mint(alice, 1e18);
        assertEq(token.balanceOf(alice), 2e18);
    }

    function testFuzz_TransferenciaSemTaxa(uint96 valor) public {
        _emitirBrz(alice, 5_000e18);
        uint256 v = bound(uint256(valor), 0, token.balanceOf(alice));
        vm.prank(alice);
        assertTrue(token.transfer(bob, v));
        assertEq(token.balanceOf(bob), v);
    }

    function test_BurnSoDoProprioSaldo() public {
        _emitirBrz(alice, 100e18);
        uint256 supply = token.totalSupply();
        vm.prank(alice);
        token.burn(10e18);
        assertEq(token.totalSupply(), supply - 10e18);
        vm.prank(bob);
        vm.expectRevert();
        token.burn(1);
    }

    function _assinar(xBRL.PedidoComGas memory p, uint256 pk, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, token.hashTransferWithGas(p, nonce));
        return abi.encodePacked(r, s, v);
    }

    function test_TransferWithGas() public {
        _emitirBrz(alice, 1_000e18);
        xBRL.PedidoComGas memory p = xBRL.PedidoComGas({
            de: alice,
            para: bob,
            valor: 100e18,
            relayer: relayer,
            taxaGas: 1e18,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _assinar(p, alicePk, 0);
        vm.prank(relayer);
        token.transferWithGas(p, sig);
        assertEq(token.balanceOf(bob), 100e18);
        assertEq(token.balanceOf(relayer), 1e18);
        vm.prank(relayer);
        vm.expectRevert(xBRL.AssinaturaInvalida.selector);
        token.transferWithGas(p, sig);
    }

    function test_TransferWithGasProtecoes() public {
        _emitirBrz(alice, 1_000e18);
        xBRL.PedidoComGas memory p = xBRL.PedidoComGas({
            de: alice, para: bob, valor: 10e18, relayer: relayer, taxaGas: 0, deadline: block.timestamp + 60
        });
        bytes memory sig = _assinar(p, alicePk, 0);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(xBRL.RelayerNaoAutorizado.selector, relayer, carol));
        token.transferWithGas(p, sig);
        (, uint256 outroPk) = makeAddrAndKey("intruso");
        bytes memory falsa = _assinar(p, outroPk, 0);
        vm.prank(relayer);
        vm.expectRevert(xBRL.AssinaturaInvalida.selector);
        token.transferWithGas(p, falsa);
        vm.warp(block.timestamp + 61);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(xBRL.AssinaturaExpirada.selector, p.deadline));
        token.transferWithGas(p, sig);
    }

    function test_Permit() public {
        _emitirBrz(alice, 100e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                alice,
                bob,
                5e18,
                token.nonces(alice),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);
        token.permit(alice, bob, 5e18, deadline, v, r, s);
        assertEq(token.allowance(alice, bob), 5e18);
    }
}

// =====================================================================
// ReservaBRL
// =====================================================================

contract ReservaBRLTest is Base {
    function test_EmitirComTaxaDivididaComOColchao() public {
        assertEq(_emitirBrz(alice, 1_000e18), 999e18);
        assertEq(token.balanceOf(TREASURY), 0.5e18);
        assertEq(cofre.colchao(), 0.5e18);
        assertEq(token.totalSupply(), 1_000e18);
        assertEq(reserva.colateralizacaoBps(), 10_000);
        _sistemaCoberto();
    }

    function test_ResgatarComTaxaDividida() public {
        _emitirBrz(alice, 1_000e18);
        vm.startPrank(alice);
        token.approve(address(reserva), 500e18);
        assertEq(reserva.resgatar(address(brz), 500e18, 499.5e18), 499.5e18);
        vm.stopPrank();
        assertEq(token.balanceOf(TREASURY), 0.75e18);
        assertEq(cofre.colchao(), 0.75e18);
        _sistemaCoberto();
    }

    function test_EmitirSeisCasasEArredondamento() public {
        assertEq(_emitirBrla(alice, 1_000e6), 999e18);
        vm.startPrank(alice);
        token.approve(address(reserva), type(uint256).max);
        assertEq(reserva.resgatar(address(brla), 1e18 + 123, 0), 999_000);
        vm.expectRevert(ReservaBRL.ValorZero.selector);
        reserva.resgatar(address(brla), 1e9, 0);
        vm.stopPrank();
        _sistemaCoberto();
    }

    function test_ProtecoesBasicas() public {
        _emitirBrz(alice, 1_000e18);
        vm.startPrank(alice);
        token.approve(address(reserva), 100e18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroInsuficiente.selector, 0, 99_900_000));
        reserva.resgatar(address(brla), 100e18, 0);
        vm.stopPrank();
        brz.mint(bob, 100e18);
        vm.startPrank(bob);
        brz.approve(address(reserva), 100e18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.SaidaMinimaNaoAtingida.selector, 99.9e18, 100e18));
        reserva.emitir(address(brz), 100e18, 100e18);
        vm.stopPrank();
        MockBRL x = new MockBRL("X", "X", 18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroDesconhecido.selector, address(x)));
        reserva.emitir(address(x), 1e18, 0);
        vm.expectRevert(ReservaBRL.ValorZero.selector);
        reserva.emitir(address(brz), 0, 0);
    }

    function test_PausaSoDoDonoESoDaEmissao() public {
        _emitirBrz(alice, 1_000e18);
        vm.prank(bob);
        vm.expectRevert();
        reserva.definirEmissaoAtiva(address(brz), false);
        vm.prank(dono);
        reserva.definirEmissaoAtiva(address(brz), false);
        brz.mint(bob, 10e18);
        vm.startPrank(bob);
        brz.approve(address(reserva), 10e18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.EmissaoPausada.selector, address(brz)));
        reserva.emitir(address(brz), 10e18, 0);
        vm.stopPrank();
        vm.startPrank(alice);
        token.approve(address(reserva), 999e18);
        reserva.resgatar(address(brz), 999e18, 0); // resgate nunca pausa
        vm.stopPrank();
    }

    function test_ListaDeLastrosImutavel() public {
        vm.startPrank(dono);
        (bool ok1,) = address(reserva).call(abi.encodeWithSignature("proporLastro(address)", address(1)));
        (bool ok2,) = address(reserva).call(abi.encodeWithSignature("ativarLastro(address)", address(1)));
        vm.stopPrank();
        assertFalse(ok1 || ok2);
        assertEq(reserva.listaLastros().length, 2);
    }

    function test_ConstrutorValida() public {
        address[] memory vazio = new address[](0);
        vm.expectRevert(ReservaBRL.QuantidadeDeLastrosInvalida.selector);
        new ReservaBRL(address(token), TREASURY, address(cofre), vazio, dono, 0);
        address[] memory dup = new address[](2);
        dup[0] = address(brz);
        dup[1] = address(brz);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroJaExiste.selector, address(brz)));
        new ReservaBRL(address(token), TREASURY, address(cofre), dup, dono, 0);
        address[] memory um = new address[](1);
        um[0] = address(brz);
        vm.expectRevert(ReservaBRL.EnderecoZero.selector);
        new ReservaBRL(address(token), TREASURY, address(0), um, dono, 0);
        um[0] = address(new MockBRL("R", "R", 24));
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.DecimaisInvalidos.selector, 24));
        new ReservaBRL(address(token), TREASURY, address(cofre), um, dono, 0);
    }

    function test_TetoBetaDaReserva() public {
        xBRL t2 = new xBRL(address(this));
        address[] memory l = new address[](1);
        l[0] = address(brz);
        ReservaBRL r2 = new ReservaBRL(address(t2), TREASURY, address(cofre), l, dono, 1_000e18);
        t2.inicializar(address(r2), address(0xC0F));
        brz.mint(alice, 2_000e18);
        vm.startPrank(alice);
        brz.approve(address(r2), 2_000e18);
        r2.emitir(address(brz), 1_000e18, 0);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.TetoDaReservaAtingido.selector, 1_000e18));
        r2.emitir(address(brz), 1e18, 0);
        vm.stopPrank();
    }

    function test_LastroComTaxaNaTransferencia() public {
        MockTaxado tax = new MockTaxado();
        address[] memory l = new address[](1);
        l[0] = address(tax);
        xBRL t2 = new xBRL(address(this));
        ReservaBRL r2 = new ReservaBRL(address(t2), TREASURY, address(cofre), l, dono, 0);
        t2.inicializar(address(r2), address(0xC0F));
        tax.mint(alice, 100e18);
        vm.startPrank(alice);
        tax.approve(address(r2), 100e18);
        assertEq(r2.emitir(address(tax), 100e18, 0), 98.901e18);
        vm.stopPrank();
        assertGe(r2.lastroTotal(), t2.totalSupply());
    }

    function test_SpreadDeConcentracaoViraLastroExtra() public {
        _emitirBrz(alice, 5_000e18);
        (uint256 l, uint256 t, uint256 s) = reserva.cotarEmissao(address(brz), 10_000e18);
        assertEq(t, 10e18);
        assertEq(s, 40e18);
        assertEq(l, 9_950e18);
        assertEq(_emitirBrz(carol, 10_000e18), 9_950e18);
        assertEq(reserva.lastroTotal() - token.totalSupply(), 40e18, "spread fica como lastro a mais");
        (,, s) = reserva.cotarEmissao(address(brla), 10_000e6);
        assertEq(s, 0);
        _sistemaCoberto();
    }

    function test_SpreadNoResgateDoLastroEscasso() public {
        _emitirBrz(alice, 15_000e18);
        _emitirBrla(bob, 10_000e6);
        (uint256 pagoBrla,, uint256 sBrla) = reserva.cotarResgate(address(brla), 5_000e18);
        (uint256 pagoBrz,, uint256 sBrz) = reserva.cotarResgate(address(brz), 5_000e18);
        assertGt(sBrla, 0);
        assertEq(sBrz, 0);
        assertEq(pagoBrz, 4_995e18);
        vm.startPrank(bob);
        token.approve(address(reserva), 5_000e18);
        assertEq(reserva.resgatar(address(brla), 5_000e18, 0), pagoBrla);
        vm.stopPrank();
        _sistemaCoberto();
    }

    function test_TetoDiarioPorLastro() public {
        _emitirBrz(alice, 50_000e18);
        assertEq(reserva.emissaoDisponivelNaJanela(address(brz)), 0);
        brz.mint(alice, 1e18);
        vm.startPrank(alice);
        brz.approve(address(reserva), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LimiteEmissaoDiaria.selector, 0));
        reserva.emitir(address(brz), 1e18, 0);
        vm.stopPrank();
        _emitirBrla(bob, 1_000e6);
        vm.warp(block.timestamp + 1 days);
        _emitirBrz(alice, 1e18);
    }

    function test_LastroQuePerdeParidadeNaoDrenaOOutroDeUmaVez() public {
        _crescerAte(alice, 1_000_000e18);
        vm.warp(block.timestamp + 1 days);
        uint256 brlaAntes = brla.balanceOf(address(reserva));
        address atacante = makeAddr("atacante");
        uint256 limite = reserva.emissaoDisponivelNaJanela(address(brz));
        brz.mint(atacante, 1_000_000e18);
        vm.startPrank(atacante);
        brz.approve(address(reserva), type(uint256).max);
        vm.expectRevert();
        reserva.emitir(address(brz), 1_000_000e18, 0);
        uint256 obtido = reserva.emitir(address(brz), limite, 0);
        token.approve(address(reserva), type(uint256).max);
        reserva.resgatar(address(brla), obtido, 0);
        vm.expectRevert();
        reserva.emitir(address(brz), 1e18, 0);
        vm.stopPrank();
        uint256 drenado = (brlaAntes - brla.balanceOf(address(reserva))) * 1e12;
        assertLe(drenado, (reserva.lastroTotal() * 1_200) / 10_000);
        _sistemaCoberto();
    }

    function test_Fase2JanelaDeResgate() public {
        _crescerAte(alice, 1_200_000e18);
        assertEq(reserva.fase(), 2);
        uint256 limite = (token.totalSupply() * 2_000) / 10_000;
        vm.startPrank(alice);
        token.approve(address(reserva), type(uint256).max);
        reserva.resgatar(address(brz), 100_000e18, 0);
        uint256 disponivel = limite - 99_900e18;
        assertEq(reserva.resgateDisponivelNaJanela(), disponivel);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LimiteJanelaResgate.selector, disponivel));
        reserva.resgatar(address(brz), disponivel + 1_000e18, 0);
        vm.warp(block.timestamp + 1 days);
        reserva.resgatar(address(brz), 100_000e18, 0);
        vm.stopPrank();
        _sistemaCoberto();
    }

    function test_XbrlDoCofrePodeSerResgatadoNaReserva() public {
        // xBRL é um só: quem tem xBRL vindo do cofre também resgata stablecoin na reserva.
        _emitirBrz(alice, 10_000e18);
        _abrirEth(bob, 1e18, 5_000e18);
        vm.startPrank(bob);
        token.approve(address(reserva), 5_000e18);
        reserva.resgatar(address(brz), 5_000e18, 0);
        vm.stopPrank();
        _sistemaCoberto();
    }
}

// =====================================================================
// CofreCripto
// =====================================================================

contract CofreCriptoTest is Base {
    function test_RazaoDoTickConfereComReferencia() public view {
        assertEq(cofre.razaoDoTick(0), 340282366920938463463374607431768211456);
        assertApproxEqRel(cofre.razaoDoTick(1), 340316395157630557309720944892511388277, 1e9);
        assertApproxEqRel(cofre.razaoDoTick(-1), 340248342086729790484326174814286782777, 1e9);
        assertApproxEqRel(cofre.razaoDoTick(100), 343702089724658134425462205873642501801, 1e9);
        assertApproxEqRel(cofre.razaoDoTick(-200_000), 702075911466779181339691826087, 1e9);
        assertApproxEqRel(cofre.razaoDoTick(195_000), 100036487249776002596922069316731985309642473617, 1e9);
        assertApproxEqRel(cofre.razaoDoTick(-195_000), 1157498552984980708561476235147, 1e9);
    }

    function test_PrecoComConferenciaDupla() public view {
        (uint256 tw, bool okTw) = cofre.precoTwapUsd(0);
        assertTrue(okTw);
        assertApproxEqRel(tw, 2_500e18, 1e15); // ±0,1%
        (uint256 brl, bool ok) = cofre.precoBrl(0);
        assertTrue(ok);
        assertEq(brl, 12_500e18);
        (uint256 pol, bool okPol) = cofre.precoBrl(1);
        assertTrue(okPol);
        assertEq(pol, 0.6e18);
    }

    function test_EmitirAte200PorCento() public {
        _abrirEth(alice, 1e18, 6_000e18); // R$ 12.500 de garantia, dívida 6.030
        CofreCripto.Posicao memory p = cofre.posicao(0, alice);
        assertEq(p.colateral, 1e18);
        assertEq(p.divida, 6_030e18);
        assertEq(token.balanceOf(alice), 6_000e18);
        assertEq(token.balanceOf(TREASURY), 15e18);
        assertEq(cofre.colchao(), 15e18);
        (uint256 razao,) = cofre.razaoGarantia(0, alice);
        assertEq(razao, uint256(12_500e18 * 10_000) / 6_030e18);
        vm.prank(alice);
        vm.expectRevert(); // passaria de 200%
        cofre.emitir(0, 300e18);
        _sistemaCoberto();
    }

    function test_PolExige250PorCento() public {
        wpol.mint(alice, 10_000e18); // R$ 6.000
        vm.startPrank(alice);
        wpol.approve(address(cofre), 10_000e18);
        cofre.depositar(1, 10_000e18);
        vm.expectRevert();
        cofre.emitir(1, 2_500e18); // 2.512,5 → 238%
        cofre.emitir(1, 2_380e18); // 2.391,9 → 250,8%
        vm.stopPrank();
    }

    function test_DividaMinimaETeto() public {
        weth.mint(alice, 10e18);
        vm.startPrank(alice);
        weth.approve(address(cofre), 10e18);
        cofre.depositar(0, 10e18);
        vm.expectRevert(CofreCripto.DividaMinima.selector);
        cofre.emitir(0, 5e18);
        vm.stopPrank();

        CofreCripto pequeno = _novoCofre(500e18);
        assertEq(pequeno.emissaoDisponivel(0), 500e18);
    }

    function test_RetirarEQuitar() public {
        _abrirEth(alice, 1e18, 4_000e18);
        vm.startPrank(alice);
        vm.expectRevert(); // não pode tirar garantia abaixo de 200%
        cofre.retirar(0, 0.7e18);
        cofre.retirar(0, 0.3e18); // R$ 8.750 / 4.020 = 217%
        token.approve(address(cofre), type(uint256).max);
        vm.expectRevert(CofreCripto.DividaMinima.selector);
        cofre.quitar(0, alice, 4_015e18); // sobraria pó
        vm.stopPrank();

        // Qualquer pessoa pode pagar a dívida de alguém (ex.: familiar).
        deal(address(token), bob, 100e18, true);
        vm.startPrank(bob);
        token.approve(address(cofre), 20e18);
        cofre.quitar(0, alice, 20e18);
        vm.stopPrank();
        assertEq(cofre.posicao(0, alice).divida, 4_000e18);

        deal(address(token), alice, 4_000e18, false);
        vm.startPrank(alice);
        cofre.quitar(0, alice, type(uint256).max);
        cofre.retirar(0, 0.7e18);
        vm.stopPrank();
        assertEq(weth.balanceOf(alice), 1e18);
        assertEq(cofre.dividaTotalGlobal(), 0);
    }

    function test_NinguemMexeNaGarantiaDosOutros() public {
        _abrirEth(alice, 1e18, 1_000e18);
        vm.startPrank(bob);
        vm.expectRevert(CofreCripto.ColateralInsuficiente.selector);
        cofre.retirar(0, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                CofreCripto.PosicaoSaudavel.selector, uint256(12_500e18 * 10_000) / 1_005e18
            )
        );
        cofre.liquidar(0, alice);
        vm.stopPrank();
    }

    function test_ChainlinkParadaUsaTwapSoParaLiquidar() public {
        _abrirEth(alice, 1e18, 6_000e18);
        vm.warp(block.timestamp + 3 hours); // Chainlink ETH sem atualizar
        feedBrl.definir(0.2e8);
        (uint256 preco, bool ok) = cofre.precoBrl(0);
        assertTrue(ok);
        assertApproxEqRel(preco, 12_500e18, 1e15);
        (, bool okEmitir) = cofre.precoParaEmitir(0);
        assertFalse(okEmitir, "sem Chainlink ninguem emite");
        vm.startPrank(alice);
        vm.expectRevert(CofreCripto.PrecoIndisponivel.selector);
        cofre.emitir(0, 10e18);
        vm.expectRevert(CofreCripto.PrecoIndisponivel.selector);
        cofre.retirar(0, 0.01e18);
        vm.stopPrank();
        // Mas a liquidação continua funcionando numa queda real, pelo TWAP
        poolEth.definir(-203_189); // US$ 1.500
        _emitirBrla(bob, 7_100e6);
        vm.startPrank(bob);
        token.approve(address(cofre), type(uint256).max);
        cofre.liquidar(0, alice);
        vm.stopPrank();
        assertEq(cofre.posicao(0, alice).divida, 0);
        _sistemaCoberto();
    }

    function test_EmissaoUsaOMenorPrecoEntreAsFontes() public {
        poolEth.definir(-198_480); // TWAP ≈ US$ 2.401 (4% abaixo da Chainlink): dentro da tolerância
        (uint256 conservador, bool ok) = cofre.precoParaEmitir(0);
        assertTrue(ok);
        (uint256 tw,) = cofre.precoTwapUsd(0);
        assertEq(conservador, (tw * 1e18) / 0.2e18);
        assertLt(conservador, 12_500e18);
        weth.mint(alice, 1e18);
        vm.startPrank(alice);
        weth.approve(address(cofre), 1e18);
        cofre.depositar(0, 1e18);
        vm.expectRevert(); // 6.000 passaria com o preço da Chainlink, mas não com o menor
        cofre.emitir(0, 6_000e18);
        cofre.emitir(0, 5_900e18);
        vm.stopPrank();
    }

    function test_PoolManipuladaParaCimaNaoAumentaEmissao() public {
        // Atacante empurra a pool 4,9% para cima (no limite): a emissão continua usando a Chainlink (menor).
        poolEth.definir(-197_600);
        (uint256 p,) = cofre.precoParaEmitir(0);
        assertEq(p, 12_500e18);
        // Mais que 5%: tudo trava em vez de aceitar o preço manipulado
        poolEth.definir(-197_000);
        (, bool ok) = cofre.precoParaEmitir(0);
        assertFalse(ok);
    }

    function test_SemNenhumPrecoTravaEmissaoMasNaoTravaQuitar() public {
        _abrirEth(alice, 1e18, 1_000e18);
        poolEth.semDados(true);
        feedEth.quebrar(true);
        (, bool ok) = cofre.precoBrl(0);
        assertFalse(ok);
        vm.startPrank(alice);
        vm.expectRevert(CofreCripto.PrecoIndisponivel.selector);
        cofre.emitir(0, 100e18);
        vm.expectRevert(CofreCripto.PrecoIndisponivel.selector);
        cofre.retirar(0, 0.1e18);
        token.approve(address(cofre), type(uint256).max);
        cofre.quitar(0, alice, 500e18); // pagar dívida sempre funciona
        weth.mint(alice, 1e18);
        weth.approve(address(cofre), 1e18);
        cofre.depositar(0, 1e18); // depositar sempre funciona
        vm.stopPrank();
        vm.expectRevert(CofreCripto.PrecoIndisponivel.selector);
        cofre.liquidar(0, alice);
    }

    function test_DivergenciaChainlinkTwapTravaEmissao() public {
        poolEth.definir(-197_311); // TWAP ≈ US$ 2.700 (8% acima)
        (, bool ok) = cofre.precoBrl(0);
        assertFalse(ok);
        weth.mint(alice, 1e18);
        vm.startPrank(alice);
        weth.approve(address(cofre), 1e18);
        cofre.depositar(0, 1e18);
        vm.expectRevert(CofreCripto.PrecoIndisponivel.selector);
        cofre.emitir(0, 1_000e18);
        vm.stopPrank();
    }

    function test_BrlUsdParadoTravaTudoQueDependeDePreco() public {
        vm.warp(block.timestamp + 27 hours);
        feedEth.definir(2_500e8);
        (, bool ok) = cofre.precoBrl(0);
        assertFalse(ok);
    }

    function test_EthCai40PorCentoNumDia_LiquidacaoSemPrejuizo() public {
        _abrirEth(alice, 1e18, 6_000e18); // dívida 6.030, garantia R$ 12.500 (207%)
        vm.warp(block.timestamp + 1 days);
        feedBrl.definir(0.2e8);
        _precoEth(1_500e8, -203_189); // -40% → R$ 7.500 (124%)
        (uint256 razao,) = cofre.razaoGarantia(0, alice);
        assertLt(razao, 15_000);

        _emitirBrla(bob, 7_100e6);
        vm.startPrank(bob);
        token.approve(address(cofre), type(uint256).max);
        CofreCripto.PlanoLiquidacao memory q = cofre.simularLiquidacao(0, alice);
        cofre.liquidar(0, alice);
        vm.stopPrank();

        assertEq(q.pagar, 6_030e18);
        assertEq(q.ruim, 0);
        assertEq(q.coberto, 0);
        // Liquidante recebe R$ 6.633 em ETH (dívida + 10%)
        assertApproxEqRel(weth.balanceOf(bob) * 7_500, 6_633e18, 1e12);
        // O resto da garantia continua da Alice
        CofreCripto.Posicao memory p = cofre.posicao(0, alice);
        assertEq(p.divida, 0);
        assertApproxEqRel(uint256(p.colateral) * 7_500, 867e18, 1e12);
        assertEq(cofre.dividaRuim(), 0);
        _sistemaCoberto();
    }

    function test_EthCai57PorCento_ColchaoCobreOPrejuizo() public {
        _emitirBrz(carol, 50_000e18); // gera taxas → colchão
        vm.prank(carol);
        assertTrue(token.transfer(address(cofre), 2_000e18)); // doação ao colchão
        _abrirEth(alice, 1e18, 6_000e18);
        vm.warp(block.timestamp + 1 days);
        feedBrl.definir(0.2e8);
        _precoEth(1_075e8, -206_520); // -57% → R$ 5.375 (89%)

        _emitirBrla(bob, 7_100e6);
        uint256 colchaoAntes = cofre.colchao();
        vm.startPrank(bob);
        token.approve(address(cofre), type(uint256).max);
        cofre.liquidar(0, alice);
        vm.stopPrank();

        uint256 pago = uint256(5_375e18 * 10_000) / 11_000;
        assertEq(weth.balanceOf(bob), 1e18, "liquidante leva toda a garantia");
        assertEq(cofre.colchao(), colchaoAntes - (6_030e18 - pago), "colchao queima a diferenca");
        assertEq(cofre.dividaRuim(), 0);
        assertEq(cofre.dividaTotalGlobal(), 0);
        _sistemaCoberto();
    }

    function test_EthCai57SemColchaoSuficiente_DividaRuimPublica() public {
        _abrirEth(alice, 1e18, 6_000e18);
        vm.warp(block.timestamp + 1 days);
        feedBrl.definir(0.2e8);
        _precoEth(1_075e8, -206_520);
        _emitirBrla(bob, 7_100e6);
        uint256 colchaoAntes = cofre.colchao(); // só as taxas (~18,55 xBRL)
        vm.startPrank(bob);
        token.approve(address(cofre), type(uint256).max);
        cofre.liquidar(0, alice);
        vm.stopPrank();
        uint256 pago = uint256(5_375e18 * 10_000) / 11_000;
        uint256 faltante = 6_030e18 - pago;
        assertEq(cofre.dividaRuim(), faltante - colchaoAntes, "colchao cobre parte; o resto fica publico");
        assertEq(cofre.colchao(), 0);
        _sistemaCoberto();
    }

    function testFuzz_QuedaQualquerMantemSistemaCoberto(uint16 quedaBps, uint96 emitido) public {
        uint256 q = bound(uint256(quedaBps), 0, 9_000);
        uint256 e = bound(uint256(emitido), 10e18, 6_200e18);
        _emitirBrz(carol, 20_000e18);
        _abrirEth(alice, 1e18, e);
        vm.warp(block.timestamp + 1 hours);
        feedBrl.definir(0.2e8);
        int256 novo = int256(2_500e8 * (10_000 - q) / 10_000);
        feedEth.definir(novo);
        poolEth.semDados(true); // usa só a Chainlink nesta simulação
        (uint256 razao, bool ok) = cofre.razaoGarantia(0, alice);
        if (ok && razao < 15_000) {
            _emitirBrla(bob, 10_100e6);
            vm.startPrank(bob);
            token.approve(address(cofre), type(uint256).max);
            cofre.liquidar(0, alice);
            vm.stopPrank();
            assertEq(cofre.posicao(0, alice).divida, 0);
        }
        _sistemaCoberto();
    }

    function test_ConfigInvalidaRejeitada() public {
        CofreCripto.ConfigAtivo[] memory a = new CofreCripto.ConfigAtivo[](1);
        a[0] = CofreCripto.ConfigAtivo({
            token: address(weth),
            feedUsd: address(feedEth),
            heartbeat: 2 hours,
            pool: address(0),
            ativoEhToken0: false,
            decimaisPar: 6,
            crEmissaoBps: 15_000,
            crLiquidacaoBps: 14_000,
            tetoDivida: 1
        });
        vm.expectRevert(CofreCripto.ConfigInvalida.selector);
        new CofreCripto(address(token), TREASURY, a, address(feedBrl), 26 hours);
        vm.expectRevert(CofreCripto.AtivoInexistente.selector);
        cofre.ativo(9);
    }
}

/// @dev Ator aleatório para invariantes do sistema inteiro (reserva + cofre + preço + tempo).
contract HandlerSistema is Test {
    ReservaBRL internal reserva;
    CofreCripto internal cofre;
    xBRL internal token;
    MockBRL internal brz;
    MockBRL internal brla;
    MockBRL internal weth;
    MockFeed internal feedEth;
    MockFeed internal feedBrl;
    MockPool internal poolEth;
    address[] internal atores;

    constructor(
        Base b,
        ReservaBRL r,
        CofreCripto c,
        xBRL t,
        MockBRL z,
        MockBRL l,
        MockBRL w,
        MockFeed fe,
        MockFeed fb,
        MockPool pe
    ) {
        b;
        reserva = r;
        cofre = c;
        token = t;
        brz = z;
        brla = l;
        weth = w;
        feedEth = fe;
        feedBrl = fb;
        poolEth = pe;
        atores.push(address(0xA1));
        atores.push(address(0xA2));
        atores.push(address(0xA3));
    }

    function _ator(uint256 s) internal view returns (address) {
        return atores[s % atores.length];
    }

    function emitirReserva(uint256 a, bool usaBrz, uint256 v) external {
        address quem = _ator(a);
        MockBRL l = usaBrz ? brz : brla;
        v = usaBrz ? bound(v, 1e12, 60_000e18) : bound(v, 1, 60_000e6);
        l.mint(quem, v);
        vm.startPrank(quem);
        l.approve(address(reserva), v);
        try reserva.emitir(address(l), v, 0) {} catch {}
        vm.stopPrank();
    }

    function resgatarReserva(uint256 a, bool usaBrz, uint256 v) external {
        address quem = _ator(a);
        uint256 saldo = token.balanceOf(quem);
        if (saldo < 1e13) return;
        v = bound(v, 1e13, saldo);
        vm.startPrank(quem);
        token.approve(address(reserva), v);
        try reserva.resgatar(address(usaBrz ? brz : brla), v, 0) {} catch {}
        vm.stopPrank();
    }

    function abrirCofre(uint256 a, uint256 q, uint256 v) external {
        address quem = _ator(a);
        q = bound(q, 1e15, 20e18);
        weth.mint(quem, q);
        vm.startPrank(quem);
        weth.approve(address(cofre), q);
        cofre.depositar(0, q);
        v = bound(v, 10e18, 100_000e18);
        try cofre.emitir(0, v) {} catch {}
        vm.stopPrank();
    }

    function quitarCofre(uint256 a, uint256 v) external {
        address quem = _ator(a);
        uint256 saldo = token.balanceOf(quem);
        if (saldo == 0) return;
        vm.startPrank(quem);
        token.approve(address(cofre), saldo);
        try cofre.quitar(0, quem, bound(v, 1, saldo)) {} catch {}
        vm.stopPrank();
    }

    function liquidarCofre(uint256 liquidante, uint256 alvo) external {
        address l = _ator(liquidante);
        address quem = _ator(alvo);
        vm.startPrank(l);
        token.approve(address(cofre), type(uint256).max);
        try cofre.liquidar(0, quem) {} catch {}
        vm.stopPrank();
    }

    function moverPreco(uint256 bps, bool sobe) external {
        bps = bound(bps, 0, 3_000);
        int256 atual = feedEth.resposta();
        int256 delta = (atual * int256(bps)) / 10_000;
        int256 novo = sobe ? atual + delta : atual - delta;
        if (novo < 50e8) novo = 50e8;
        feedEth.definir(novo);
        feedBrl.definir(feedBrl.resposta());
    }

    function passarTempo(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 1 hours));
        feedEth.definir(feedEth.resposta());
        feedBrl.definir(feedBrl.resposta());
    }
}

contract SistemaInvarianteTest is Base {
    HandlerSistema internal h;

    /// @dev Aqui o preço anda só pela Chainlink (o handler sobe e desce o ETH à vontade).
    function _comPool() internal pure override returns (bool) {
        return false;
    }

    function setUp() public override {
        super.setUp();
        h = new HandlerSistema(this, reserva, cofre, token, brz, brla, weth, feedEth, feedBrl, poolEth);
        targetContract(address(h));
    }

    function invariant_TodoXbrlTemLastroOuDivida() public view {
        _sistemaCoberto();
    }

    function invariant_GarantiasDoCofreBatemComOSaldo() public view {
        uint256 soma;
        address[3] memory a = [address(0xA1), address(0xA2), address(0xA3)];
        for (uint256 i = 0; i < 3; ++i) {
            soma += cofre.posicao(0, a[i]).colateral;
        }
        assertEq(weth.balanceOf(address(cofre)), soma, "garantia sumiu ou apareceu");
    }

    function invariant_DividaGlobalBateComPosicoes() public view {
        uint256 soma;
        address[3] memory a = [address(0xA1), address(0xA2), address(0xA3)];
        for (uint256 i = 0; i < 3; ++i) {
            soma += cofre.posicao(0, a[i]).divida;
        }
        assertEq(cofre.dividaTotalGlobal(), soma);
        assertEq(cofre.ativo(0).dividaTotal, soma);
    }

    function invariant_ReservaNaoGuardaXbrl() public view {
        assertEq(token.balanceOf(address(reserva)), 0);
    }
}

// =====================================================================
// EscrowTrabalho
// =====================================================================

contract EscrowTrabalhoTest is Base {
    address internal cliente;
    address internal trab;
    address internal arbC = makeAddr("arbitroDoCliente");
    address internal arbT = makeAddr("arbitroDoTrabalhador");
    string internal constant CHEGADA = "porta janela cadeira mesa tapete";
    string internal constant CODIGO = "vogal imunizar nordeste sapato haver";
    string internal constant DEVOLUCAO = "barco sereno pilha mostarda grade";

    function setUp() public override {
        super.setUp();
        cliente = carol;
        trab = bob;
        deal(address(token), cliente, 1_000_000e18, true);
        deal(address(token), trab, 10_000e18, true);
        vm.prank(cliente);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(trab);
        token.approve(address(escrow), type(uint256).max);
    }

    function _param(EscrowTrabalho.Modalidade m, address t, uint128 valor)
        internal
        view
        returns (EscrowTrabalho.NovoTrabalho memory p)
    {
        p.modalidade = m;
        p.trabalhador = t;
        p.valor = valor;
        p.prazo = uint64(block.timestamp + 7 days);
        p.etapas = 1;
        p.descricao = "Trabalho de teste";
        if (m == EscrowTrabalho.Modalidade.Presencial) p.chegadaHash = escrow.hashChegada(cliente, CHEGADA);
        if (m == EscrowTrabalho.Modalidade.Entrega) p.codigoHash = escrow.hashCodigo(cliente, CODIGO);
    }

    function _criar(EscrowTrabalho.NovoTrabalho memory p) internal returns (uint256 id) {
        vm.prank(cliente);
        id = escrow.criarTrabalho(p);
    }

    function _novo(EscrowTrabalho.Modalidade m, address t, uint128 valor) internal returns (uint256) {
        return _criar(_param(m, t, valor));
    }

    function _aceitar(uint256 id, address quem, address arbitro) internal {
        vm.prank(quem);
        escrow.aceitar(id, arbitro);
    }

    function _estado(uint256 id) internal view returns (EscrowTrabalho.Estado) {
        return escrow.trabalho(id).estado;
    }

    function _concluirRemoto(address c, address t, uint128 valor) internal returns (uint256 id) {
        EscrowTrabalho.NovoTrabalho memory p = _param(EscrowTrabalho.Modalidade.Remoto, t, valor);
        vm.prank(c);
        id = escrow.criarTrabalho(p);
        _aceitar(id, t, address(0));
        vm.prank(c);
        escrow.liberar(id);
    }

    // ---------------- Fluxos básicos ----------------

    function test_PresencialComChegadaPorCodigoEAprovacao() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18);
        _aceitar(id, trab, address(0));
        vm.startPrank(trab);
        vm.expectRevert(EscrowTrabalho.ChegadaObrigatoria.selector);
        escrow.marcarEntregue(id);
        vm.expectRevert(EscrowTrabalho.CodigoIncorreto.selector);
        escrow.confirmarChegada(id, "porta janela cadeira mesa sofa");
        escrow.confirmarChegada(id, CHEGADA);
        escrow.marcarEntregue(id);
        vm.stopPrank();
        uint256 colchao = cofre.colchao();
        vm.prank(cliente);
        escrow.liberar(id);
        assertEq(token.balanceOf(trab), 10_000e18 + 99.9e18);
        assertEq(token.balanceOf(TREASURY), 0.05e18);
        assertEq(cofre.colchao() - colchao, 0.05e18, "metade da taxa vai ao colchao");
        assertEq(escrow.nivel(trab), 1);
    }

    function test_ClienteConfirmaChegadaSemCamera() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18);
        _aceitar(id, trab, address(0));
        vm.prank(alice);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.confirmarChegadaPeloCliente(id);
        vm.prank(cliente);
        escrow.confirmarChegadaPeloCliente(id);
        assertTrue(escrow.trabalho(id).chegou);
        vm.prank(trab);
        escrow.marcarEntregue(id);
    }

    function test_EntregaSoComCodigoENuncaTemDisputa() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Entrega, address(0), 25e18);
        _aceitar(id, trab, address(0));
        vm.startPrank(trab);
        vm.expectRevert(EscrowTrabalho.ModalidadeInvalida.selector);
        escrow.marcarEntregue(id);
        vm.expectRevert(EscrowTrabalho.SemDisputaNaEntrega.selector);
        escrow.abrirDisputa(id);
        vm.expectRevert(EscrowTrabalho.CodigoIncorreto.selector);
        escrow.confirmarComCodigo(id, "vogal imunizar nordeste sapato havia");
        vm.stopPrank();
        vm.prank(relayer);
        escrow.confirmarComCodigo(id, CODIGO);
        assertEq(token.balanceOf(trab), 10_000e18 + 24.975e18);
        vm.prank(cliente);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowTrabalho.EstadoInvalido.selector, EscrowTrabalho.Estado.Concluido)
        );
        escrow.abrirDisputa(id);
    }

    // ---------------- Caução do entregador ----------------

    function _paramCaucao(uint128 valorCaucao) internal view returns (EscrowTrabalho.NovoTrabalho memory p) {
        p = _param(EscrowTrabalho.Modalidade.Entrega, address(0), 30e18);
        p.caucao = valorCaucao;
        p.devolucaoHash = escrow.hashDevolucao(cliente, DEVOLUCAO);
    }

    function test_CaucaoVoltaComCodigoDeEntrega() public {
        uint256 id = _criar(_paramCaucao(300e18));
        _aceitar(id, trab, address(0));
        assertTrue(escrow.caucao(id).travada);
        assertEq(token.balanceOf(trab), 10_000e18 - 300e18);
        vm.prank(trab);
        vm.expectRevert(EscrowTrabalho.CaucaoInvalida.selector);
        escrow.desistir(id); // com a mercadoria na mão, só sai por código
        escrow.confirmarComCodigo(id, CODIGO);
        assertEq(token.balanceOf(trab), 10_000e18 + 29.97e18, "pagamento + caucao de volta");
        assertFalse(escrow.caucao(id).travada);
    }

    function test_CaucaoVoltaComCodigoDeDevolucao() public {
        uint256 saldoCliente = token.balanceOf(cliente);
        uint256 id = _criar(_paramCaucao(300e18));
        _aceitar(id, trab, address(0));
        vm.expectRevert(EscrowTrabalho.CodigoIncorreto.selector);
        escrow.confirmarDevolucao(id, CODIGO); // código de entrega não serve como devolução
        escrow.confirmarDevolucao(id, DEVOLUCAO);
        assertEq(token.balanceOf(cliente), saldoCliente, "cliente recebe o pagamento de volta");
        assertEq(token.balanceOf(trab), 10_000e18, "entregador recupera a caucao");
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Cancelado));
    }

    function test_EntregadorSomeClienteRecebeCaucao() public {
        uint256 saldoCliente = token.balanceOf(cliente);
        uint256 id = _criar(_paramCaucao(300e18));
        _aceitar(id, trab, address(0));
        uint256 prazo = escrow.trabalho(id).prazo;
        vm.prank(cliente);
        vm.expectRevert(abi.encodeWithSelector(EscrowTrabalho.PrazoNaoVencido.selector, prazo));
        escrow.reembolsarPorPrazo(id);
        vm.warp(prazo + 1);
        vm.prank(cliente);
        escrow.reembolsarPorPrazo(id);
        assertEq(token.balanceOf(cliente), saldoCliente + 300e18, "reembolso + caucao como indenizacao");
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_CaucaoValidacoes() public {
        EscrowTrabalho.NovoTrabalho memory p = _paramCaucao(199e18);
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.CaucaoInvalida.selector);
        escrow.criarTrabalho(p);
        p = _paramCaucao(300e18);
        p.devolucaoHash = 0;
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.CaucaoInvalida.selector);
        escrow.criarTrabalho(p);
        p = _param(EscrowTrabalho.Modalidade.Remoto, trab, 30e18);
        p.caucao = 300e18;
        p.devolucaoHash = keccak256("x");
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.CaucaoInvalida.selector);
        escrow.criarTrabalho(p);
        p = _param(EscrowTrabalho.Modalidade.Entrega, trab, 30e18);
        p.arbitroCliente = arbC;
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.SemDisputaNaEntrega.selector);
        escrow.criarTrabalho(p);
        // entregador sem saldo para a caução não consegue aceitar
        uint256 id = _criar(_paramCaucao(300e18));
        vm.prank(alice);
        vm.expectRevert();
        escrow.aceitar(id, address(0));
    }

    // ---------------- Árbitros ----------------

    function _comArbitros(bool desempate) internal returns (uint256 id) {
        EscrowTrabalho.NovoTrabalho memory p = _param(EscrowTrabalho.Modalidade.Remoto, trab, 100e18);
        p.arbitroCliente = arbC;
        p.desempateCriador = desempate;
        id = _criar(p);
        _aceitar(id, trab, arbT);
        vm.prank(cliente);
        escrow.abrirDisputa(id);
    }

    function test_ArbitrosValidados() public {
        EscrowTrabalho.NovoTrabalho memory p = _param(EscrowTrabalho.Modalidade.Remoto, trab, 100e18);
        p.arbitroCliente = cliente;
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.ArbitroInvalido.selector);
        escrow.criarTrabalho(p);
        p.arbitroCliente = trab;
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.ArbitroInvalido.selector);
        escrow.criarTrabalho(p);
        p.arbitroCliente = arbC;
        uint256 id = _criar(p);
        vm.startPrank(trab);
        vm.expectRevert(EscrowTrabalho.ArbitroInvalido.selector);
        escrow.aceitar(id, address(0));
        vm.expectRevert(EscrowTrabalho.ArbitroInvalido.selector);
        escrow.aceitar(id, cliente);
        vm.expectRevert(EscrowTrabalho.ArbitroInvalido.selector);
        escrow.aceitar(id, trab);
        escrow.aceitar(id, arbT);
        vm.stopPrank();
        assertEq(escrow.arbitragem(id).arbitroTrabalhador, arbT);
        // sem árbitro do cliente, o trabalhador não pode indicar um
        uint256 id2 = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 10e18);
        vm.prank(trab);
        vm.expectRevert(EscrowTrabalho.ArbitroInvalido.selector);
        escrow.aceitar(id2, arbT);
    }

    function test_ArbitrosConcordamResolve() public {
        uint256 id = _comArbitros(false);
        uint256 saldoCliente = token.balanceOf(cliente);
        vm.prank(alice);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.arbitrar(id, 5_000);
        vm.prank(arbC);
        escrow.arbitrar(id, 6_000);
        vm.prank(arbT);
        escrow.arbitrar(id, 8_000);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Disputa));
        vm.prank(arbT);
        escrow.arbitrar(id, 6_000);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Concluido));
        assertEq(token.balanceOf(trab), 10_000e18 + 59.94e18);
        assertEq(token.balanceOf(cliente), saldoCliente + 40e18);
    }

    function test_DesempateDoCriadorSoEntreAsPropostas() public {
        uint256 id = _comArbitros(true);
        vm.prank(arbC);
        escrow.arbitrar(id, 2_000);
        vm.prank(arbT);
        escrow.arbitrar(id, 9_000);
        uint256 libera = block.timestamp + 3 days;
        vm.prank(TREASURY);
        vm.expectRevert(abi.encodeWithSelector(EscrowTrabalho.AguardandoArbitros.selector, libera));
        escrow.desempatar(id, 5_000);
        vm.warp(libera);
        vm.prank(alice);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.desempatar(id, 5_000);
        vm.prank(TREASURY);
        vm.expectRevert(EscrowTrabalho.ForaDoIntervaloDosArbitros.selector);
        escrow.desempatar(id, 9_500);
        vm.prank(TREASURY);
        escrow.desempatar(id, 5_000);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Concluido));
    }

    function test_SemOpcaoDeDesempateOCriadorNaoEntra() public {
        uint256 id = _comArbitros(false);
        vm.prank(arbC);
        escrow.arbitrar(id, 2_000);
        vm.prank(arbT);
        escrow.arbitrar(id, 9_000);
        vm.warp(block.timestamp + 10 days);
        vm.prank(TREASURY);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.desempatar(id, 5_000);
        // 30 dias: média das propostas dos árbitros
        vm.warp(block.timestamp + 30 days);
        escrow.resolverPorTempo(id);
        assertEq(token.balanceOf(trab), 10_000e18 + 54.945e18); // 55% de 100 - 0,1%
    }

    function test_CriadorDecideQuandoNaoHaArbitros() public {
        EscrowTrabalho.NovoTrabalho memory p = _param(EscrowTrabalho.Modalidade.Remoto, trab, 100e18);
        p.desempateCriador = true;
        uint256 id = _criar(p);
        _aceitar(id, trab, address(0));
        vm.prank(trab);
        escrow.abrirDisputa(id);
        vm.prank(TREASURY);
        vm.expectRevert();
        escrow.desempatar(id, 7_000);
        vm.warp(block.timestamp + 3 days);
        vm.prank(TREASURY);
        escrow.desempatar(id, 7_000);
        assertEq(token.balanceOf(trab), 10_000e18 + 69.93e18);
    }

    function test_AcordoDiretoDasPartesContinuaValendo() public {
        uint256 id = _comArbitros(true);
        vm.prank(trab);
        escrow.proporAcordo(id, 7_000);
        vm.prank(cliente);
        escrow.proporAcordo(id, 7_000);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Concluido));
    }

    function test_MesmoArbitroParaOsDoisResolveSozinho() public {
        EscrowTrabalho.NovoTrabalho memory p = _param(EscrowTrabalho.Modalidade.Remoto, trab, 100e18);
        p.arbitroCliente = arbC;
        uint256 id = _criar(p);
        _aceitar(id, trab, arbC);
        vm.prank(cliente);
        escrow.abrirDisputa(id);
        vm.prank(arbC);
        escrow.arbitrar(id, 4_000);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Concluido));
    }

    // ---------------- Demais regras (mantidas) ----------------

    function test_VagaAbertaRemotaExigeAprovacao() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, address(0), 100e18);
        _aceitar(id, trab, address(0));
        assertTrue(escrow.trabalho(id).pendenteAprovacao);
        vm.startPrank(trab);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowTrabalho.EstadoInvalido.selector, EscrowTrabalho.Estado.Aberto)
        );
        escrow.marcarEntregue(id);
        vm.stopPrank();
        vm.prank(cliente);
        escrow.decidirCandidato(id, false);
        _aceitar(id, alice, address(0));
        vm.prank(alice);
        escrow.desistir(id);
        _aceitar(id, trab, address(0));
        vm.prank(cliente);
        escrow.decidirCandidato(id, true);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Aceito));
    }

    function test_RemotoReivindicacaoEEtapas() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 300e18);
        _aceitar(id, trab, address(0));
        vm.startPrank(trab);
        escrow.marcarEntregue(id);
        vm.expectRevert();
        escrow.reivindicar(id);
        vm.warp(block.timestamp + 3 days);
        escrow.reivindicar(id);
        vm.stopPrank();

        EscrowTrabalho.NovoTrabalho memory p = _param(EscrowTrabalho.Modalidade.Etapas, trab, 100e18);
        p.etapas = 3;
        uint256 e = _criar(p);
        _aceitar(e, trab, address(0));
        vm.prank(cliente);
        escrow.liberar(e);
        vm.prank(trab);
        escrow.marcarEntregue(e);
        vm.warp(block.timestamp + 3 days);
        vm.prank(trab);
        escrow.reivindicar(e);
        vm.prank(cliente);
        escrow.liberar(e);
        assertEq(uint8(_estado(e)), uint8(EscrowTrabalho.Estado.Concluido));
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_DisputaPorTempoMeioAMeioSemArbitros() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18);
        uint256 saldo = token.balanceOf(cliente);
        _aceitar(id, trab, address(0));
        vm.prank(trab);
        escrow.abrirDisputa(id);
        vm.warp(block.timestamp + 30 days);
        escrow.resolverPorTempo(id);
        assertEq(token.balanceOf(cliente), saldo + 50e18);
    }

    function test_ReputacaoBarraContasFalsas() public {
        for (uint256 i = 0; i < 30; ++i) {
            uint256 id = _concluirRemoto(cliente, trab, 20e18);
            vm.prank(cliente);
            escrow.avaliar(id, 5);
        }
        vm.warp(block.timestamp + 400 days);
        (uint32 conc,, uint32 aval, uint32 contra,,,) = escrow.reputacao(trab);
        assertEq(conc, 30);
        assertEq(contra, 1);
        assertEq(aval, 1);
        assertEq(escrow.nivel(trab), 1);

        for (uint256 i = 0; i < 5; ++i) {
            address c = makeAddr(string(abi.encodePacked("cliente", i)));
            deal(address(token), c, 1_000e18, true);
            vm.prank(c);
            token.approve(address(escrow), type(uint256).max);
            uint256 id = _concluirRemoto(c, trab, 100e18);
            vm.prank(c);
            escrow.avaliar(id, 4);
        }
        assertEq(escrow.nivel(trab), 2);
    }

    function test_AvaliacaoExigeValorMinimo() public {
        uint256 id = _concluirRemoto(cliente, trab, 5e18);
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.ValorBaixoParaAvaliar.selector);
        escrow.avaliar(id, 5);
    }
}

// =====================================================================
// Mensageiro
// =====================================================================

contract MensageiroTest is Test {
    Mensageiro internal m;

    function setUp() public {
        m = new Mensageiro();
    }

    function _chave(Vm.Wallet memory w) internal pure returns (bytes memory) {
        return abi.encodePacked(w.publicKeyX, w.publicKeyY);
    }

    function test_RegistraSoAPropriaChave() public {
        Vm.Wallet memory a = vm.createWallet("a");
        Vm.Wallet memory b = vm.createWallet("b");
        vm.prank(a.addr);
        m.registrarChave(_chave(a));
        assertEq(m.chavePublica(a.addr), _chave(a));
        vm.prank(a.addr);
        vm.expectRevert(Mensageiro.ChaveInvalida.selector);
        m.registrarChave(_chave(b));
        vm.prank(a.addr);
        vm.expectRevert(Mensageiro.ChaveInvalida.selector);
        m.registrarChave(hex"1234");
    }

    function test_EnviarComLimites() public {
        Vm.Wallet memory a = vm.createWallet("a");
        address[] memory para = new address[](2);
        para[0] = a.addr;
        para[1] = address(0xB0B);
        bytes[] memory c = new bytes[](2);
        c[0] = hex"aa";
        c[1] = hex"bb";
        vm.prank(a.addr);
        m.enviar(keccak256("conversa"), para, c, _chave(a));
        assertEq(m.chavePublica(a.addr), _chave(a));
        bytes[] memory um = new bytes[](1);
        um[0] = hex"aa";
        vm.expectRevert(Mensageiro.MensagemInvalida.selector);
        m.enviar(keccak256("conversa"), para, um, "");
        c[1] = new bytes(4_097);
        vm.expectRevert(Mensageiro.MensagemInvalida.selector);
        m.enviar(keccak256("conversa"), para, c, "");
    }
}

// =====================================================================
// Integração + script de deploy
// =====================================================================

contract IntegracaoTest is Base {
    function test_EcossistemaCompleto() public {
        assertEq(_emitirBrz(carol, 2_000e18), 1_998e18);
        _abrirEth(alice, 1e18, 3_000e18);
        vm.startPrank(carol);
        token.approve(address(escrow), type(uint256).max);
        EscrowTrabalho.NovoTrabalho memory p;
        p.modalidade = EscrowTrabalho.Modalidade.Entrega;
        p.valor = 1_000e18;
        p.prazo = uint64(block.timestamp + 1 days);
        p.etapas = 1;
        p.codigoHash = escrow.hashCodigo(carol, "pastel feira moeda tigela viola");
        p.caucao = 500e18;
        p.devolucaoHash = escrow.hashDevolucao(carol, "barco sereno pilha mostarda grade");
        p.descricao = "Entrega de 50 pasteis";
        uint256 id = escrow.criarTrabalho(p);
        vm.stopPrank();
        // O entregador usa xBRL emitido no cofre como caução
        vm.startPrank(alice);
        token.approve(address(escrow), 500e18);
        escrow.aceitar(id, address(0));
        escrow.confirmarComCodigo(id, "pastel feira moeda tigela viola");
        token.approve(address(reserva), 999e18);
        reserva.resgatar(address(brz), 999e18, 0);
        vm.stopPrank();
        assertEq(brz.balanceOf(alice), 998.001e18);
        _sistemaCoberto();
    }
}

contract DeployScriptTest is Test {
    bytes internal constant FABRICA_CREATE2 =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    function setUp() public {
        vm.warp(1_750_000_000);
        if (CREATE2_FACTORY.code.length == 0) vm.etch(CREATE2_FACTORY, FABRICA_CREATE2);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("XBRL_GRAVAR_JSON", "false");
    }

    function test_DeployTestnetEIdempotente() public {
        vm.chainId(80_002);
        DeployPolygon s = new DeployPolygon();
        DeployPolygon.Implantacao memory a = s.run();
        assertTrue(xBRL(a.token).inicializado());
        assertEq(xBRL(a.token).cofre(), a.cofre);
        assertEq(ReservaBRL(a.reserva).owner(), 0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1);
        assertEq(ReservaBRL(a.reserva).TETO_RESERVA(), 1_000e18);
        assertEq(CofreCripto(a.cofre).totalAtivos(), 2);
        (, bool ok) = CofreCripto(a.cofre).precoBrl(0);
        assertTrue(ok);
        DeployPolygon.Implantacao memory b = s.run();
        assertEq(a.cofre, b.cofre);
        assertEq(a.mensageiro, b.mensageiro);
    }

    function test_DeployPolygonConfereTudo() public {
        vm.chainId(137);
        DeployPolygon s = new DeployPolygon();
        MockBRL m18 = new MockBRL("BRL", "BRL", 18);
        MockBRL m6 = new MockBRL("BRL1", "BRL1", 6);
        vm.etch(s.BRZ(), address(m18).code);
        vm.etch(s.BRLA(), address(m18).code);
        vm.etch(s.BRL1(), address(m6).code);
        vm.etch(s.WBRL(), address(m18).code);
        vm.etch(s.WETH(), address(m18).code);
        vm.etch(s.WPOL(), address(m18).code);
        _feed(s.FEED_ETH_USD(), "ETH / USD", 2_500e8);
        _feed(s.FEED_POL_USD(), "POL / USD", 0.12e8);
        _feed(s.FEED_BRL_USD(), "BRL / USD", 0.18e8);
        vm.etch(s.FABRICA_V3(), address(new FabricaVazia()).code);
        DeployPolygon.Implantacao memory a = s.run();
        assertEq(ReservaBRL(a.reserva).listaLastros().length, 4);
        assertEq(CofreCripto(a.cofre).ativo(0).tetoDivida, 500e18);
        (uint256 preco, bool ok) = CofreCripto(a.cofre).precoBrl(0);
        assertTrue(ok);
        assertApproxEqRel(preco, 13_888.888888e18, 1e12);
    }

    function test_DeployPolygonAbortaComFeedErrado() public {
        vm.chainId(137);
        DeployPolygon s = new DeployPolygon();
        _feed(s.FEED_ETH_USD(), "BTC / USD", 2_500e8);
        vm.expectRevert(bytes("feed errado"));
        s.run();
    }

    function _feed(address alvo, string memory desc, int256 preco) internal {
        OraculoTeste o = new OraculoTeste(desc, preco);
        vm.etch(alvo, address(o).code);
        vm.copyStorage(address(o), alvo);
    }
}

contract FabricaVazia {
    function getPool(address, address, uint24) external pure returns (address) {
        return address(0);
    }
}
