-- Espremedor de Laranja — estrutura do banco (Postgres / Supabase).
--
-- O servidor roda este arquivo sozinho ao subir, então normalmente você não
-- precisa fazer nada. Se quiser criar na mão, cole no SQL Editor do Supabase.
-- Tudo é "if not exists": rodar de novo não apaga nem duplica nada.

create table if not exists usuarios (
  id         text primary key,
  nome       text        not null,
  chave      text        not null unique,
  senha      text        not null,
  papel      text        not null default 'usuario',
  criado_em  timestamptz not null default now()
);

-- Os papéis se chamavam 'colega' e 'comprador'. Bancos criados antes da troca
-- são renomeados aqui. Rodar de novo não faz nada: depois da primeira vez não
-- sobra nenhuma linha com o nome antigo.
alter table usuarios alter column papel set default 'usuario';
update usuarios set papel = 'usuario'    where papel = 'colega';
update usuarios set papel = 'espremedor' where papel = 'comprador';

-- Código de recuperação: o que a pessoa usa para redefinir a senha sozinha,
-- já que aqui ninguém cadastra e-mail e não há como mandar link nenhum.
-- Guardado com scrypt e sal, igual à senha — quem lê o banco não consegue
-- recuperar o código, só conferir se o digitado bate.
alter table usuarios add column if not exists recuperacao    text;
alter table usuarios add column if not exists recuperacao_em timestamptz;

-- E-mail: para onde vai o link de redefinição de senha. Fica nulo em quem se
-- cadastrou antes de existir o campo — o link só funciona para quem preencheu.
alter table usuarios add column if not exists email text;

-- Um e-mail por pessoa, sem diferenciar maiúscula de minúscula. Índice parcial
-- porque nulo pode repetir: quem não informou não conflita com quem não informou.
create unique index if not exists usuarios_email_unico
  on usuarios (lower(email)) where email is not null;

-- O nome que aparece na roleta do sorteio, quando o espremedor quer outro
-- (um apelido, um nome mais curto que caiba na fatia). Nulo = o nome da conta.
-- Separado do `nome` de propósito: o nome da conta é o login, e mudar como a
-- pessoa aparece na roleta não pode mudar como ela entra.
alter table usuarios add column if not exists apelido text;

-- Links de redefinição de senha enviados por e-mail.
--
-- O `token` guarda o SHA-256 do que viaja no link, nunca o valor em si: quem
-- lesse o banco poderia entrar na conta de qualquer um. Não precisa de scrypt
-- como a senha, porque o token é sorteado com 256 bits e não há o que adivinhar.
create table if not exists redefinicoes (
  token      text        primary key,
  usuario_id text        not null references usuarios(id) on delete cascade,
  criada_em  timestamptz not null default now(),
  usada_em   timestamptz
);

create index if not exists redefinicoes_por_usuario on redefinicoes (usuario_id);

create table if not exists produtos (
  id           text primary key,
  nome         text          not null,
  descricao    text          not null default '',
  categoria    text          not null default 'Outros',
  intensidade  integer,
  capsulas     integer       not null default 10,
  preco        numeric(10,2) not null default 0,
  preco_de     numeric(10,2),
  disponivel   boolean       not null default true,
  ativo        boolean       not null default true,
  origem       text          not null default 'site',
  fora_do_site boolean       not null default false,
  imagem       text,
  url          text
);

-- A coluna url chegou depois: bancos criados antes disso a ganham aqui.
alter table produtos add column if not exists url text;

create table if not exists rodadas (
  id          text primary key,
  nome        text        not null,
  observacao  text        not null default '',
  aberta      boolean     not null default true,
  criada_em   timestamptz not null default now(),
  fechada_em  timestamptz,
  fechada_por text,
  -- Código de rastreio da entrega, guardado sem a parte do endereço:
  -- de https://ondeestameupedido.com.br/FR260730GKSEI fica só FR260730GKSEI.
  rastreio    text,
  rastreio_em timestamptz
);

alter table rodadas add column if not exists rastreio    text;
alter table rodadas add column if not exists rastreio_em timestamptz;

-- Só pode existir uma rodada aberta por vez. Sem isso, dois acessos ao mesmo
-- tempo com o banco vazio criariam duas rodadas e os pedidos se espalhariam.
create unique index if not exists rodada_aberta_unica
  on rodadas ((aberta)) where aberta;

-- Um pedido por pessoa por rodada: a chave primária composta deixa o "enviar
-- pedido" ser um upsert, sem ler-modificar-gravar (que perderia pedidos
-- simultâneos). `itens` é jsonb porque é uma fotografia do que foi pedido —
-- nome e preço ficam congelados como estavam na hora do pedido.
create table if not exists pedidos (
  rodada_id     text not null references rodadas(id)  on delete cascade,
  usuario_id    text not null references usuarios(id) on delete cascade,
  nome          text        not null,
  itens         jsonb       not null default '[]'::jsonb,
  observacao    text        not null default '',
  atualizado_em timestamptz not null default now(),
  -- Duas marcações independentes, de propósito: "avisei que paguei" (a pessoa)
  -- e "confirmo que caiu" (o comprador). Sem isso não dá para saber a diferença
  -- entre quem ainda não pagou e quem pagou mas o comprador não conferiu.
  pago_em       timestamptz,
  confirmado_em timestamptz,
  primary key (rodada_id, usuario_id)
);

alter table pedidos add column if not exists pago_em       timestamptz;
alter table pedidos add column if not exists confirmado_em timestamptz;

-- Histórico de preços: uma linha por vez que o preço de um produto mudou.
-- É o que permite dizer se o preço de hoje está acima ou abaixo do normal e
-- qual dia da semana costuma sair mais barato.
--
-- Só grava quando o valor muda, e não a cada leitura do site (que acontece de
-- 12 em 12 horas): guardar toda leitura encheria a tabela de linhas repetidas
-- sem acrescentar informação nenhuma. Cada linha vale do momento em que foi
-- gravada até a linha seguinte — quem lê reconstrói o preço de qualquer dia.
create table if not exists precos (
  id            bigserial     primary key,
  produto_id    text          not null references produtos(id) on delete cascade,
  preco         numeric(10,2) not null,
  registrado_em timestamptz   not null default now()
);

-- A consulta é sempre "os pontos deste produto, em ordem de tempo", e a de
-- todos os produtos filtra por data. As duas cabem neste índice.
create index if not exists precos_por_produto on precos (produto_id, registrado_em);
create index if not exists precos_por_data     on precos (registrado_em);

-- Configuração da roda: hoje guarda a chave Pix de quem recebe.
-- Fica no banco, e não no código, porque chave Pix costuma ser CPF — dado
-- pessoal que não deve entrar num repositório público.
create table if not exists configuracao (
  chave text primary key,
  valor text not null
);

create index if not exists pedidos_por_rodada on pedidos (rodada_id);

-- Sorteio de brindes entre quem pediu numa rodada.
--
-- `participantes` é jsonb pelo mesmo motivo dos itens do pedido: é a fotografia
-- de quem estava na roleta naquela hora, com o nome como estava. O ganhador
-- fica também em coluna própria porque é por ela que se conta a "volta" — quem
-- já ganhou espera todo mundo ganhar antes de concorrer de novo.
create table if not exists sorteios (
  id            text primary key,
  rodada_id     text references rodadas(id)  on delete set null,
  brinde        text        not null default '',
  participantes jsonb       not null default '[]'::jsonb,
  ganhador_id   text references usuarios(id) on delete set null,
  ganhador_nome text        not null,
  sorteado_por  text,
  criado_em     timestamptz not null default now()
);

create index if not exists sorteios_por_data on sorteios (criado_em);

-- Quem o espremedor tirou ou pôs na roleta de uma rodada, além de quem pediu.
-- 'incluido' = tem conta mas não pediu; 'removido' = pediu mas fica de fora.
-- Sem linha, vale o pedido. Gravado no banco, e não só na tela, para o ajuste
-- sobreviver a recarregar a página ou abrir em outro aparelho.
create table if not exists sorteio_ajustes (
  rodada_id  text not null references rodadas(id)  on delete cascade,
  usuario_id text not null references usuarios(id) on delete cascade,
  situacao   text not null check (situacao in ('incluido', 'removido')),
  primary key (rodada_id, usuario_id)
);

create table if not exists sessoes (
  token      text primary key,
  usuario_id text        not null references usuarios(id) on delete cascade,
  criada_em  timestamptz not null default now()
);

create index if not exists sessoes_por_usuario on sessoes (usuario_id);

-- Uma linha só, com o resultado da última leitura do site da Nescafé.
create table if not exists sincronizacao (
  id     integer primary key default 1,
  dados  jsonb   not null default '{}'::jsonb,
  constraint sincronizacao_linha_unica check (id = 1)
);
