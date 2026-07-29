'use strict';

/**
 * Atualiza o catálogo no banco com o que está no site da Nescafé Dolce Gusto.
 *
 *   node scripts/atualizar-produtos.js            grava as mudanças
 *   node scripts/atualizar-produtos.js --simular  só mostra o que mudaria
 *
 * O servidor já faz isso sozinho ao subir e a cada 12 horas. Este script serve
 * para rodar na mão ou por agendamento (cron), com o servidor parado ou não.
 *
 * Precisa da mesma DATABASE_URL do servidor.
 */

require('../lib/ambiente').carregar();

const catalogo = require('../lib/catalogo-nescafe');
const banco = require('../lib/banco');

const simular = process.argv.includes('--simular');

(async () => {
  try {
    const atual = await banco.listarProdutos();
    console.log(`Catálogo atual: ${atual.length} itens.`);
    console.log('Lendo o site da Nescafé (API da loja, com a página como reserva) …');

    const resultado = await catalogo.sincronizar(atual);
    console.log(`Leitura pela estratégia "${resultado.estrategia}": ${resultado.encontrados} produtos.`);
    console.log(`Novos: ${resultado.novos} · Atualizados: ${resultado.atualizados} · Sumiram do site: ${resultado.sumiram}`);
    console.log(`Com imagem: ${resultado.catalogo.filter((p) => p.imagem).length} de ${resultado.catalogo.length}.`);
    if (resultado.leituraParcial) {
      console.log('Atenção: a leitura veio incompleta — nada foi marcado como "saiu do site".');
    }

    if (simular) {
      console.log('\nModo simulação: nada foi gravado.');
      for (const item of resultado.catalogo.slice(0, 10)) {
        console.log(` - ${item.nome} — ${item.preco} — ${item.categoria}`);
      }
      return;
    }

    await banco.salvarCatalogo(resultado.catalogo);
    await banco.gravarSincronizacao({
      ultima: new Date().toISOString(),
      situacao: 'ok',
      disparadaPor: 'script',
      encontrados: resultado.encontrados,
      novos: resultado.novos,
      atualizados: resultado.atualizados,
      sumiram: resultado.sumiram,
      estrategia: resultado.estrategia,
      leituraParcial: Boolean(resultado.leituraParcial),
      mensagem: `${resultado.encontrados} produtos lidos pelo script — ${resultado.novos} novos, ${resultado.atualizados} atualizados.`
    });
    console.log(`\nGravado no banco: ${resultado.catalogo.length} itens.`);
  } catch (falha) {
    console.error(`\nNão deu para atualizar: ${falha.message}`);
    console.error('O catálogo que já estava salvo continua valendo.');
    process.exitCode = 1;
  } finally {
    await banco.encerrar().catch(() => {});
  }
})();
