// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {xBRL} from "../src/xBRL.sol";
import {ReservaBRL} from "../src/ReservaBRL.sol";
import {EscrowTrabalho} from "../src/EscrowTrabalho.sol";
import {DeployPolygon} from "../script/DeployPolygon.s.sol";

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

// =====================================================================
// Base
// =====================================================================

abstract contract Base is Test {
    address internal constant TREASURY = 0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1;

    xBRL internal token;
    ReservaBRL internal reserva;
    EscrowTrabalho internal escrow;
    MockBRL internal brz; // 18 casas
    MockBRL internal brla; // 6 casas (testa normalização)

    address internal alice;
    uint256 internal alicePk;
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal relayer = makeAddr("relayer");
    address internal dono = makeAddr("dono");

    function setUp() public virtual {
        (alice, alicePk) = makeAddrAndKey("alice");
        brz = new MockBRL("BRZ", "BRZ", 18);
        brla = new MockBRL("BRLA", "BRLA", 6);
        token = new xBRL(address(this));
        address[] memory lastros = new address[](2);
        lastros[0] = address(brz);
        lastros[1] = address(brla);
        reserva = new ReservaBRL(address(token), TREASURY, lastros, dono);
        escrow = new EscrowTrabalho(address(token), TREASURY);
        token.inicializar(address(reserva));
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

    /// @dev Faz a reserva crescer dia a dia, equilibrada entre BRZ e BRLA, respeitando o teto diário.
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
        }
    }

    function _lastroCobreSupply() internal view {
        assertGe(reserva.lastroTotal(), token.totalSupply(), "INVARIANTE: lastro < supply");
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
        assertTrue(token.inicializado());
    }

    function test_InicializarSoUmaVez() public {
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        token.inicializar(address(0xBEEF));
    }

    function test_InicializarSoPeloInicializador() public {
        xBRL t = new xBRL(carol);
        vm.prank(bob);
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        t.inicializar(address(0xBEEF));
        vm.prank(carol);
        vm.expectRevert(xBRL.EnderecoZero.selector);
        t.inicializar(address(0));
    }

    function test_ConstrutorRejeitaZero() public {
        vm.expectRevert(xBRL.EnderecoZero.selector);
        new xBRL(address(0));
    }

    function test_SoReservaEmite() public {
        vm.prank(alice);
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        token.mint(alice, 1e18);
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        token.mint(alice, 1e18);
    }

    function testFuzz_TransferenciaSemTaxa(uint96 valor) public {
        _emitirBrz(alice, 5_000e18);
        uint256 v = bound(uint256(valor), 0, token.balanceOf(alice));
        uint256 supply = token.totalSupply();
        vm.prank(alice);
        assertTrue(token.transfer(bob, v));
        assertEq(token.balanceOf(bob), v, "chega integral (compativel com Uniswap)");
        assertEq(token.totalSupply(), supply);
    }

    function test_TransferFromSemTaxa() public {
        _emitirBrz(alice, 1_000e18);
        vm.prank(alice);
        token.approve(carol, 50e18);
        vm.prank(carol);
        assertTrue(token.transferFrom(alice, bob, 50e18));
        assertEq(token.balanceOf(bob), 50e18);
        assertEq(token.allowance(alice, carol), 0);
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
        bytes32 digest = token.hashTransferWithGas(p, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
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
        bytes memory sig = _assinar(p, alicePk, token.nonces(alice));
        vm.prank(relayer);
        token.transferWithGas(p, sig);
        assertEq(token.balanceOf(bob), 100e18);
        assertEq(token.balanceOf(relayer), 1e18);
        assertEq(token.balanceOf(alice), 999e18 - 101e18);
        assertEq(token.nonces(alice), 1);

        vm.prank(relayer);
        vm.expectRevert(xBRL.AssinaturaInvalida.selector);
        token.transferWithGas(p, sig);
    }

    function test_TransferWithGasQualquerRelayer() public {
        _emitirBrz(alice, 1_000e18);
        xBRL.PedidoComGas memory p = xBRL.PedidoComGas({
            de: alice,
            para: bob,
            valor: 10e18,
            relayer: address(0),
            taxaGas: 0,
            deadline: block.timestamp + 60
        });
        bytes memory sig = _assinar(p, alicePk, 0);
        vm.prank(carol);
        token.transferWithGas(p, sig);
        assertEq(token.balanceOf(bob), 10e18);
        assertEq(token.balanceOf(carol), 0);
    }

    function test_TransferWithGasExpirado() public {
        _emitirBrz(alice, 1_000e18);
        xBRL.PedidoComGas memory p = xBRL.PedidoComGas({
            de: alice, para: bob, valor: 10e18, relayer: relayer, taxaGas: 0, deadline: block.timestamp + 60
        });
        bytes memory sig = _assinar(p, alicePk, 0);
        vm.warp(block.timestamp + 61);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(xBRL.AssinaturaExpirada.selector, p.deadline));
        token.transferWithGas(p, sig);
    }

    function test_TransferWithGasRelayerErrado() public {
        _emitirBrz(alice, 1_000e18);
        xBRL.PedidoComGas memory p = xBRL.PedidoComGas({
            de: alice,
            para: bob,
            valor: 10e18,
            relayer: relayer,
            taxaGas: 1e18,
            deadline: block.timestamp + 60
        });
        bytes memory sig = _assinar(p, alicePk, 0);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(xBRL.RelayerNaoAutorizado.selector, relayer, carol));
        token.transferWithGas(p, sig);
    }

    function test_TransferWithGasAssinaturaDeOutro() public {
        _emitirBrz(alice, 1_000e18);
        (, uint256 outroPk) = makeAddrAndKey("intruso");
        xBRL.PedidoComGas memory p = xBRL.PedidoComGas({
            de: alice,
            para: bob,
            valor: 10e18,
            relayer: address(0),
            taxaGas: 0,
            deadline: block.timestamp + 60
        });
        bytes memory sig = _assinar(p, outroPk, 0);
        vm.expectRevert(xBRL.AssinaturaInvalida.selector);
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
    function test_EmitirFase1() public {
        uint256 liquido = _emitirBrz(alice, 1_000e18);
        assertEq(liquido, 999e18);
        assertEq(token.balanceOf(alice), 999e18);
        assertEq(token.balanceOf(TREASURY), 1e18);
        assertEq(token.totalSupply(), 1_000e18);
        assertEq(brz.balanceOf(address(reserva)), 1_000e18);
        assertEq(reserva.fase(), 1);
        assertEq(reserva.colateralizacaoBps(), 10_000);
    }

    function test_ColateralizacaoSemSupply() public view {
        assertEq(reserva.colateralizacaoBps(), type(uint256).max);
        assertEq(reserva.resgateDisponivelNaJanela(), type(uint256).max);
        assertEq(reserva.emissaoDisponivelNaJanela(address(brz)), 50_000e18);
    }

    function test_EmitirSeisCasas() public {
        assertEq(_emitirBrla(alice, 1_000e6), 999e18);
        assertEq(reserva.lastroTotal(), 1_000e18);
    }

    function test_CotacoesBatemComExecucao() public {
        (uint256 l, uint256 t, uint256 s) = reserva.cotarEmissao(address(brz), 250e18);
        assertEq(l, 249.75e18);
        assertEq(t, 0.25e18);
        assertEq(s, 0);
        assertEq(_emitirBrz(alice, 250e18), l);
        (uint256 pago,,) = reserva.cotarResgate(address(brz), 100e18);
        vm.startPrank(alice);
        token.approve(address(reserva), 100e18);
        assertEq(reserva.resgatar(address(brz), 100e18, 0), pago);
        vm.stopPrank();
    }

    function test_ResgatarFase1() public {
        _emitirBrz(alice, 1_000e18);
        vm.startPrank(alice);
        token.approve(address(reserva), 500e18);
        uint256 pago = reserva.resgatar(address(brz), 500e18, 499.5e18);
        vm.stopPrank();
        assertEq(pago, 499.5e18);
        assertEq(brz.balanceOf(alice), 499.5e18);
        assertEq(token.balanceOf(TREASURY), 1.5e18);
        assertEq(token.totalSupply(), 500.5e18);
        _lastroCobreSupply();
    }

    function test_ResgatarSeisCasasArredondaAFavorDaReserva() public {
        _emitirBrla(alice, 1_000e6);
        vm.startPrank(alice);
        token.approve(address(reserva), type(uint256).max);
        assertEq(reserva.resgatar(address(brla), 1e18 + 123, 0), 999_000);
        vm.stopPrank();
        _lastroCobreSupply();
    }

    function test_ResgatePoReverte() public {
        _emitirBrla(alice, 1_000e6);
        vm.startPrank(alice);
        token.approve(address(reserva), type(uint256).max);
        vm.expectRevert(ReservaBRL.ValorZero.selector);
        reserva.resgatar(address(brla), 1e9, 0);
        vm.expectRevert(ReservaBRL.ValorZero.selector);
        reserva.resgatar(address(brla), 0, 0);
        vm.stopPrank();
    }

    function test_ResgateLastroInsuficiente() public {
        _emitirBrz(alice, 1_000e18);
        vm.startPrank(alice);
        token.approve(address(reserva), 100e18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroInsuficiente.selector, 0, 99_900_000));
        reserva.resgatar(address(brla), 100e18, 0);
        vm.stopPrank();
    }

    function test_SaidaMinima() public {
        brz.mint(alice, 100e18);
        vm.startPrank(alice);
        brz.approve(address(reserva), 100e18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.SaidaMinimaNaoAtingida.selector, 99.9e18, 100e18));
        reserva.emitir(address(brz), 100e18, 100e18);
        vm.stopPrank();
    }

    function test_EmitirZeroOuDesconhecido() public {
        vm.expectRevert(ReservaBRL.ValorZero.selector);
        reserva.emitir(address(brz), 0, 0);
        MockBRL x = new MockBRL("X", "X", 18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroDesconhecido.selector, address(x)));
        reserva.emitir(address(x), 1e18, 0);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroDesconhecido.selector, address(x)));
        reserva.cotarEmissao(address(x), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroDesconhecido.selector, address(x)));
        reserva.cotarResgate(address(x), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroDesconhecido.selector, address(x)));
        reserva.emissaoDisponivelNaJanela(address(x));
    }

    function test_PausaEmissaoNaoBloqueiaResgate() public {
        _emitirBrz(alice, 1_000e18);
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
        reserva.resgatar(address(brz), 999e18, 0);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 0);
    }

    function test_SoDonoPausa() public {
        vm.prank(bob);
        vm.expectRevert();
        reserva.definirEmissaoAtiva(address(brz), false);
        vm.prank(dono);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroDesconhecido.selector, address(0xABC)));
        reserva.definirEmissaoAtiva(address(0xABC), false);
    }

    function test_ListaDeLastrosImutavel() public {
        // Não existe nenhuma função para adicionar lastro: chamadas com esses seletores falham.
        MockBRL falso = new MockBRL("FAKE", "FAKE", 18);
        vm.startPrank(dono);
        (bool ok1,) = address(reserva).call(abi.encodeWithSignature("proporLastro(address)", address(falso)));
        (bool ok2,) = address(reserva).call(abi.encodeWithSignature("ativarLastro(address)", address(falso)));
        vm.stopPrank();
        assertFalse(ok1);
        assertFalse(ok2);
        assertEq(reserva.listaLastros().length, 2);
    }

    function test_ConstrutorValidaLastros() public {
        address[] memory vazio = new address[](0);
        vm.expectRevert(ReservaBRL.QuantidadeDeLastrosInvalida.selector);
        new ReservaBRL(address(token), TREASURY, vazio, dono);

        address[] memory nove = new address[](9);
        vm.expectRevert(ReservaBRL.QuantidadeDeLastrosInvalida.selector);
        new ReservaBRL(address(token), TREASURY, nove, dono);

        address[] memory dup = new address[](2);
        dup[0] = address(brz);
        dup[1] = address(brz);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroJaExiste.selector, address(brz)));
        new ReservaBRL(address(token), TREASURY, dup, dono);

        address[] memory ruim = new address[](1);
        ruim[0] = address(new MockBRL("R", "R", 24));
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.DecimaisInvalidos.selector, 24));
        new ReservaBRL(address(token), TREASURY, ruim, dono);

        address[] memory zero = new address[](1);
        vm.expectRevert(ReservaBRL.EnderecoZero.selector);
        new ReservaBRL(address(token), TREASURY, zero, dono);
    }

    function test_LastroComTaxaNaTransferencia() public {
        MockTaxado tax = new MockTaxado();
        address[] memory l = new address[](1);
        l[0] = address(tax);
        xBRL t2 = new xBRL(address(this));
        ReservaBRL r2 = new ReservaBRL(address(t2), TREASURY, l, dono);
        t2.inicializar(address(r2));
        tax.mint(alice, 100e18);
        vm.startPrank(alice);
        tax.approve(address(r2), 100e18);
        assertEq(r2.emitir(address(tax), 100e18, 0), 98.901e18); // entrou 99 → 99 - 0,099
        vm.stopPrank();
        assertGe(r2.lastroTotal(), t2.totalSupply());
    }

    function test_SpreadDeConcentracaoViraLastroExtra() public {
        _emitirBrz(alice, 5_000e18); // reserva < 10.000: sem spread
        assertEq(token.balanceOf(alice), 4_995e18);
        // Tudo em BRZ (100% > 60%): spread máximo de 0,40%
        (uint256 l, uint256 t, uint256 s) = reserva.cotarEmissao(address(brz), 10_000e18);
        assertEq(t, 10e18);
        assertEq(s, 40e18);
        assertEq(l, 9_950e18);
        assertEq(_emitirBrz(carol, 10_000e18), 9_950e18);
        assertEq(reserva.lastroTotal() - token.totalSupply(), 40e18, "spread fica como lastro a mais");

        // Quem traz o lastro que falta (BRLA, abaixo de 50%) não paga spread
        (,, s) = reserva.cotarEmissao(address(brla), 10_000e6);
        assertEq(s, 0);
        assertEq(_emitirBrla(bob, 10_000e6), 9_990e18);
        _lastroCobreSupply();
    }

    function test_SpreadNoResgateDoLastroEscasso() public {
        _emitirBrz(alice, 15_000e18);
        _emitirBrla(bob, 10_000e6);
        // Resgatar BRLA (vai ficar abaixo do alvo de 50%) paga spread; resgatar BRZ (acima) não.
        (uint256 pagoBrla,, uint256 sBrla) = reserva.cotarResgate(address(brla), 5_000e18);
        (uint256 pagoBrz,, uint256 sBrz) = reserva.cotarResgate(address(brz), 5_000e18);
        assertGt(sBrla, 0);
        assertLe(sBrla, (4_995e18 * 40) / 10_000);
        assertEq(sBrz, 0);
        assertEq(pagoBrz, 4_995e18);
        assertLt(pagoBrla * 1e12, 4_995e18);
        vm.startPrank(bob);
        token.approve(address(reserva), 5_000e18);
        assertEq(reserva.resgatar(address(brla), 5_000e18, 0), pagoBrla);
        vm.stopPrank();
        _lastroCobreSupply();
    }

    function test_TetoDiarioDeEmissaoPorLastro() public {
        _emitirBrz(alice, 50_000e18);
        assertEq(reserva.emissaoDisponivelNaJanela(address(brz)), 0);
        brz.mint(alice, 1e18);
        vm.startPrank(alice);
        brz.approve(address(reserva), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LimiteEmissaoDiaria.selector, 0));
        reserva.emitir(address(brz), 1e18, 0);
        vm.stopPrank();

        // O teto é por lastro: BRLA segue livre
        _emitirBrla(bob, 1_000e6);
        // Depois de 24 h, BRZ volta
        vm.warp(block.timestamp + 1 days);
        _emitirBrz(alice, 1e18);
        _lastroCobreSupply();
    }

    function test_TetoDiarioCresceComAReserva() public {
        _crescerAte(alice, 1_000_000e18);
        uint256 total = reserva.lastroTotal();
        vm.warp(block.timestamp + 1 days);
        assertEq(reserva.emissaoDisponivelNaJanela(address(brz)), (total * 1_000) / 10_000);
    }

    function test_LastroQuePerdeParidadeNaoDrenaOOutroDeUmaVez() public {
        _crescerAte(alice, 1_000_000e18);
        vm.warp(block.timestamp + 1 days);
        uint256 brlaAntes = brla.balanceOf(address(reserva));
        // Atacante tem BRZ "podre" ilimitado e tenta trocar por BRLA bom num só dia.
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
        assertLe(drenado, (reserva.lastroTotal() * 1_200) / 10_000, "no maximo ~10% da reserva por dia");
        _lastroCobreSupply();
    }

    function test_Fase2JanelaDeResgate() public {
        _crescerAte(alice, 1_200_000e18);
        assertEq(reserva.fase(), 2);
        uint256 limite = (token.totalSupply() * 2_000) / 10_000;
        assertEq(reserva.resgateDisponivelNaJanela(), limite);
        vm.startPrank(alice);
        token.approve(address(reserva), type(uint256).max);
        reserva.resgatar(address(brz), 100_000e18, 0); // queima 99.900
        uint256 disponivel = limite - 99_900e18;
        assertEq(reserva.resgateDisponivelNaJanela(), disponivel);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LimiteJanelaResgate.selector, disponivel));
        reserva.resgatar(address(brz), disponivel + 1_000e18, 0);
        vm.warp(block.timestamp + 1 days);
        reserva.resgatar(address(brz), 100_000e18, 0);
        vm.stopPrank();
        _lastroCobreSupply();
    }

    function testFuzz_InvarianteLastro(uint96 a, uint96 b, uint96 r1, uint96 r2) public {
        uint256 va = bound(uint256(a), 1e15, 50_000e18);
        uint256 vb = bound(uint256(b), 1, 50_000e6);
        _emitirBrz(alice, va);
        _emitirBrla(alice, vb);
        _lastroCobreSupply();
        vm.startPrank(alice);
        token.approve(address(reserva), type(uint256).max);
        uint256 saldo = token.balanceOf(alice);
        uint256 x = bound(uint256(r1), 0, saldo / 3);
        uint256 y = bound(uint256(r2), 0, saldo / 3);
        if (x > 1e13) {
            try reserva.resgatar(address(brz), x, 0) {} catch {}
        }
        if (y > 1e13) {
            try reserva.resgatar(address(brla), y, 0) {} catch {}
        }
        vm.stopPrank();
        _lastroCobreSupply();
    }
}

/// @dev Handler para teste de invariante com sequências aleatórias de emissões, resgates e transferências.
contract HandlerReserva is Test {
    ReservaBRL internal reserva;
    xBRL internal token;
    MockBRL internal brz;
    MockBRL internal brla;
    address[] internal atores;

    constructor(ReservaBRL r, xBRL t, MockBRL a, MockBRL b) {
        reserva = r;
        token = t;
        brz = a;
        brla = b;
        atores.push(address(0xA1));
        atores.push(address(0xA2));
        atores.push(address(0xA3));
    }

    function emitir(uint256 ator, bool usaBrz, uint256 valor) external {
        address quem = atores[ator % atores.length];
        MockBRL l = usaBrz ? brz : brla;
        valor = usaBrz ? bound(valor, 1e12, 60_000e18) : bound(valor, 1, 60_000e6);
        l.mint(quem, valor);
        vm.startPrank(quem);
        l.approve(address(reserva), valor);
        try reserva.emitir(address(l), valor, 0) {} catch {}
        vm.stopPrank();
    }

    function resgatar(uint256 ator, bool usaBrz, uint256 valor) external {
        address quem = atores[ator % atores.length];
        uint256 saldo = token.balanceOf(quem);
        if (saldo < 1e13) return;
        valor = bound(valor, 1e13, saldo);
        vm.startPrank(quem);
        token.approve(address(reserva), valor);
        try reserva.resgatar(address(usaBrz ? brz : brla), valor, 0) {} catch {}
        vm.stopPrank();
    }

    function transferir(uint256 de, uint256 para, uint256 valor) external {
        address a = atores[de % atores.length];
        address b = atores[para % atores.length];
        valor = bound(valor, 0, token.balanceOf(a));
        vm.prank(a);
        assertTrue(token.transfer(b, valor));
    }

    function passarTempo(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 2 days));
    }
}

contract ReservaInvarianteTest is Base {
    HandlerReserva internal handler;

    function setUp() public override {
        super.setUp();
        handler = new HandlerReserva(reserva, token, brz, brla);
        targetContract(address(handler));
    }

    function invariant_LastroSempreCobreSupply() public view {
        _lastroCobreSupply();
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
    string internal constant CHEGADA = "porta janela cadeira mesa tapete";
    string internal constant CODIGO = "vogal imunizar nordeste sapato haver";

    function setUp() public override {
        super.setUp();
        cliente = carol;
        trab = bob;
        deal(address(token), cliente, 1_000_000e18, true);
        vm.prank(cliente);
        token.approve(address(escrow), type(uint256).max);
    }

    function _novoDe(
        address quem,
        EscrowTrabalho.Modalidade m,
        address t,
        uint128 valor,
        uint8 etapas,
        bytes32 codigoHash,
        bytes32 chegadaHash
    ) internal returns (uint256 id) {
        EscrowTrabalho.NovoTrabalho memory p = EscrowTrabalho.NovoTrabalho({
            modalidade: m,
            trabalhador: t,
            valor: valor,
            prazo: uint64(block.timestamp + 7 days),
            etapas: etapas,
            codigoHash: codigoHash,
            chegadaHash: chegadaHash,
            descricao: "Faxina completa, 3 quartos"
        });
        vm.prank(quem);
        id = escrow.criarTrabalho(p);
    }

    function _novo(EscrowTrabalho.Modalidade m, address t, uint128 valor, uint8 etapas, bytes32 codigoHash)
        internal
        returns (uint256)
    {
        bytes32 ch =
            m == EscrowTrabalho.Modalidade.Presencial ? escrow.hashChegada(cliente, CHEGADA) : bytes32(0);
        return _novoDe(cliente, m, t, valor, etapas, codigoHash, ch);
    }

    function _estado(uint256 id) internal view returns (EscrowTrabalho.Estado) {
        return escrow.trabalho(id).estado;
    }

    function _concluirRemoto(address c, address t, uint128 valor) internal returns (uint256 id) {
        id = _novoDe(c, EscrowTrabalho.Modalidade.Remoto, t, valor, 1, 0, 0);
        vm.prank(t);
        escrow.aceitar(id);
        vm.prank(c);
        escrow.liberar(id);
    }

    // ---------------- Chegada por código (sem GPS) ----------------

    function test_PresencialExigeCodigoDeChegada() public {
        vm.expectRevert(EscrowTrabalho.CodigoObrigatorio.selector);
        _novoDe(cliente, EscrowTrabalho.Modalidade.Presencial, trab, 1e18, 1, 0, 0);
        vm.expectRevert(EscrowTrabalho.ModalidadeInvalida.selector);
        _novoDe(cliente, EscrowTrabalho.Modalidade.Remoto, trab, 1e18, 1, 0, keccak256("x"));
    }

    function test_ChegadaComCodigoErradoOuDeOutroDominio() public {
        bytes32 h = escrow.hashCodigo(cliente, CODIGO);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18, 1, h);
        vm.startPrank(trab);
        escrow.aceitar(id);
        vm.expectRevert(EscrowTrabalho.CodigoIncorreto.selector);
        escrow.confirmarChegada(id, "porta janela cadeira mesa sofa");
        // O código de LIBERAÇÃO não serve como código de CHEGADA (domínios separados)
        assertTrue(escrow.hashChegada(cliente, CODIGO) != h);
        vm.expectRevert(EscrowTrabalho.ChegadaObrigatoria.selector);
        escrow.confirmarComCodigo(id, CODIGO);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.confirmarChegada(id, CHEGADA);
    }

    function test_FluxoPresencialComAprovacao() public {
        uint256 treasuryAntes = token.balanceOf(TREASURY);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18, 1, 0);
        assertEq(token.balanceOf(address(escrow)), 100e18);

        vm.startPrank(trab);
        escrow.aceitar(id);
        vm.expectRevert(EscrowTrabalho.ChegadaObrigatoria.selector);
        escrow.marcarEntregue(id);
        escrow.confirmarChegada(id, CHEGADA);
        assertTrue(escrow.trabalho(id).chegou);
        escrow.marcarEntregue(id);
        vm.stopPrank();

        vm.prank(cliente);
        escrow.liberar(id);
        assertEq(token.balanceOf(trab), 99.9e18);
        assertEq(token.balanceOf(TREASURY) - treasuryAntes, 0.1e18);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Concluido));
        assertEq(escrow.nivel(trab), 1);
    }

    function test_FluxoPresencialComCodigoDeLiberacao() public {
        bytes32 h = escrow.hashCodigo(cliente, CODIGO);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18, 1, h);
        vm.startPrank(trab);
        escrow.aceitar(id);
        escrow.confirmarChegada(id, CHEGADA);
        escrow.confirmarComCodigo(id, CODIGO);
        vm.stopPrank();
        assertEq(token.balanceOf(trab), 99.9e18);
    }

    function test_FluxoEntregaComCodigoVagaAberta() public {
        bytes32 h = escrow.hashCodigo(cliente, CODIGO);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Entrega, address(0), 25e18, 1, h);

        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.aceitar(id);

        vm.startPrank(trab);
        escrow.aceitar(id); // entrega começa direto: sem o código ninguém recebe
        vm.expectRevert(EscrowTrabalho.ModalidadeInvalida.selector);
        escrow.marcarEntregue(id);
        vm.expectRevert(EscrowTrabalho.ModalidadeInvalida.selector);
        escrow.confirmarChegada(id, CHEGADA);
        vm.expectRevert(EscrowTrabalho.CodigoIncorreto.selector);
        escrow.confirmarComCodigo(id, "vogal imunizar nordeste sapato havia");
        vm.stopPrank();

        vm.prank(relayer); // qualquer pessoa submete; o dinheiro vai para o trabalhador
        escrow.confirmarComCodigo(id, CODIGO);
        assertEq(token.balanceOf(trab), 24.975e18);
        assertEq(token.balanceOf(relayer), 0);
    }

    function test_EntregaExigeCodigo() public {
        vm.expectRevert(EscrowTrabalho.CodigoObrigatorio.selector);
        _novo(EscrowTrabalho.Modalidade.Entrega, trab, 1e18, 1, 0);
    }

    function test_FluxoRemotoComReivindicacao() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 300e18, 1, 0);
        vm.startPrank(trab);
        escrow.aceitar(id);
        vm.expectRevert(EscrowTrabalho.ModalidadeInvalida.selector);
        escrow.confirmarChegada(id, CHEGADA);
        escrow.marcarEntregue(id);
        uint256 libera = block.timestamp + 3 days;
        vm.expectRevert(abi.encodeWithSelector(EscrowTrabalho.RevisaoEmAndamento.selector, libera));
        escrow.reivindicar(id);
        vm.warp(libera);
        escrow.reivindicar(id);
        vm.stopPrank();
        assertEq(token.balanceOf(trab), 299.7e18);
    }

    function test_FluxoRemotoComCodigo() public {
        bytes32 h = escrow.hashCodigo(cliente, CODIGO);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 10e18, 1, h);
        vm.prank(trab);
        escrow.aceitar(id);
        escrow.confirmarComCodigo(id, CODIGO);
        assertEq(token.balanceOf(trab), 9.99e18);
    }

    function test_FluxoEtapas() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Etapas, trab, 100e18, 3, 0);
        vm.prank(trab);
        escrow.aceitar(id);
        vm.prank(cliente);
        escrow.liberar(id);
        assertEq(escrow.trabalho(id).etapasPagas, 1);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Aceito));
        vm.startPrank(trab);
        escrow.marcarEntregue(id);
        vm.warp(block.timestamp + 3 days);
        escrow.reivindicar(id);
        vm.stopPrank();
        vm.prank(trab);
        escrow.marcarEntregue(id);
        vm.prank(cliente);
        escrow.liberar(id);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Concluido));
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(trab), 99.9e18 + 1);
    }

    function test_EtapasValidacoes() public {
        vm.expectRevert(EscrowTrabalho.EtapasInvalidas.selector);
        _novo(EscrowTrabalho.Modalidade.Etapas, trab, 100e18, 1, 0);
        vm.expectRevert(EscrowTrabalho.EtapasInvalidas.selector);
        _novo(EscrowTrabalho.Modalidade.Etapas, trab, 100e18, 51, 0);
        vm.expectRevert(EscrowTrabalho.EtapasInvalidas.selector);
        _novo(EscrowTrabalho.Modalidade.Remoto, trab, 100e18, 2, 0);
        vm.expectRevert(EscrowTrabalho.ModalidadeInvalida.selector);
        _novo(EscrowTrabalho.Modalidade.Etapas, trab, 100e18, 2, keccak256("x"));
    }

    function test_ValidacoesDeCriacao() public {
        vm.expectRevert(EscrowTrabalho.ValorZero.selector);
        _novo(EscrowTrabalho.Modalidade.Remoto, trab, 0, 1, 0);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        _novo(EscrowTrabalho.Modalidade.Remoto, cliente, 1e18, 1, 0);
        EscrowTrabalho.NovoTrabalho memory p = EscrowTrabalho.NovoTrabalho({
            modalidade: EscrowTrabalho.Modalidade.Remoto,
            trabalhador: trab,
            valor: 1e18,
            prazo: uint64(block.timestamp),
            etapas: 1,
            codigoHash: 0,
            chegadaHash: 0,
            descricao: ""
        });
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.PrazoInvalido.selector);
        escrow.criarTrabalho(p);
        vm.expectRevert(EscrowTrabalho.TrabalhoInexistente.selector);
        escrow.aceitar(999);
    }

    function test_VagaAbertaRemotaExigeAprovacaoDoCliente() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, address(0), 100e18, 1, 0);
        vm.prank(trab);
        escrow.aceitar(id);
        EscrowTrabalho.Trabalho memory t = escrow.trabalho(id);
        assertTrue(t.pendenteAprovacao);
        assertEq(uint8(t.estado), uint8(EscrowTrabalho.Estado.Aberto));

        vm.startPrank(trab);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowTrabalho.EstadoInvalido.selector, EscrowTrabalho.Estado.Aberto)
        );
        escrow.marcarEntregue(id);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowTrabalho.EstadoInvalido.selector, EscrowTrabalho.Estado.Aberto)
        );
        escrow.abrirDisputa(id);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.aceitar(id);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.decidirCandidato(id, true);
        vm.prank(cliente);
        escrow.decidirCandidato(id, false);
        assertEq(escrow.trabalho(id).trabalhador, address(0));

        vm.prank(alice);
        escrow.aceitar(id);
        vm.prank(alice);
        escrow.desistir(id);
        assertEq(uint8(escrow.trabalho(id).estado), uint8(EscrowTrabalho.Estado.Aberto));
        vm.prank(trab);
        escrow.aceitar(id);
        vm.prank(cliente);
        escrow.decidirCandidato(id, true);
        assertEq(uint8(escrow.trabalho(id).estado), uint8(EscrowTrabalho.Estado.Aceito));
        vm.prank(cliente);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowTrabalho.EstadoInvalido.selector, EscrowTrabalho.Estado.Aceito)
        );
        escrow.decidirCandidato(id, true);
        assertEq(token.balanceOf(address(escrow)), 100e18, "nada saiu do escrow");
    }

    function test_DesignadoSoEleAceita() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 1e18, 1, 0);
        vm.prank(alice);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.aceitar(id);
        vm.prank(trab);
        escrow.aceitar(id);
        vm.prank(trab);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowTrabalho.EstadoInvalido.selector, EscrowTrabalho.Estado.Aceito)
        );
        escrow.aceitar(id);
    }

    function test_CancelarAntesDoAceite() public {
        uint256 saldo = token.balanceOf(cliente);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, address(0), 50e18, 1, 0);
        vm.prank(trab);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.cancelar(id);
        vm.prank(cliente);
        escrow.cancelar(id);
        assertEq(token.balanceOf(cliente), saldo);
        vm.prank(trab);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowTrabalho.EstadoInvalido.selector, EscrowTrabalho.Estado.Cancelado)
        );
        escrow.aceitar(id);
    }

    function test_CancelarDepoisDoAceiteNaoPode() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 50e18, 1, 0);
        vm.prank(trab);
        escrow.aceitar(id);
        vm.prank(cliente);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowTrabalho.EstadoInvalido.selector, EscrowTrabalho.Estado.Aceito)
        );
        escrow.cancelar(id);
    }

    function test_TrabalhadorDesiste() public {
        uint256 saldo = token.balanceOf(cliente);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 50e18, 1, 0);
        vm.startPrank(trab);
        escrow.aceitar(id);
        escrow.desistir(id);
        vm.stopPrank();
        assertEq(token.balanceOf(cliente), saldo);
    }

    function test_ReembolsoPorPrazoVencido() public {
        uint256 saldo = token.balanceOf(cliente);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Etapas, trab, 90e18, 3, 0);
        vm.prank(trab);
        escrow.aceitar(id);
        vm.prank(cliente);
        escrow.liberar(id);
        uint256 prazo = escrow.trabalho(id).prazo;
        vm.prank(cliente);
        vm.expectRevert(abi.encodeWithSelector(EscrowTrabalho.PrazoNaoVencido.selector, prazo));
        escrow.reembolsarPorPrazo(id);
        vm.warp(prazo + 1);
        vm.prank(cliente);
        escrow.reembolsarPorPrazo(id);
        assertEq(token.balanceOf(cliente), saldo - 30e18);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_DisputaComAcordo() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 100e18, 1, 0);
        uint256 saldo = token.balanceOf(cliente);
        vm.prank(trab);
        escrow.aceitar(id);
        vm.prank(alice);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.abrirDisputa(id);
        vm.prank(cliente);
        escrow.abrirDisputa(id);
        vm.prank(trab);
        escrow.proporAcordo(id, 8_000);
        vm.prank(cliente);
        escrow.proporAcordo(id, 6_000);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Disputa));
        vm.prank(trab);
        escrow.proporAcordo(id, 7_000);
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.BpsInvalido.selector);
        escrow.proporAcordo(id, 10_001);
        vm.prank(cliente);
        escrow.proporAcordo(id, 7_000);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Concluido));
        assertEq(token.balanceOf(trab), 69.93e18);
        assertEq(token.balanceOf(cliente), saldo + 30e18);
        (, uint32 disputas,,,,,) = escrow.reputacao(trab);
        assertEq(disputas, 1);
    }

    function test_DisputaPorTempoDivideMeioAMeio() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18, 1, 0);
        uint256 saldo = token.balanceOf(cliente);
        vm.prank(trab);
        escrow.aceitar(id);
        vm.prank(trab);
        escrow.abrirDisputa(id);
        vm.expectRevert();
        escrow.resolverPorTempo(id);
        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        escrow.resolverPorTempo(id);
        assertEq(token.balanceOf(trab), 49.95e18);
        assertEq(token.balanceOf(cliente), saldo + 50e18);
    }

    // ---------------- Reputação anti-contas-falsas ----------------

    function test_NivelExigeContrapartesVolumeEIdade() public {
        for (uint256 i = 0; i < 5; ++i) {
            address c = makeAddr(string(abi.encodePacked("cliente", i)));
            deal(address(token), c, 1_000e18, true);
            vm.prank(c);
            token.approve(address(escrow), type(uint256).max);
            uint256 id = _concluirRemoto(c, trab, 100e18);
            vm.prank(c);
            escrow.avaliar(id, 4);
        }
        (uint32 conc,, uint32 aval, uint32 contra, uint64 soma, uint64 desde, uint128 volume) =
            escrow.reputacao(trab);
        assertEq(conc, 5);
        assertEq(aval, 5);
        assertEq(contra, 5);
        assertEq(soma, 20);
        assertEq(desde, block.timestamp);
        assertEq(volume, 500e18);
        assertEq(escrow.nivel(trab), 1, "conta nova: idade minima de 14 dias");
        vm.warp(block.timestamp + 14 days);
        assertEq(escrow.nivel(trab), 2);
        assertEq(escrow.nivel(alice), 0);
    }

    function test_ContasFalsasRepetindoOMesmoParNaoSobemDeNivel() public {
        for (uint256 i = 0; i < 30; ++i) {
            uint256 id = _concluirRemoto(cliente, trab, 20e18);
            vm.prank(cliente);
            escrow.avaliar(id, 5);
        }
        vm.warp(block.timestamp + 400 days);
        (uint32 conc,, uint32 aval, uint32 contra, uint64 soma,,) = escrow.reputacao(trab);
        assertEq(conc, 30);
        assertEq(contra, 1, "um so parceiro");
        assertEq(aval, 1, "um so avaliador");
        assertEq(soma, 5);
        assertEq(escrow.nivel(trab), 1);
    }

    function test_NotaMaisRecenteDoParSubstituiAAnterior() public {
        uint256 id1 = _concluirRemoto(cliente, trab, 20e18);
        vm.prank(cliente);
        escrow.avaliar(id1, 5);
        uint256 id2 = _concluirRemoto(cliente, trab, 20e18);
        vm.prank(cliente);
        escrow.avaliar(id2, 1);
        (,, uint32 aval,, uint64 soma,,) = escrow.reputacao(trab);
        assertEq(aval, 1);
        assertEq(soma, 1);
    }

    function test_AvaliacaoExigeValorMinimoEUnicaPorTrabalho() public {
        uint256 baixo = _concluirRemoto(cliente, trab, 5e18);
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.ValorBaixoParaAvaliar.selector);
        escrow.avaliar(baixo, 5);

        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 10e18, 1, 0);
        vm.prank(trab);
        escrow.aceitar(id);
        vm.prank(cliente);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowTrabalho.EstadoInvalido.selector, EscrowTrabalho.Estado.Aceito)
        );
        escrow.avaliar(id, 5);
        vm.prank(cliente);
        escrow.liberar(id);
        vm.prank(cliente);
        escrow.avaliar(id, 4);
        vm.prank(trab);
        escrow.avaliar(id, 5);
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.JaAvaliou.selector);
        escrow.avaliar(id, 5);
        vm.prank(alice);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.avaliar(id, 5);
        vm.prank(trab);
        vm.expectRevert(EscrowTrabalho.JaAvaliou.selector);
        escrow.avaliar(id, 5);

        uint256 id2 = _concluirRemoto(cliente, trab, 10e18);
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.EstrelasInvalidas.selector);
        escrow.avaliar(id2, 6);
        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.EstrelasInvalidas.selector);
        escrow.avaliar(id2, 0);
    }
}

// =====================================================================
// Integração ponta a ponta + script de deploy
// =====================================================================

contract IntegracaoTest is Base {
    function test_EcossistemaCompleto() public {
        // 1) Cliente compra xBRL com BRZ
        assertEq(_emitirBrz(carol, 2_000e18), 1_998e18);

        // 2) Contrata entrega com código; bob entrega e recebe
        vm.startPrank(carol);
        token.approve(address(escrow), type(uint256).max);
        bytes32 h = escrow.hashCodigo(carol, "pastel feira moeda tigela viola");
        uint256 id = escrow.criarTrabalho(
            EscrowTrabalho.NovoTrabalho({
                modalidade: EscrowTrabalho.Modalidade.Entrega,
                trabalhador: address(0),
                valor: 1_000e18,
                prazo: uint64(block.timestamp + 1 days),
                etapas: 1,
                codigoHash: h,
                chegadaHash: 0,
                descricao: "Entrega de 50 pasteis"
            })
        );
        vm.stopPrank();
        vm.startPrank(bob);
        escrow.aceitar(id);
        escrow.confirmarComCodigo(id, "pastel feira moeda tigela viola");
        assertEq(token.balanceOf(bob), 999e18);

        // 3) bob resgata em BRZ
        token.approve(address(reserva), 999e18);
        uint256 pago = reserva.resgatar(address(brz), 999e18, 0);
        vm.stopPrank();
        assertEq(brz.balanceOf(bob), pago);
        assertEq(pago, 998.001e18);
        assertEq(token.balanceOf(TREASURY), 2e18 + 1e18 + 0.999e18);
        _lastroCobreSupply();
    }
}

contract DeployScriptTest is Test {
    bytes internal constant FABRICA_CREATE2 =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    function setUp() public {
        if (CREATE2_FACTORY.code.length == 0) vm.etch(CREATE2_FACTORY, FABRICA_CREATE2);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("XBRL_GRAVAR_JSON", "false");
    }

    function test_DeployAmoyDeterministicoEIdempotente() public {
        vm.chainId(80_002);
        DeployPolygon s = new DeployPolygon();
        DeployPolygon.Implantacao memory a = s.run();
        assertTrue(xBRL(a.token).inicializado());
        assertEq(xBRL(a.token).reserva(), a.reserva);
        assertEq(a.lastros.length, 1);
        assertEq(ReservaBRL(a.reserva).owner(), 0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1);

        DeployPolygon.Implantacao memory b = s.run();
        assertEq(a.token, b.token);
        assertEq(a.reserva, b.reserva);
        assertEq(a.escrow, b.escrow);
    }

    function test_DeployMainnetUsaBrzEBrla() public {
        vm.chainId(137);
        address brz = 0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc;
        address brla = 0xE6A537a407488807F0bbeb0038B79004f19DDDFb;
        MockBRL m = new MockBRL("BRZ", "BRZ", 18);
        vm.etch(brz, address(m).code);
        vm.etch(brla, address(m).code);
        DeployPolygon s = new DeployPolygon();
        DeployPolygon.Implantacao memory a = s.run();
        assertEq(a.lastros[0], brz);
        assertEq(a.lastros[1], brla);
        assertEq(ReservaBRL(a.reserva).listaLastros().length, 2);
    }
}
