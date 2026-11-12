-- Fatureiro - schema inicial
-- Idempotente: pode ser executado mais de uma vez.

CREATE SCHEMA IF NOT EXISTS fatureiro;
SET search_path TO fatureiro, public;

CREATE OR REPLACE FUNCTION fatureiro.marcar_atualizado_em() RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Clientes da Invite (titulares do consentimento)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                TEXT NOT NULL,
  referencia_externa  TEXT,                       -- id do cliente no sistema principal da Invite
  consentimento_em    TIMESTAMPTZ,                -- data do contrato/consentimento para acesso às faturas
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_clientes_atualizado ON clientes;
CREATE TRIGGER trg_clientes_atualizado BEFORE UPDATE ON clientes
  FOR EACH ROW EXECUTE FUNCTION fatureiro.marcar_atualizado_em();

-- ---------------------------------------------------------------------------
-- Credenciais de acesso à agência virtual, por cliente e distribuidora
-- login e senha ficam CIFRADOS (AES-256-GCM, chave FATUREIRO_COFRE_CHAVE)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credenciais (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id          UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  distribuidora       TEXT NOT NULL CHECK (distribuidora IN ('neoenergia', 'cpfl')),
  tipo_login          TEXT NOT NULL CHECK (tipo_login IN ('cpf', 'cnpj', 'email')),
  login_cifrado       TEXT NOT NULL,
  login_hash          TEXT NOT NULL,              -- sha256(login normalizado): unicidade sem expor o dado
  senha_cifrada       TEXT NOT NULL,
  uf                  CHAR(2) CHECK (uf IS NULL OR uf IN ('BA', 'MS', 'PE', 'RN', 'SP')),
  acesso_imobiliaria  BOOLEAN NOT NULL DEFAULT false,
  situacao            TEXT NOT NULL DEFAULT 'ativa'
                        CHECK (situacao IN ('ativa', 'dados_invalidos', 'revisar', 'desativada')),
  motivo_situacao     TEXT,
  ultima_tentativa_em TIMESTAMPTZ,
  ultimo_sucesso_em   TIMESTAMPTZ,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cliente_id, distribuidora, login_hash)
);
DROP TRIGGER IF EXISTS trg_credenciais_atualizado ON credenciais;
CREATE TRIGGER trg_credenciais_atualizado BEFORE UPDATE ON credenciais
  FOR EACH ROW EXECUTE FUNCTION fatureiro.marcar_atualizado_em();

-- ---------------------------------------------------------------------------
-- Unidades consumidoras (UC na Neoenergia; instalação na CPFL)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unidades (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credencial_id             UUID NOT NULL REFERENCES credenciais(id) ON DELETE CASCADE,
  uc                        TEXT NOT NULL,
  titular_tipo              TEXT CHECK (titular_tipo IS NULL OR titular_tipo IN ('cpf', 'cnpj')),
  titular_documento_cifrado TEXT,
  apelido                   TEXT,
  situacao                  TEXT NOT NULL DEFAULT 'ativa'
                              CHECK (situacao IN ('ativa', 'pausada', 'dados_invalidos', 'revisar')),
  motivo_situacao           TEXT,
  proxima_consulta_em       DATE,                 -- NULL = consultar no próximo lote
  ultimo_mes_capturado      DATE,                 -- 1º dia do mês de referência da última fatura gravada
  ciclo_referencia          DATE,                 -- mês que estamos tentando capturar no ciclo atual
  tentativas_ciclo          INT NOT NULL DEFAULT 0, -- consultas PAGAS já feitas neste ciclo
  criado_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (credencial_id, uc)
);
CREATE INDEX IF NOT EXISTS idx_unidades_agenda ON unidades (situacao, proxima_consulta_em);
DROP TRIGGER IF EXISTS trg_unidades_atualizado ON unidades;
CREATE TRIGGER trg_unidades_atualizado BEFORE UPDATE ON unidades
  FOR EACH ROW EXECUTE FUNCTION fatureiro.marcar_atualizado_em();

-- ---------------------------------------------------------------------------
-- Faturas capturadas. Chave de unicidade: UC + mês de referência.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faturas (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unidade_id              UUID NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  distribuidora           TEXT NOT NULL,
  uc                      TEXT NOT NULL,
  mes_referencia          DATE NOT NULL,          -- sempre dia 1
  valor                   NUMERIC(12, 2),
  vencimento              DATE,
  conta_paga              BOOLEAN,                -- CPFL informa; Neoenergia não
  consumo_kwh             NUMERIC(12, 2),
  energia_injetada_kwh    NUMERIC(12, 2),
  energia_compensada_kwh  NUMERIC(12, 2),
  saldo_creditos_kwh      NUMERIC(12, 2),
  leitura_data            DATE,
  proxima_leitura_data    DATE,
  dias_faturados          INT,
  codigo_barras           TEXT,
  tributos                JSONB,
  nota_fiscal             JSONB,
  itens                   JSONB,
  historico_consumo       JSONB,
  dados_brutos            JSONB NOT NULL,         -- resposta da Infosimples SEM header.parameters
  pdf_chave               TEXT,                   -- chave no armazenamento (S3 ou disco)
  pdf_sha256              TEXT,
  pdf_baixado_em          TIMESTAMPTZ,
  origem                  TEXT NOT NULL DEFAULT 'infosimples',
  capturada_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (uc, mes_referencia)
);
CREATE INDEX IF NOT EXISTS idx_faturas_unidade ON faturas (unidade_id, mes_referencia DESC);

-- ---------------------------------------------------------------------------
-- Registro de cada chamada à API (controle de gasto e auditoria)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lotes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iniciado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizado_em       TIMESTAMPTZ,
  dry_run             BOOLEAN NOT NULL DEFAULT false,
  total_unidades      INT NOT NULL DEFAULT 0,
  gravadas            INT NOT NULL DEFAULT 0,
  duplicadas          INT NOT NULL DEFAULT 0,
  erros               INT NOT NULL DEFAULT 0,
  gasto_brl           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  interrompido_motivo TEXT
);

CREATE TABLE IF NOT EXISTS consultas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id         UUID REFERENCES lotes(id) ON DELETE SET NULL,
  unidade_id      UUID REFERENCES unidades(id) ON DELETE SET NULL,
  credencial_id   UUID REFERENCES credenciais(id) ON DELETE SET NULL,
  servico         TEXT NOT NULL,
  modo            TEXT NOT NULL DEFAULT 'sync' CHECK (modo IN ('sync', 'async', 'dry-run')),
  request_id      TEXT,
  code            INT,
  code_message    TEXT,
  billable        BOOLEAN,
  price           NUMERIC(10, 4),
  elapsed_ms      INT,                            -- header.elapsed_time_in_milliseconds
  duracao_ms      INT,                            -- medido do nosso lado
  acao            TEXT,                           -- gravada | duplicada | retry | invalidar | revisar | parar_lote | erro_rede
  erros           JSONB,                          -- campo "errors" da API: uso interno, nunca mostrar ao cliente
  consultada_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consultas_data ON consultas (consultada_em);
CREATE INDEX IF NOT EXISTS idx_consultas_unidade ON consultas (unidade_id, consultada_em DESC);

-- ---------------------------------------------------------------------------
-- Pendências para a operação
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pendencias (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo          TEXT NOT NULL CHECK (tipo IN (
                  'credencial_invalida', 'unidade_invalida', 'revisao_manual',
                  'falhas_repetidas', 'sem_fatura', 'teto_atingido', 'lote_interrompido')),
  unidade_id    UUID REFERENCES unidades(id) ON DELETE CASCADE,
  credencial_id UUID REFERENCES credenciais(id) ON DELETE CASCADE,
  code          INT,
  mensagem      TEXT NOT NULL,
  detalhes      JSONB,
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvida_em  TIMESTAMPTZ,
  resolvida_por TEXT
);
CREATE INDEX IF NOT EXISTS idx_pendencias_abertas ON pendencias (tipo) WHERE resolvida_em IS NULL;

-- ---------------------------------------------------------------------------
-- Configurações ajustáveis em produção sem redeploy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS configuracoes (
  chave         TEXT PRIMARY KEY,
  valor         TEXT NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO configuracoes (chave, valor) VALUES ('teto_mensal_brl', '300')
  ON CONFLICT (chave) DO NOTHING;
