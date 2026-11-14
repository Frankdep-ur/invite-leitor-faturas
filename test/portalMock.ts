import type { BrowserContext } from 'playwright';

/**
 * Portal FALSO no estilo da agência virtual (SPA com rotas por hash), para
 * testar o robô sem tocar no site real. Comportamentos:
 *  - #/login: UF (select), #userId, #password, botão Entrar (habilita com UF+CPF+senha).
 *    Senha "senha-certa" => grava tokenNeSe e vai para #/home. Outra => alerta "Senha inválida".
 *  - #/home: lista de instalações (UC 1234.5678 e 9999.0000).
 *  - #/uc/<n>: link "2ª via de fatura".
 *  - #/faturas/<n>: tabela com botão Baixar; UC 99990000 não tem fatura.
 *  - modo 'resposta': Baixar faz fetch de JSON com o PDF em base64 (padrão de SPA).
 *  - modo 'download': Baixar gera um Blob local e dispara download (sem rede).
 *  - modo 'bloqueado': tudo responde a página "Access Denied" do CDN.
 *  - opção loginEmDialogo: botão LOGIN no topo abre o formulário num diálogo.
 *  - opção estiloReal: o fluxo completo visto no portal real (ver OpcoesPortal.estiloReal).
 */

export type ModoPortal = 'resposta' | 'download' | 'bloqueado';
export const BASE_MOCK = 'https://portal.teste';

export interface OpcoesPortal {
  /** Como no portal real: a página tem só o botão LOGIN no topo; o formulário abre num diálogo. */
  loginEmDialogo?: boolean;
  /** UCs numa lista suspensa (combobox estilo Angular Material), visíveis só depois de abrir. */
  ucEmCombobox?: boolean;
  /**
   * Formato visto no PORTAL REAL (teste de campo 14/11): login em diálogo; depois do login o
   * endereço continua #/login com "Olá, <nome>" no topo; serviços dentro do menu suspenso
   * "Para a Unidade Consumidora"; clicar em "Início" reabre o login; o serviço de 2ª via pede
   * o imóvel (UC) e só então mostra as faturas.
   */
  estiloReal?: boolean;
}

function htmlApp(modo: ModoPortal, pdfB64: string, opts: OpcoesPortal = {}): string {
  const pdfEmbutido = modo === 'download' ? JSON.stringify(pdfB64) : 'null';
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><title>Agência Virtual (simulada)</title></head>
<body><div id="app"></div>
<script>
const PDF_LOCAL = ${pdfEmbutido};
const DIALOGO = ${opts.loginEmDialogo ? 'true' : 'false'};
const COMBO = ${opts.ucEmCombobox ? 'true' : 'false'};
const REAL = ${opts.estiloReal ? 'true' : 'false'};
const app = document.getElementById('app');
function ir(h){ location.hash = h; }
function render(){
  const h = location.hash || '#/login';
  const logado = !!localStorage.getItem('tokenNeSe');
  if (REAL) { renderReal(h, logado); return; }
  document.querySelectorAll('mat-dialog-container').forEach(d => d.remove());
  if ((h.startsWith('#/login') || !logado) && DIALOGO) {
    // Formato do portal real: cabeçalho com botão LOGIN; o formulário só existe depois do clique.
    // Há um campo-isca de CPF FORA do diálogo: o robô não pode digitar nele.
    app.innerHTML = '<header><nav><a href="#/cadastro">Cadastre-se</a> <button class="btn-login">LOGIN</button></nav></header>'
      + '<main><h1>Bem-vindo à Agência Virtual</h1><label>Consulte débitos <input id="isca" placeholder="CPF do titular"></label></main>'
      + '<div id="cookies">Usamos cookies. <button id="ck">Aceitar</button></div>';
    document.getElementById('ck').addEventListener('click', () => document.getElementById('cookies').remove());
    document.querySelector('.btn-login').addEventListener('click', () => {
      if (document.querySelector('mat-dialog-container')) return;
      const d = document.createElement('mat-dialog-container'); d.setAttribute('role', 'dialog');
      // Campos SEM os ids conhecidos, e um texto fixo que parece mensagem de erro.
      d.innerHTML = '<h2>Acesse sua conta</h2><form onsubmit="return false">'
        + '<input formcontrolname="campoA" placeholder="Digite aqui">'
        + '<input type="password" formcontrolname="campoB">'
        + '<p>Dados incorretos impedem o acesso. Esqueceu a senha?</p>'
        + '<button title="Entrar" disabled>ENTRAR</button><div id="msg"></div></form>';
      document.body.appendChild(d);
      const [u, s2] = d.querySelectorAll('input'); const b = d.querySelector('button');
      const valida = () => { b.disabled = !(u.value.replace(/\\D/g,'').length >= 11 && s2.value.length > 0); };
      [u, s2].forEach(x => x.addEventListener('input', valida));
      b.addEventListener('click', () => {
        const msg = d.querySelector('#msg');
        if (document.getElementById('isca').value) { msg.textContent = 'Erro interno: campo errado preenchido.'; return; }
        if (s2.value === 'senha-certa') { localStorage.setItem('tokenNeSe', 'tok'); d.remove(); ir('#/home'); }
        else msg.textContent = 'Usuário ou senha inválidos.';
      });
    });
    if (!h.startsWith('#/login')) ir('#/login');
    return;
  }
  if (h.startsWith('#/login') || !logado) {
    app.innerHTML = '<h2>Acesse sua conta</h2>'
      + '<label for="uf">Estado</label><select id="uf" formcontrolname="uf"><option value="">Selecione</option><option value="SP">São Paulo</option><option value="BA">Bahia</option></select>'
      + '<label for="userId">CPF ou CNPJ</label><input id="userId" formcontrolname="userId">'
      + '<label for="password">Senha</label><input id="password" type="password" formcontrolname="password">'
      + '<button id="entrar" disabled>Entrar</button><div id="msg" role="alert"></div>';
    const u = document.getElementById('userId'), s = document.getElementById('password'), uf = document.getElementById('uf'), b = document.getElementById('entrar');
    const valida = () => { b.disabled = !(uf.value && u.value.replace(/\\D/g,'').length >= 11 && s.value.length > 0); };
    [u, s].forEach(x => x.addEventListener('input', valida)); uf.addEventListener('change', valida);
    b.addEventListener('click', () => {
      if (s.value === 'senha-certa') { localStorage.setItem('tokenNeSe', 'tok'); ir('#/home'); }
      else document.getElementById('msg').textContent = 'Senha inválida. Tente novamente.';
    });
    if (!h.startsWith('#/login')) ir('#/login');
    return;
  }
  if (h === '#/home' && COMBO) {
    app.innerHTML = '<p>Olá, Cliente <a href="#/login" onclick="localStorage.clear()">Sair</a></p>'
      + '<label>Imóvel</label><div role="combobox" tabindex="0" id="combo">Selecione o imóvel</div><div id="lista"></div>';
    document.getElementById('combo').addEventListener('click', () => {
      document.getElementById('lista').innerHTML = '<div role="listbox">'
        + '<div role="option" onclick="ir(\\'#/uc/12345678\\')">Instalação 1234.5678 - Rua A, 1</div>'
        + '<div role="option" onclick="ir(\\'#/uc/22223333\\')">Instalação 2222.3333 - Rua B, 2</div></div>';
    });
    return;
  }
  if (h === '#/home') {
    app.innerHTML = '<p>Olá, Cliente <a href="#/login" onclick="localStorage.clear()">Sair</a></p><h3>Meus imóveis</h3>'
      + '<button onclick="ir(\\'#/uc/12345678\\')">Instalação 1234.5678</button>'
      + '<button onclick="ir(\\'#/uc/22223333\\')">Instalação 2222.3333</button>'
      + '<button onclick="ir(\\'#/uc/99990000\\')">Instalação 9999.0000</button>';
    return;
  }
  let m = h.match(/^#\\/uc\\/(\\d+)/);
  if (m) { app.innerHTML = '<h3>Instalação ' + m[1] + '</h3><a href="#/faturas/' + m[1] + '">2ª via de fatura</a>'; return; }
  m = h.match(/^#\\/faturas\\/(\\d+)/);
  if (m) {
    const uc = m[1];
    if (uc === '99990000') { app.innerHTML = '<p>Não há faturas disponíveis para esta unidade.</p>'; return; }
    app.innerHTML = '<table><tr><td>OUT/2026</td><td>R$ 1.234,56</td><td><button id="b1">Baixar</button></td></tr>'
      + '<tr><td>SET/2026</td><td>R$ 1.100,00</td><td><button>Baixar</button></td></tr></table>';
    document.getElementById('b1').addEventListener('click', async () => {
      if (PDF_LOCAL) {
        const bin = Uint8Array.from(atob(PDF_LOCAL), c => c.charCodeAt(0));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bin], { type: 'application/pdf' }));
        a.download = 'fatura.pdf'; document.body.appendChild(a); a.click();
      } else {
        const r = await fetch('/api/ucs/' + uc + '/faturas/1/pdf'); await r.json();
      }
    });
  }
}
function abrirDialogoReal() {
  if (document.querySelector('mat-dialog-container')) return;
  const d = document.createElement('mat-dialog-container'); d.setAttribute('role', 'dialog');
  d.innerHTML = '<h2>Login</h2><form onsubmit="return false"><input id="userId" formcontrolname="userId">'
    + '<input id="password" type="password" formcontrolname="password"><a href="#/esqueci">Esqueceu sua senha?</a>'
    + '<button title="Entrar" disabled>ENTRAR</button><div id="msg"></div></form>';
  document.body.appendChild(d);
  const [u, s2] = d.querySelectorAll('input'); const b = d.querySelector('button');
  const valida = () => { b.disabled = !(u.value.replace(/\\D/g,'').length >= 11 && s2.value.length > 0); };
  [u, s2].forEach(x => x.addEventListener('input', valida));
  b.addEventListener('click', () => {
    if (s2.value === 'senha-certa') { localStorage.setItem('tokenNeSe', 'tok'); d.remove(); render(); }
    else d.querySelector('#msg').textContent = 'Usuário ou senha inválidos.';
  });
}
const UCS_REAIS = { '12345678901': '123.456.789-01', '98765432109': '987.654.321-09' };
function renderReal(h, logado) {
  const topo = logado
    ? '<header><nav><span>Olá, Cliente</span> <button id="inicio">Início</button>'
      + ' <button id="m-voce" aria-haspopup="true">Para Você<i>expand_more</i></button>'
      + ' <button id="m-uc" aria-haspopup="true">Para a Unidade Consumidora<i>expand_more</i></button>'
      + ' <button>Fale Conosco<i>expand_more</i></button></nav><div id="menu"></div></header>'
    : '<header><nav><button>Início</button> <button>Para Você<i>expand_more</i></button> <button class="btn-login">LOGIN</button></nav></header>';
  // Como no portal real: os serviços do "Acesso rápido" são <div> clicáveis (não botões/links).
  let corpo = '<h2>Mais por você</h2><p>Acesso rápido aos principais serviços</p>'
    + (logado ? '<div class="cards"><div class="card" style="cursor:pointer" onclick="ir(\\'#/home/servicos/fatura-digital\\')"><span>Fatura Digital</span><p>Receba suas faturas por e-mail</p></div>'
      + '<div class="card" style="cursor:pointer" onclick="ir(\\'#/home/servicos/segunda-via\\')"><span>2ª via de conta</span></div></div>' : '')
    + '<h3>Destaques</h3>';
  const m = h.match(/^#\\/home\\/servicos\\/segunda-via(?:\\/(\\d+))?/);
  if (logado && m && !m[1]) {
    corpo = '<h2>2ª via de conta</h2><p>Selecione o imóvel</p>'
      + Object.entries(UCS_REAIS).map(([d, f]) => '<button onclick="ir(\\'#/home/servicos/segunda-via/' + d + '\\')">UC ' + f + ' · Rua Exemplo</button>').join(' ');
  } else if (logado && m && m[1]) {
    corpo = '<h2>2ª via de conta</h2><p>Imóvel: UC ' + (UCS_REAIS[m[1]] || m[1]) + '</p>'
      + '<table><tr><td>10/2026</td><td>R$ 97,32</td><td><button id="b1">Baixar</button></td></tr></table>';
  }
  app.innerHTML = topo + '<main>' + corpo + '</main>';
  const btnLogin = document.querySelector('.btn-login');
  if (btnLogin) btnLogin.addEventListener('click', abrirDialogoReal);
  const inicio = document.getElementById('inicio');
  if (inicio) inicio.addEventListener('click', abrirDialogoReal); // armadilha vista no portal real
  const menu = document.getElementById('menu');
  const mUc = document.getElementById('m-uc');
  if (mUc) mUc.addEventListener('click', () => { menu.innerHTML = '<a role="menuitem" href="#/home/servicos/troca-titularidade">Troca de Titularidade</a>'
    + ' <a role="menuitem" href="#/home/servicos/ligacao-nova">Ligação Nova</a>'; });
  const mVoce = document.getElementById('m-voce');
  if (mVoce) mVoce.addEventListener('click', () => { menu.innerHTML = '<a role="menuitem" href="#/home/servicos/atualizacao-cadastral">Atualização Cadastral</a>'; });
  const b1 = document.getElementById('b1');
  if (b1) b1.addEventListener('click', async () => { const r = await fetch('/api/ucs/' + m[1] + '/faturas/1/pdf'); await r.json(); });
}
window.addEventListener('hashchange', render); render();
</script></body></html>`;
}

const ACCESS_DENIED = `<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>
You don't have permission to access "http://portal.teste/" on this server.<p>Reference #18.0000000.0000000.000000</p></body></html>`;

/** Instala o portal falso num contexto do navegador. `pdf` pode ser um por UC. */
export async function instalarPortal(ctx: BrowserContext, modo: ModoPortal, pdf: Buffer | Record<string, Buffer>, opts: OpcoesPortal = {}): Promise<void> {
  const porUc = Buffer.isBuffer(pdf) ? {} : pdf;
  const padrao = Buffer.isBuffer(pdf) ? pdf : Object.values(pdf)[0]!;
  await ctx.route(`${BASE_MOCK}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (modo === 'bloqueado') {
      return route.fulfill({ status: 403, contentType: 'text/html', body: ACCESS_DENIED });
    }
    if (url.pathname.startsWith('/api/')) {
      const uc = url.pathname.match(/\/ucs\/(\d+)\//)?.[1] ?? '';
      const escolhido = porUc[uc] ?? padrao;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ fileName: 'fatura.pdf', fileData: escolhido.toString('base64') }) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: htmlApp(modo, padrao.toString('base64'), opts) });
  });
}
