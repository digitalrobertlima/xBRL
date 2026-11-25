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

    // Praça da Liberdade, Belo Horizonte (microdegraus)
    int32 internal constant LAT = -19_932_000;
    int32 internal constant LON = -43_938_000;

    function setUp() public virtual {
        (alice, alicePk) = makeAddrAndKey("alice");
        brz = new MockBRL("BRZ", "BRZ", 18);
        brla = new MockBRL("BRLA", "BRLA", 6);
        token = new xBRL(TREASURY, address(this));
        address[] memory lastros = new address[](2);
        lastros[0] = address(brz);
        lastros[1] = address(brla);
        reserva = new ReservaBRL(address(token), TREASURY, lastros, dono);
        escrow = new EscrowTrabalho(address(token), TREASURY);
        address[] memory isentos = new address[](1);
        isentos[0] = address(escrow);
        token.inicializar(address(reserva), isentos);
    }

    /// @dev Emite xBRL para `quem` depositando `valor18` de BRZ. Retorna o líquido recebido.
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
        assertEq(token.CREATOR_TREASURY(), TREASURY);
        assertEq(token.TAXA_BPS(), 10);
        assertEq(token.reserva(), address(reserva));
        assertTrue(token.inicializado());
        assertTrue(token.isentoDeTaxa(address(escrow)));
        assertTrue(token.isentoDeTaxa(address(reserva)));
        assertTrue(token.isentoDeTaxa(TREASURY));
        assertFalse(token.isentoDeTaxa(alice));
    }

    function test_InicializarSoUmaVez() public {
        address[] memory vazio = new address[](0);
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        token.inicializar(address(0xBEEF), vazio);
    }

    function test_InicializarSoPeloInicializador() public {
        xBRL t = new xBRL(TREASURY, carol);
        address[] memory vazio = new address[](0);
        vm.prank(bob);
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        t.inicializar(address(0xBEEF), vazio);
        vm.prank(carol);
        vm.expectRevert(xBRL.EnderecoZero.selector);
        t.inicializar(address(0), vazio);
    }

    function test_ConstrutorRejeitaZero() public {
        vm.expectRevert(xBRL.EnderecoZero.selector);
        new xBRL(address(0), carol);
        vm.expectRevert(xBRL.EnderecoZero.selector);
        new xBRL(TREASURY, address(0));
    }

    function test_SoReservaEmite() public {
        vm.prank(alice);
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        token.mint(alice, 1e18);
        vm.expectRevert(xBRL.NaoAutorizado.selector);
        token.mint(alice, 1e18);
    }

    function test_TaxaDeZeroVirgulaUmPorCento() public {
        _emitirBrz(alice, 1_000e18);
        uint256 treasuryAntes = token.balanceOf(TREASURY);
        vm.prank(alice);
        assertTrue(token.transfer(bob, 100e18));
        assertEq(token.balanceOf(bob), 99.9e18);
        assertEq(token.balanceOf(TREASURY) - treasuryAntes, 0.1e18);
        assertEq(token.balanceOf(alice), 999e18 - 100e18);
    }

    function test_TaxaEmTransferFrom() public {
        _emitirBrz(alice, 1_000e18);
        vm.prank(alice);
        token.approve(carol, 50e18);
        vm.prank(carol);
        assertTrue(token.transferFrom(alice, bob, 50e18));
        assertEq(token.balanceOf(bob), 49.95e18);
        assertEq(token.allowance(alice, carol), 0);
    }

    function testFuzz_TaxaConservaValor(uint256 valor) public view {
        valor = bound(valor, 0, type(uint128).max);
        (uint256 liquido, uint256 taxa) = token.previewTransferencia(alice, bob, valor);
        assertEq(liquido + taxa, valor);
        assertEq(taxa, (valor * 10) / 10_000);
        (liquido, taxa) = token.previewTransferencia(alice, address(escrow), valor);
        assertEq(taxa, 0);
        assertEq(liquido, valor);
    }

    function testFuzz_TransferenciaRealConfereComPreview(uint96 valor) public {
        _emitirBrz(alice, 10_000_000e18);
        uint256 v = bound(uint256(valor), 1, 9_000_000e18);
        (uint256 liquido,) = token.previewTransferencia(alice, bob, v);
        uint256 supplyAntes = token.totalSupply();
        vm.prank(alice);
        assertTrue(token.transfer(bob, v));
        assertEq(token.balanceOf(bob), liquido);
        assertEq(token.totalSupply(), supplyAntes, "taxa nao cria nem destroi xBRL");
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
        assertEq(token.balanceOf(bob), 99.9e18);
        assertEq(token.balanceOf(relayer), 0.999e18);
        assertEq(token.balanceOf(alice), 999e18 - 101e18);
        assertEq(token.nonces(alice), 1);

        // replay: o nonce mudou, a assinatura não vale mais
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
        assertEq(token.balanceOf(bob), 9.99e18);
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
    }

    function test_EmitirSeisCasas() public {
        uint256 liquido = _emitirBrla(alice, 1_000e6);
        assertEq(liquido, 999e18);
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
        assertEq(brz.balanceOf(address(reserva)), 500.5e18);
        _lastroCobreSupply();
    }

    function test_ResgatarSeisCasasArredondaAFavorDaReserva() public {
        _emitirBrla(alice, 1_000e6);
        vm.startPrank(alice);
        token.approve(address(reserva), type(uint256).max);
        uint256 pago = reserva.resgatar(address(brla), 1e18 + 123, 0);
        vm.stopPrank();
        // bruto = (1e18+123) - taxa(1e15) = 0.999e18 + 123 → 999000 (6 casas), sobra pó na reserva
        assertEq(pago, 999_000);
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

    function test_NovoLastroSoComPrazoDeSeteDias() public {
        MockBRL novo = new MockBRL("BRL1", "BRL1", 18);
        vm.prank(bob);
        vm.expectRevert();
        reserva.proporLastro(address(novo));

        vm.prank(dono);
        reserva.proporLastro(address(novo));
        vm.prank(dono);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroJaExiste.selector, address(novo)));
        reserva.proporLastro(address(novo));

        uint64 libera = uint64(block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.PrazoNaoCumprido.selector, libera));
        reserva.ativarLastro(address(novo));

        vm.warp(block.timestamp + 7 days);
        vm.prank(carol); // qualquer pessoa ativa
        reserva.ativarLastro(address(novo));
        assertEq(reserva.listaLastros().length, 3);
        (bool aceito, bool emissao, uint8 dec,) = reserva.lastros(address(novo));
        assertTrue(aceito && emissao);
        assertEq(dec, 18);

        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LastroDesconhecido.selector, address(novo)));
        reserva.ativarLastro(address(novo));
    }

    function test_LastroComMaisDe18CasasRejeitado() public {
        MockBRL ruim = new MockBRL("R", "R", 24);
        vm.prank(dono);
        reserva.proporLastro(address(ruim));
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.DecimaisInvalidos.selector, 24));
        reserva.ativarLastro(address(ruim));
    }

    function test_LastroComTaxaNaTransferencia() public {
        MockTaxado tax = new MockTaxado();
        vm.prank(dono);
        reserva.proporLastro(address(tax));
        vm.warp(block.timestamp + 7 days);
        reserva.ativarLastro(address(tax));
        tax.mint(alice, 100e18);
        vm.startPrank(alice);
        tax.approve(address(reserva), 100e18);
        uint256 liquido = reserva.emitir(address(tax), 100e18, 0);
        vm.stopPrank();
        assertEq(liquido, 98.901e18); // entrou 99 → 99 - 0,099
        _lastroCobreSupply();
    }

    function test_Fase2ConcentracaoESpread() public {
        _emitirBrz(alice, 600_000e18);
        assertEq(reserva.fase(), 1);
        _emitirBrla(bob, 600_000e6);
        assertEq(reserva.fase(), 2);

        // BRZ vai a 53,84% (alvo 50%): spread = 100.000 x 384 x 40 / (1000 x 10000) = 153,6
        (uint256 l, uint256 t, uint256 s) = reserva.cotarEmissao(address(brz), 100_000e18);
        assertEq(t, 100e18);
        assertEq(s, 153.6e18);
        assertEq(l, 99_746.4e18);
        assertEq(_emitirBrz(carol, 100_000e18), 99_746.4e18);
        _lastroCobreSupply();
        assertGt(reserva.lastroTotal(), token.totalSupply(), "spread vira sobrecolateral");

        // A partir de 60% o spread trava no máximo (0,40%), sem bloquear ninguém
        (, t, s) = reserva.cotarEmissao(address(brz), 300_000e18);
        assertEq(t, 300e18);
        assertEq(s, 1_200e18);
        assertEq(_emitirBrz(carol, 300_000e18), 298_500e18);
        _lastroCobreSupply();

        // O lastro escasso entra sem spread
        (,, s) = reserva.cotarEmissao(address(brla), 10_000e6);
        assertEq(s, 0);
    }

    function test_Fase2SpreadNoResgateDoLastroEscasso() public {
        _emitirBrz(alice, 700_000e18);
        _emitirBrla(bob, 500_000e6);
        assertEq(reserva.fase(), 2);
        // Resgatar BRLA (já abaixo do alvo de 50%) paga spread; resgatar BRZ (acima) não.
        (uint256 pagoBrla,, uint256 sBrla) = reserva.cotarResgate(address(brla), 10_000e18);
        (uint256 pagoBrz,, uint256 sBrz) = reserva.cotarResgate(address(brz), 10_000e18);
        assertGt(sBrla, 0);
        assertEq(sBrz, 0);
        assertEq(pagoBrz, 9_990e18);
        assertLt(pagoBrla * 1e12, 9_990e18);

        vm.startPrank(bob);
        token.approve(address(reserva), 10_000e18);
        assertEq(reserva.resgatar(address(brla), 10_000e18, 0), pagoBrla);
        vm.stopPrank();
        _lastroCobreSupply();
    }

    function test_Fase2JanelaDeResgate() public {
        _emitirBrz(alice, 600_000e18);
        _emitirBrla(alice, 600_000e6);
        uint256 supply = token.totalSupply(); // 1.200.000
        uint256 limite = (supply * 2_000) / 10_000; // 240.000
        assertEq(reserva.resgateDisponivelNaJanela(), limite);

        vm.startPrank(alice);
        token.approve(address(reserva), type(uint256).max);
        reserva.resgatar(address(brz), 200_000e18, 0); // queima 199.800
        uint256 disponivel = limite - 199_800e18;
        assertEq(reserva.resgateDisponivelNaJanela(), disponivel);
        vm.expectRevert(abi.encodeWithSelector(ReservaBRL.LimiteJanelaResgate.selector, disponivel));
        reserva.resgatar(address(brz), 100_000e18, 0);

        vm.warp(block.timestamp + 1 days);
        reserva.resgatar(address(brz), 100_000e18, 0);
        vm.stopPrank();
        _lastroCobreSupply();
    }

    function testFuzz_InvarianteLastro(uint96 a, uint96 b, uint96 r1, uint96 r2) public {
        uint256 va = bound(uint256(a), 1e15, 2_000_000e18);
        uint256 vb = bound(uint256(b), 1, 2_000_000e6);
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

/// @dev Handler para teste de invariante com sequências aleatórias de emissões e resgates.
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
        valor = usaBrz ? bound(valor, 1e12, 500_000e18) : bound(valor, 1, 500_000e6);
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

    function setUp() public override {
        super.setUp();
        cliente = carol;
        trab = bob;
        _emitirBrz(cliente, 100_000e18);
        vm.prank(cliente);
        token.approve(address(escrow), type(uint256).max);
    }

    function _novo(EscrowTrabalho.Modalidade m, address t, uint128 valor, uint8 etapas, bytes32 codigoHash)
        internal
        returns (uint256 id)
    {
        EscrowTrabalho.NovoTrabalho memory p = EscrowTrabalho.NovoTrabalho({
            modalidade: m,
            trabalhador: t,
            valor: valor,
            prazo: uint64(block.timestamp + 7 days),
            lat: LAT,
            lon: LON,
            etapas: etapas,
            codigoHash: codigoHash,
            descricao: "Faxina completa, 3 quartos"
        });
        vm.prank(cliente);
        id = escrow.criarTrabalho(p);
    }

    function _estado(uint256 id) internal view returns (EscrowTrabalho.Estado) {
        return escrow.trabalho(id).estado;
    }

    // ---------------- GPS ----------------

    function test_DistanciaConhecida() public view {
        // 450 µ° de latitude ≈ 50,04 m
        assertApproxEqAbs(escrow.distanciaMm(LAT, LON, LAT + 450, LON), 50_038, 5);
        // 574 µ° de longitude a -19,93° ≈ 60,0 m (cos ≈ 0,94008)
        assertApproxEqAbs(escrow.distanciaMm(LAT, LON, LAT, LON + 574), 60_002, 60);
        // 1 grau de latitude ≈ 111.195 m
        assertApproxEqAbs(escrow.distanciaMm(0, 0, 1_000_000, 0), 111_195_080, 1);
        // No equador, 1 grau de longitude também
        assertApproxEqAbs(escrow.distanciaMm(0, 0, 0, 1_000_000), 111_195_080, 10);
        assertEq(escrow.distanciaMm(LAT, LON, LAT, LON), 0);
    }

    function testFuzz_DistanciaSimetrica(int32 a, int32 b, int16 da, int16 db) public view {
        int32 lat = int32(bound(int256(a), -80_000_000, 80_000_000));
        int32 lon = int32(bound(int256(b), -179_000_000, 179_000_000));
        int32 lat2 = lat + int32(da);
        int32 lon2 = lon + int32(db);
        uint256 d1 = escrow.distanciaMm(lat, lon, lat2, lon2);
        uint256 d2 = escrow.distanciaMm(lat2, lon2, lat, lon);
        assertEq(d1, d2);
        // Nunca maior que a distância só pela soma dos eixos sem correção de cosseno.
        uint256 absA = uint256(da < 0 ? -int256(da) : int256(da));
        uint256 absB = uint256(db < 0 ? -int256(db) : int256(db));
        uint256 maxMm = ((absA + absB) * 111_196) / 1000 + 1;
        assertLe(d1, maxMm);
    }

    function test_CheckInForaDoRaio() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18, 1, 0);
        vm.startPrank(trab);
        escrow.aceitar(id);
        uint256 d = escrow.distanciaMm(LAT, LON, LAT + 1_079, LON);
        vm.expectRevert(abi.encodeWithSelector(EscrowTrabalho.ForaDoRaio.selector, d));
        escrow.checkIn(id, LAT + 1_079, LON); // ~120 m
        escrow.checkIn(id, LAT + 700, LON + 100); // ~78 m
        vm.stopPrank();
        assertTrue(escrow.trabalho(id).checkin);
    }

    // ---------------- Modalidades ----------------

    function test_FluxoPresencialComAprovacao() public {
        uint256 treasuryAntes = token.balanceOf(TREASURY);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18, 1, 0);
        assertEq(token.balanceOf(address(escrow)), 100e18, "escrow recebe integral");

        vm.startPrank(trab);
        escrow.aceitar(id);
        vm.expectRevert(EscrowTrabalho.CheckInObrigatorio.selector);
        escrow.marcarEntregue(id);
        escrow.checkIn(id, LAT + 450, LON);
        escrow.marcarEntregue(id);
        vm.stopPrank();

        vm.prank(cliente);
        escrow.liberar(id);
        assertEq(token.balanceOf(trab), 99.9e18);
        assertEq(token.balanceOf(TREASURY) - treasuryAntes, 0.1e18);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Concluido));
        (uint32 c,,,) = escrow.reputacao(trab);
        assertEq(c, 1);
        assertEq(escrow.nivel(trab), 1);
    }

    function test_FluxoPresencialComCodigo() public {
        bytes32 h = escrow.hashCodigo(cliente, "ABCD-EFGH-JKLM");
        uint256 id = _novo(EscrowTrabalho.Modalidade.Presencial, trab, 100e18, 1, h);
        vm.startPrank(trab);
        escrow.aceitar(id);
        vm.expectRevert(EscrowTrabalho.CheckInObrigatorio.selector);
        escrow.confirmarComCodigo(id, "ABCD-EFGH-JKLM");
        escrow.checkIn(id, LAT, LON);
        escrow.confirmarComCodigo(id, "ABCD-EFGH-JKLM");
        vm.stopPrank();
        assertEq(token.balanceOf(trab), 99.9e18);
    }

    function test_FluxoEntregaComCodigoVagaAberta() public {
        string memory codigo = "K7Q2-M9XA-4PZD";
        bytes32 h = escrow.hashCodigo(cliente, codigo);
        uint256 id = _novo(EscrowTrabalho.Modalidade.Entrega, address(0), 25e18, 1, h);
        assertTrue(escrow.trabalho(id).codigoHash == h);

        vm.prank(cliente);
        vm.expectRevert(EscrowTrabalho.NaoAutorizado.selector);
        escrow.aceitar(id);

        vm.startPrank(trab);
        escrow.aceitar(id);
        vm.expectRevert(EscrowTrabalho.CheckInObrigatorio.selector);
        escrow.confirmarComCodigo(id, codigo);
        vm.expectRevert(EscrowTrabalho.ModalidadeInvalida.selector);
        escrow.marcarEntregue(id);
        escrow.checkIn(id, LAT - 300, LON + 200);
        vm.expectRevert(EscrowTrabalho.CodigoIncorreto.selector);
        escrow.confirmarComCodigo(id, "K7Q2-M9XA-4PZE");
        vm.stopPrank();

        // Qualquer pessoa pode submeter o código; o dinheiro vai para o trabalhador.
        vm.prank(relayer);
        escrow.confirmarComCodigo(id, codigo);
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
        escrow.checkIn(id, LAT, LON);
        escrow.marcarEntregue(id);
        uint256 libera = block.timestamp + 3 days;
        vm.expectRevert(abi.encodeWithSelector(EscrowTrabalho.RevisaoEmAndamento.selector, libera));
        escrow.reivindicar(id);
        vm.warp(libera);
        escrow.reivindicar(id);
        vm.stopPrank();
        assertEq(token.balanceOf(trab), 299.7e18);
    }

    function test_FluxoRemotoComCodigoSemGps() public {
        bytes32 h = escrow.hashCodigo(cliente, "SENHA-REMOTA-01");
        uint256 id = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 10e18, 1, h);
        vm.prank(trab);
        escrow.aceitar(id);
        escrow.confirmarComCodigo(id, "SENHA-REMOTA-01");
        assertEq(token.balanceOf(trab), 9.99e18);
    }

    function test_FluxoEtapas() public {
        uint256 id = _novo(EscrowTrabalho.Modalidade.Etapas, trab, 100e18, 3, 0);
        vm.prank(trab);
        escrow.aceitar(id);

        // Etapa 1: cliente adianta sem esperar entrega
        vm.prank(cliente);
        escrow.liberar(id);
        assertEq(escrow.trabalho(id).etapasPagas, 1);
        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Aceito));

        // Etapa 2: trabalhador entrega e saca após 3 dias
        vm.startPrank(trab);
        escrow.marcarEntregue(id);
        vm.warp(block.timestamp + 3 days);
        escrow.reivindicar(id);
        vm.stopPrank();

        // Etapa 3 (última leva o resto da divisão)
        vm.prank(trab);
        escrow.marcarEntregue(id);
        vm.prank(cliente);
        escrow.liberar(id);

        assertEq(uint8(_estado(id)), uint8(EscrowTrabalho.Estado.Concluido));
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(trab), 99.9e18 + 1); // taxa arredondada para baixo em cada parcela
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
            modalidade: EscrowTrabalho.Modalidade.Presencial,
            trabalhador: trab,
            valor: 1e18,
            prazo: uint64(block.timestamp),
            lat: LAT,
            lon: LON,
            etapas: 1,
            codigoHash: 0,
            descricao: ""
        });
        vm.startPrank(cliente);
        vm.expectRevert(EscrowTrabalho.PrazoInvalido.selector);
        escrow.criarTrabalho(p);
        p.prazo = uint64(block.timestamp + 1 days);
        p.lat = 91_000_000;
        vm.expectRevert(EscrowTrabalho.CoordenadasInvalidas.selector);
        escrow.criarTrabalho(p);
        vm.stopPrank();

        vm.expectRevert(EscrowTrabalho.TrabalhoInexistente.selector);
        escrow.aceitar(999);
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
        assertEq(token.balanceOf(cliente), saldo, "reembolso integral sem taxa");
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
        escrow.liberar(id); // paga 30
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
        (, uint32 disputas,,) = escrow.reputacao(trab);
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
        vm.prank(alice); // qualquer um executa
        escrow.resolverPorTempo(id);
        assertEq(token.balanceOf(trab), 49.95e18);
        assertEq(token.balanceOf(cliente), saldo + 50e18);
    }

    function test_AvaliacoesENiveis() public {
        for (uint256 i = 0; i < 5; ++i) {
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
            if (i == 0) assertEq(escrow.nivel(trab), 1);
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
        }
        assertEq(escrow.nivel(trab), 2);
        assertEq(escrow.nivel(cliente), 2);
        assertEq(escrow.nivel(alice), 0);
        (uint32 c,, uint32 n, uint64 soma) = escrow.reputacao(trab);
        assertEq(c, 5);
        assertEq(n, 5);
        assertEq(soma, 20);

        uint256 id2 = _novo(EscrowTrabalho.Modalidade.Remoto, trab, 10e18, 1, 0);
        vm.prank(trab);
        escrow.aceitar(id2);
        vm.prank(cliente);
        escrow.liberar(id2);
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
        uint256 xb = _emitirBrz(carol, 2_000e18);
        assertEq(xb, 1_998e18);

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
                lat: LAT,
                lon: LON,
                etapas: 1,
                codigoHash: h,
                descricao: "Entrega de 50 pasteis"
            })
        );
        vm.stopPrank();
        vm.startPrank(bob);
        escrow.aceitar(id);
        escrow.checkIn(id, LAT + 10, LON - 10);
        escrow.confirmarComCodigo(id, "pastel feira moeda tigela viola");
        assertEq(token.balanceOf(bob), 999e18);

        // 3) bob resgata o pagamento em BRZ
        token.approve(address(reserva), 999e18);
        uint256 pago = reserva.resgatar(address(brz), 999e18, 0);
        vm.stopPrank();
        assertEq(brz.balanceOf(bob), pago);
        assertEq(pago, 998.001e18);

        // Treasury recebeu: 2 (emissão) + 1 (escrow) + 0,999 (resgate)
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

        // Reexecução: mesmos endereços, nada quebra
        DeployPolygon.Implantacao memory b = s.run();
        assertEq(a.token, b.token);
        assertEq(a.reserva, b.reserva);
        assertEq(a.escrow, b.escrow);
    }

    function test_DeployMainnetUsaBrzEBrla() public {
        vm.chainId(137);
        address brz = 0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc;
        address brla = 0xE6A537a407488807F0bbeb0038B79004f19DDDFb;
        // Simula os tokens reais (18 casas) para o teste local.
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
