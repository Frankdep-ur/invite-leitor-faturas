/**
 * Logger mínimo em JSON, sem dependências.
 * REGRA DE SEGURANÇA: senha e login em claro NUNCA entram em log.
 * Os campos sensíveis conhecidos são redigidos antes de serializar.
 */
type Nivel = 'debug' | 'info' | 'warn' | 'error';
const ordem: Record<Nivel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const CHAVES_SENSIVEIS = new Set([
  'senha',
  'password',
  'login_senha',
  'enc_login_senha',
  'login',
  'login_cpf',
  'login_cnpj',
  'email',
  'cpf',
  'cnpj',
  'token',
  'senha_cifrada',
  'login_cifrado',
]);

function redigir(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(redigir);
  if (valor && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      saida[k] = CHAVES_SENSIVEIS.has(k.toLowerCase()) ? '***' : redigir(v);
    }
    return saida;
  }
  return valor;
}

export interface Logger {
  debug(msg: string, dados?: Record<string, unknown>): void;
  info(msg: string, dados?: Record<string, unknown>): void;
  warn(msg: string, dados?: Record<string, unknown>): void;
  error(msg: string, dados?: Record<string, unknown>): void;
}

export function criarLogger(nivelMin: Nivel = 'info'): Logger {
  function emitir(nivel: Nivel, msg: string, dados?: Record<string, unknown>) {
    if (ordem[nivel] < ordem[nivelMin]) return;
    const linha = { ts: new Date().toISOString(), nivel, msg, ...(dados ? (redigir(dados) as object) : {}) };
    const texto = JSON.stringify(linha);
    if (nivel === 'error') process.stderr.write(texto + '\n');
    else process.stdout.write(texto + '\n');
  }
  return {
    debug: (m, d) => emitir('debug', m, d),
    info: (m, d) => emitir('info', m, d),
    warn: (m, d) => emitir('warn', m, d),
    error: (m, d) => emitir('error', m, d),
  };
}

export const logSilencioso: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
