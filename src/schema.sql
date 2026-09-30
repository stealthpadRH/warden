-- Stealthpad worker database. Everything here is derived from Robinhood Chain and can be rebuilt by
-- re-indexing from the factory's deploy block. Amounts are raw integers (numeric(78,0)).

create table if not exists meta (key text primary key, value text not null);

create table if not exists coins (
  token text primary key,
  vault text unique not null,
  curve text not null,
  launcher text not null,
  tax_bps int not null,
  name text not null default '',
  symbol text not null default '',
  logo text not null default '',
  description text not null default '',
  website text not null default '',
  social text not null default '',
  launched_block bigint not null,
  launched_at timestamptz not null,
  tx text not null,
  graduated_block bigint,
  pool_id text
);

create table if not exists transfers (
  token text not null, block bigint not null, log_index int not null, tx text not null,
  from_addr text not null, to_addr text not null, value numeric(78,0) not null,
  primary key (token, block, log_index)
);
create index if not exists transfers_token_block on transfers (token, block);

create table if not exists balances (
  token text not null, holder text not null, balance numeric(78,0) not null,
  primary key (token, holder)
);

create table if not exists trades (
  token text not null, block bigint not null, log_index int not null, tx text not null,
  side text not null, trader text not null,
  eth numeric(78,0) not null, tokens numeric(78,0) not null,
  venue text not null, at timestamptz not null,
  primary key (token, block, log_index)
);
create index if not exists trades_token_at on trades (token, at desc);

create table if not exists rounds (
  vault text not null, round_id int not null, block bigint not null, block_hash text not null, tx text not null,
  at timestamptz not null, caller text not null,
  eth_budget numeric(78,0) not null, usdg numeric(78,0) not null, tip numeric(78,0) not null,
  to_stealth numeric(78,0) not null, to_treasury numeric(78,0) not null,
  primary key (vault, round_id)
);
create index if not exists rounds_at on rounds (at desc);
create index if not exists rounds_caller on rounds (caller);

create table if not exists roots (
  vault text not null, round_id int not null, root text not null, total numeric(78,0) not null, seed text not null,
  active_at timestamptz not null, status text not null,
  posted_block bigint not null, tx text not null,
  primary key (vault, round_id, root)
);

create table if not exists snapshots (
  vault text not null, round_id int not null,
  window_from bigint not null, window_to bigint not null, seed text not null,
  sampled_blocks bigint[] not null,
  distributable numeric(78,0) not null, distributed numeric(78,0) not null, carry numeric(78,0) not null,
  holders int not null, root text not null, total numeric(78,0) not null, leaf_hash text not null,
  tree jsonb not null,
  file text not null,
  created_at timestamptz not null default now(),
  primary key (vault, round_id)
);

create table if not exists leaves (
  vault text not null, round_id int not null, holder text not null,
  cumulative numeric(78,0) not null, share numeric(78,0) not null, avg_balance numeric(78,0) not null,
  primary key (vault, round_id, holder)
);
create index if not exists leaves_holder on leaves (holder);

create table if not exists claims (
  tx text not null, log_index int not null, vault text not null, holder text not null, to_addr text not null,
  amount numeric(78,0) not null, fee numeric(78,0) not null, root_round int not null,
  block bigint not null, at timestamptz not null,
  primary key (tx, log_index)
);
create index if not exists claims_holder on claims (holder);

create table if not exists images (
  hash text primary key, mime text not null, bytes bytea not null, created_at timestamptz not null default now()
);
