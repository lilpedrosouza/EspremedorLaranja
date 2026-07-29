'use strict';

/**
 * Define quem recebe os pagamentos da rodada.
 *
 *   node scripts/configurar-pix.js "000.000.000-00" "Nome De Quem Recebe" "Sao Paulo"
 *   node scripts/configurar-pix.js --mostrar     mostra o que está gravado
 *   node scripts/configurar-pix.js --apagar      tira a chave (some o QR da tela)
 *
 * A chave fica no banco, não no código: chave Pix costuma ser CPF, e este
 * repositório é público. Só quem está logado no sistema vê o QR.
 */

require('../lib/ambiente').carregar();

const banco = require('../lib/banco');
const pix = require('../lib/pix');

const argumentos = process.argv.slice(2);

function esconder(chave) {
  const texto = String(chave);
  if (texto.includes('@')) return texto.replace(/^(.).*(@.*)$/, '$1•••$2');
  const digitos = texto.replace(/\D/g, '');
  if (digitos.length >= 6) return `${digitos.slice(0, 3)}•••••${digitos.slice(-2)}`;
  return '•••';
}

(async () => {
  try {
    if (argumentos.includes('--mostrar')) {
      const chave = await banco.lerConfiguracao('pix_chave');
      if (!chave) {
        console.log('\n  Nenhuma chave Pix configurada — o QR não aparece na tela de pedido.\n');
        return;
      }
      console.log('\n  Chave  : ' + esconder(chave));
      console.log('  Nome   : ' + ((await banco.lerConfiguracao('pix_nome')) || '(sem nome)'));
      console.log('  Cidade : ' + ((await banco.lerConfiguracao('pix_cidade')) || 'BRASIL') + '\n');
      return;
    }

    if (argumentos.includes('--apagar')) {
      for (const c of ['pix_chave', 'pix_nome', 'pix_cidade']) await banco.gravarConfiguracao(c, null);
      console.log('\n  Chave Pix removida. A tela volta a pedir que se combine o pagamento por fora.\n');
      return;
    }

    const [chave, nome, cidade] = argumentos;
    if (!chave || !nome) {
      console.error('\n  Uso: node scripts/configurar-pix.js "<chave>" "<nome de quem recebe>" ["<cidade>"]');
      console.error('       node scripts/configurar-pix.js --mostrar');
      console.error('       node scripts/configurar-pix.js --apagar\n');
      process.exitCode = 1;
      return;
    }

    // Monta um BR Code de teste: se a chave for inválida, o erro sai agora e
    // não na tela de quem está tentando pagar.
    const teste = pix.montarBrCode({ chave, nome, cidade, valor: 1 });

    await banco.gravarConfiguracao('pix_chave', chave);
    await banco.gravarConfiguracao('pix_nome', nome);
    await banco.gravarConfiguracao('pix_cidade', cidade || 'BRASIL');

    console.log('\n  Gravado.');
    console.log('    chave  : ' + esconder(chave));
    console.log('    nome   : ' + pix.apenasAscii(nome, 25));
    console.log('    cidade : ' + pix.apenasAscii(cidade || 'BRASIL', 15));
    console.log('\n  Conferência (Pix de teste de R$ 1,00):');
    console.log('    ' + teste);
    console.log('\n  O QR aparece para quem enviar o pedido, já com o valor da pessoa.\n');
  } catch (falha) {
    console.error(`\n  Não deu para configurar: ${falha.message}\n`);
    process.exitCode = 1;
  } finally {
    await banco.encerrar().catch(() => {});
  }
})();
