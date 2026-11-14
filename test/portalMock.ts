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
  /** Lista de UCs demora a carregar ("Aguarde um instante..."), como no portal real. */
  listaLenta?: boolean;
  /**
   * Região no topo (teste de campo 14/11): navegador limpo mostra "Neoenergia ▾" (há também um
   * menu institucional "Neoenergia ▾"). Sem região escolhida, o login funciona ("Olá, <nome>"),
   * mas as páginas da conta devolvem para #/login com a janela de login aberta.
   */
  exigeRegiao?: boolean;
  /** A região se escolhe numa JANELA com lista suspensa (<select>) e botão "Confirmar". */
  regiaoEmJanela?: boolean;
  /** Região já salva no navegador (como no Chrome de quem já usa o portal). */
  regiaoInicial?: string;
  /** Conta quantas vezes o botão ENTRAR foi enviado (o robô não pode redigitar a senha). */
  contador?: { logins: number };
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
const LENTA = ${opts.listaLenta ? 'true' : 'false'};
const EXIGE_REGIAO = ${opts.exigeRegiao ? 'true' : 'false'};
const REGIAO_JANELA = ${opts.regiaoEmJanela ? 'true' : 'false'};
const REGIOES = ['Bahia', 'Brasília', 'Mato Grosso do Sul', 'Pernambuco', 'São Paulo'];
if (${JSON.stringify(opts.regiaoInicial ?? '')} && !localStorage.getItem('regiaoSel')) localStorage.setItem('regiaoSel', ${JSON.stringify(opts.regiaoInicial ?? '')});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('menu'); if (m) m.innerHTML = '';
  if (REAL) document.querySelectorAll('mat-dialog-container, #dlg-reg').forEach((d) => d.remove());
});
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
    fetch('/conta/login', { method: 'POST' }).catch(() => {});
    if (s2.value === 'senha-certa') { localStorage.setItem('tokenNeSe', 'tok'); d.remove(); render(); }
    else d.querySelector('#msg').textContent = 'Usuário ou senha inválidos.';
  });
}
const UCS_REAIS = {
  '12345678901': { fmt: '123.456.789-01', codigo: '7654321', end: 'Rua Exemplo, 1' },
  '98765432109': { fmt: '987.654.321-09', codigo: '1234567', end: 'Rua Exemplo, 2' },
};
function so(d) { return String(d || '').replace(/\\D/g, ''); }
function renderReal(h, logado) {
  const regiao = localStorage.getItem('regiaoSel');
  let voltaLogin = false;
  if (EXIGE_REGIAO && h.startsWith('#/home') && (!logado || !regiao)) {
    // Como no portal real sem região: devolve para o login (o nome do cliente continua no topo).
    history.replaceState(null, '', '#/login'); h = '#/login'; voltaLogin = true;
  }
  const topoRegiao = EXIGE_REGIAO
    ? '<button id="m-inst" aria-haspopup="true">Neoenergia<i>expand_more</i></button> '
      + '<button id="m-reg" aria-haspopup="true">' + (regiao || 'Neoenergia') + '<i>expand_more</i></button> '
    : '';
  const topo = logado
    ? '<header><nav>' + topoRegiao + '<span>Olá, Cliente</span> <button id="inicio">Início</button>'
      + ' <button id="m-voce" aria-haspopup="true">Para Você<i>expand_more</i></button>'
      + ' <button id="m-uc" aria-haspopup="true">Para a Unidade Consumidora<i>expand_more</i></button>'
      + ' <button>Fale Conosco<i>expand_more</i></button></nav><div id="menu"></div></header>'
    : '<header><nav>' + topoRegiao + '<button>Início</button> <button>Para Você<i>expand_more</i></button> <button class="btn-login">LOGIN</button></nav><div id="menu"></div></header>';
  let corpo = '<h2>Mais por você</h2><p>Acesso rápido aos principais serviços</p><h3>Destaques</h3>';
  const sel = sessionStorage.getItem('ucSel');
  if (logado && h.startsWith('#/home/meus-imoveis') && LENTA && !window.__listaPronta) {
    corpo = '<p>Aguarde um instante...</p>';
    setTimeout(() => { window.__listaPronta = true; if (location.hash.startsWith('#/home/meus-imoveis')) render(); }, 3000);
  } else if (logado && h.startsWith('#/home/meus-imoveis')) {
    const filtro = sessionStorage.getItem('filtro') || '';
    const lista = Object.entries(UCS_REAIS).filter(([d, u]) => !filtro || d === filtro || u.codigo === filtro);
    corpo = '<h2>Unidades Consumidoras</h2><p>Escolha abaixo a unidade consumidora que deseja consultar</p>'
      + '<input id="busca" placeholder="Insira um Código do Cliente ou Número da UC"> <span id="pesq" style="cursor:pointer">Pesquisar</span>'
      + lista.map(([d, u]) => '<div class="card-uc" style="cursor:pointer" data-uc="' + d + '"><small>NÚMERO DA UNIDADE CONSUMIDORA</small><b>' + u.fmt + '</b><span>' + u.end + '</span><span>LIGADA</span></div>').join('')
      + '<button>VOLTAR</button>';
  } else if (logado && h === '#/home' && sel) {
    const u = UCS_REAIS[sel];
    corpo = '<h2>Unidade Consumidora</h2><p>Número da Unidade Consumidora ' + u.fmt + '</p><p>Código do Cliente ' + u.codigo + '</p>'
      + '<button>Minhas Unidades</button><h3>Serviços mais utilizados</h3>'
      + '<div class="svc" style="cursor:pointer" id="svc-fat">Faturas e 2ª via de faturas</div>'
      + '<div class="svc" style="cursor:pointer">Débito automático</div><div class="svc" style="cursor:pointer">Fatura digital</div>';
  } else if (logado && h.startsWith('#/home/servicos/consultar-debitos') && sel) {
    corpo = '<h2>Consultar débitos e emitir 2ª via de faturas</h2><h3>Última Fatura</h3><p>Total a pagar R$ 98,86</p>'
      + '<button>PIX</button> <button id="mais">MAIS OPÇÕES +</button><div id="menu-op"></div><h3>LISTA DE FATURAS</h3>';
  }
  app.innerHTML = topo + '<main>' + corpo + '</main>';
  const btnLogin = document.querySelector('.btn-login');
  if (btnLogin) btnLogin.addEventListener('click', abrirDialogoReal);
  const inicio = document.getElementById('inicio');
  if (inicio) inicio.addEventListener('click', abrirDialogoReal); // armadilha vista no portal real
  const menu = document.getElementById('menu');
  const mUc = document.getElementById('m-uc');
  if (mUc) mUc.addEventListener('click', () => { menu.innerHTML = '<a role="menuitem" href="#/home/servicos/troca-titularidade">Troca de Titularidade</a> <a role="menuitem" href="#/home/servicos/ligacao-nova">Ligação Nova</a>'; });
  const mInst = document.getElementById('m-inst');
  if (mInst) mInst.addEventListener('click', () => { menu.innerHTML = '<a role="menuitem" href="#/institucional">Sobre a Neoenergia</a> <a role="menuitem" href="#/investidores">Investidores</a>'; });
  const mReg = document.getElementById('m-reg');
  if (mReg && REGIAO_JANELA) mReg.addEventListener('click', () => {
    const d = document.createElement('div'); d.id = 'dlg-reg'; d.setAttribute('role', 'dialog');
    d.innerHTML = '<h2>Selecione sua região</h2><select id="sel-reg"><option value="">Escolha</option>'
      + REGIOES.map((r) => '<option>' + r + '</option>').join('') + '</select> <button id="ok-reg">CONFIRMAR</button>';
    document.body.appendChild(d);
    document.getElementById('ok-reg').addEventListener('click', () => {
      const v = document.getElementById('sel-reg').value; if (!v) return;
      localStorage.setItem('regiaoSel', v); d.remove(); render();
    });
  });
  else if (mReg) mReg.addEventListener('click', () => {
    menu.innerHTML = '<p>Selecione sua região</p>' + REGIOES.map((r) => '<button role="menuitem" class="op-reg">' + r + '</button>').join(' ');
    menu.querySelectorAll('.op-reg').forEach((b) => b.addEventListener('click', () => { localStorage.setItem('regiaoSel', b.textContent); render(); }));
  });
  if (voltaLogin) abrirDialogoReal();
  const mVoce = document.getElementById('m-voce');
  if (mVoce) mVoce.addEventListener('click', () => { menu.innerHTML = '<a role="menuitem" href="#/home/servicos/atualizacao-cadastral">Atualização Cadastral</a>'; });
  // Lista de UCs: pesquisa por número novo ou código antigo; clique no cartão abre a UC.
  const pesq = document.getElementById('pesq');
  if (pesq) pesq.addEventListener('click', () => { sessionStorage.setItem('filtro', so(document.getElementById('busca').value)); render(); });
  document.querySelectorAll('.card-uc').forEach((c) => c.addEventListener('click', () => {
    sessionStorage.setItem('ucSel', c.getAttribute('data-uc')); sessionStorage.removeItem('filtro');
    if (location.hash === '#/home') render(); else ir('#/home');
  }));
  const svc = document.getElementById('svc-fat');
  if (svc) svc.addEventListener('click', () => ir('#/home/servicos/consultar-debitos'));
  // MAIS OPÇÕES -> Opções de fatura -> Download -> janela "Carregando" -> BAIXAR
  const mais = document.getElementById('mais');
  if (mais) mais.addEventListener('click', () => {
    const m = document.getElementById('menu-op');
    m.innerHTML = '<div role="menuitem">Opções de pagamento</div><div role="menuitem" id="op-fat">Opções de fatura</div><div id="sub"></div>';
    document.getElementById('op-fat').addEventListener('click', () => {
      document.getElementById('sub').innerHTML = '<div role="menuitem" id="dl">Download</div><div role="menuitem">Visualizar</div><div role="menuitem">Enviar por e-mail</div>';
      document.getElementById('dl').addEventListener('click', () => {
        const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.innerHTML = '<p>Carregando</p>';
        document.body.appendChild(d);
        setTimeout(() => {
          d.innerHTML = '<button id="baixar">BAIXAR</button> <button>Cancelar</button>';
          document.getElementById('baixar').addEventListener('click', async () => {
            const r = await fetch('/api/ucs/' + sessionStorage.getItem('ucSel') + '/faturas/1/pdf'); await r.json(); d.remove();
          });
        }, 600);
      });
    });
  });
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
    if (url.pathname === '/conta/login') {
      if (opts.contador) opts.contador.logins++;
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
    }
    if (url.pathname.startsWith('/api/')) {
      const uc = url.pathname.match(/\/ucs\/(\d+)\//)?.[1] ?? '';
      const escolhido = porUc[uc] ?? padrao;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ fileName: 'fatura.pdf', fileData: escolhido.toString('base64') }) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: htmlApp(modo, padrao.toString('base64'), opts) });
  });
}
