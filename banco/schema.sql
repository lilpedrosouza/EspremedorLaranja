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
  papel      text        not null default 'colega',
  criado_em  timestamptz not null default now()
);

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
  imagem       text
);

create table if not exists rodadas (
  id          text primary key,
  nome        text        not null,
  observacao  text        not null default '',
  aberta      boolean     not null default true,
  criada_em   timestamptz not null default now(),
  fechada_em  timestamptz,
  fechada_por text
);

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
  primary key (rodada_id, usuario_id)
);

create index if not exists pedidos_por_rodada on pedidos (rodada_id);

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
