'use strict';

/**
 * Confere a conexão com o banco e prepara as tabelas.
 *
 *   npm run testar-banco
 *
 * Diz o que deu errado em português quando não conecta, em vez de deixar o
 * erro cru do driver. Rodar de novo não estraga nada.
 */

require('../lib/ambiente').carregar();

const url = process.env.DATABASE_URL || '';

function explicar(falha) {
  const m = falha.message || '';
  if (/SASL|password authentication failed/i.test(m)) {
    return [
      'A senha não confere.',
      'Confira se você trocou SUA_SENHA_AQUI no .env pela senha de verdade.',
      'Se ela tem caractere especial (@ : / ? # & %), precisa vir codificada:',
      '  @ -> %40    : -> %3A    / -> %2F    # -> %23    & -> %26    % -> %25',
      'Esqueceu a senha? Supabase → Project Settings → Database → Reset database password.'
    ];
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) {
    return ['Não achei esse servidor.', 'Confira o endereço depois do @ na DATABASE_URL.'];
  }
  if (/ETIMEDOUT|ECONNREFUSED/i.test(m)) {
    return [
      'A conexão não completou.',
      'Costuma ser a "Direct connection", que só atende por IPv6.',
      'Use a string do pooler: Supabase → Project Settings → Database →',
      'Connection string → Session pooler (porta 5432) ou Transaction pooler (6543).'
    ];
  }
  if (/self.signed|certificate/i.test(m)) {
    return ['Problema no certificado TLS.', 'Verifique se a URL não tem sslmode=disable.'];
  }
  return [m];
}

(async () => {
  if (!url || url.includes('SUA_SENHA_AQUI') || url.includes('[YOUR-PASSWORD]')) {
    console.error('\n  A DATABASE_URL ainda está com a senha de exemplo.');
    console.error('  Abra o arquivo .env e troque pela senha do seu banco.\n');
    process.exit(1);
  }

  const escondida = url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:•••@');
  console.log(`\n  Conectando em ${escondida}`);

  const banco = require('../lib/banco');

  try {
    await banco.iniciar(() => ({
      id: require('crypto').randomBytes(9).toString('hex'),
      nome: `Rodada de ${new Date().toLocaleDateString('pt-BR')}`,
      observacao: ''
    }));

    const produtos = await banco.listarProdutos();
    const usuarios = await banco.contarUsuarios();
    const rodada = await banco.rodadaAberta();

    console.log('\n  Conectou e as tabelas estão prontas.\n');
    console.log(`    produtos no catálogo : ${produtos.length}`);
    console.log(`    pessoas cadastradas  : ${usuarios}`);
    console.log(`    rodada aberta        : ${rodada ? rodada.nome : '(nenhuma)'}`);
    console.log(
      usuarios === 0
        ? '\n  Ninguém se cadastrou ainda — o primeiro acesso criado vira o espremedor.\n'
        : '\n'
    );
  } catch (falha) {
    console.error('\n  Não deu para conectar.\n');
    for (const linha of explicar(falha)) console.error('    ' + linha);
    console.error('');
    process.exitCode = 1;
  } finally {
    await banco.encerrar().catch(() => {});
  }
})();
