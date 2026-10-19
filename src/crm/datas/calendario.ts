/**
 * Datas de relacionamento — o calendário e as mensagens prontas.
 *
 * Quatro tipos de evento:
 *   aniversario  — nascimento do cliente (crm_contacts.birthdate_ts)
 *   apolice      — aniversário de início de uma apólice (vector_apolices)
 *   comemorativa — Dia das Mães, Natal, Outubro Rosa…
 *   profissao    — Dia do Médico, do Advogado… casado com a profissão do
 *                  cliente (crm_contacts.title), para o corretor saber a
 *                  quem mandar.
 *
 * Função pura (sem banco): quem chama entrega contatos e apólices. Datas
 * sempre como 'AAAA-MM-DD' no fuso de Brasília — um corretor olhando o
 * celular às 22h do dia 9 não pode ver o alerta do dia 10.
 *
 * Nas mensagens: {nome} = primeiro nome do cliente, {corretor} = nome do
 * corretor (perfil da Apresentação), {anos} = anos da apólice ou de idade.
 */

export type TipoEvento = 'aniversario' | 'apolice' | 'comemorativa' | 'profissao';

export interface ContatoData { id: string; nome: string; telefone?: string | null; nascimento?: string | null; profissao?: string | null }
export interface ApoliceData { id: string; contatoId: string; nome: string; inicio: string }

export interface Evento {
  id: string;
  tipo: TipoEvento;
  data: string;           // AAAA-MM-DD
  titulo: string;
  descricao: string;
  contatos: Array<{ id: string; nome: string; telefone?: string | null }>;
  mensagens: string[];    // com {nome}/{corretor}/{anos}
  anos?: number;
  geral?: boolean;        // comemorativa: serve para qualquer cliente
}

// ─── Mensagens ───────────────────────────────────────────────────────────

export const MSG_ANIVERSARIO = [
  'Feliz aniversário, {nome}! 🎉 Que este novo ano venha cheio de saúde, conquistas e momentos especiais ao lado de quem você ama. Conte sempre comigo. Um grande abraço, {corretor}.',
  'Oi, {nome}! Hoje o dia é seu! 🎂 Desejo muita saúde, paz e prosperidade. Obrigado pela confiança de sempre. Parabéns! — {corretor}',
  '{nome}, parabéns pelo seu aniversário! 🥳 Que não falte saúde, alegria e tranquilidade, hoje e sempre. É um prazer cuidar da proteção de quem é especial. Abraço, {corretor}.',
];

export const MSG_APOLICE = [
  'Olá, {nome}! Hoje sua apólice completa {anos} de proteção. 🛡️ Obrigado pela confiança! É um ótimo momento para revisarmos juntos se as coberturas ainda acompanham a sua vida. Posso te ligar esta semana? — {corretor}',
  '{nome}, uma data especial: {anos} cuidando do que é importante para você e sua família. 💙 Se algo mudou (filhos, casa, renda), me conte que ajusto sua proteção. Abraço, {corretor}.',
  'Oi, {nome}! Passando para comemorar o aniversário da sua apólice: {anos} de tranquilidade. Estou à disposição para tirar dúvidas e revisar o que for preciso. — {corretor}',
];

interface Comemorativa {
  chave: string;
  titulo: string;
  /** 'MM-DD' fixo, ou regra móvel. */
  dia?: string;
  movel?: (ano: number) => string;
  descricao: string;
  mensagens: string[];
}

/** Enésimo domingo de um mês (Dia das Mães = 2º domingo de maio). */
export function enesimoDomingo(ano: number, mes: number, n: number): string {
  const d = new Date(Date.UTC(ano, mes - 1, 1));
  const primeiro = (7 - d.getUTCDay()) % 7 + 1;
  return iso(ano, mes, primeiro + (n - 1) * 7);
}

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher). */
export function pascoa(ano: number): string {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(ano, mes, dia);
}

const iso = (a: number, m: number, d: number) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export const COMEMORATIVAS: Comemorativa[] = [
  { chave: 'ano-novo', titulo: 'Ano Novo', dia: '01-01', descricao: 'Mensagem de boas-vindas ao novo ano.', mensagens: [
    'Feliz Ano Novo, {nome}! 🎆 Que este ano traga saúde, prosperidade e muita tranquilidade para você e sua família. Obrigado pela confiança. — {corretor}',
    '{nome}, um novo ano começa! Desejo que seja repleto de conquistas e que você siga protegido em cada passo. Conte comigo em {ano}! Abraço, {corretor}.',
  ] },
  { chave: 'dia-mulher', titulo: 'Dia Internacional da Mulher', dia: '03-08', descricao: 'Homenagem às clientes.', mensagens: [
    'Feliz Dia da Mulher, {nome}! 🌷 Admiro a força e o cuidado com que você conduz a vida. Que nunca falte saúde e segurança para seguir realizando. — {corretor}',
    '{nome}, hoje é dia de celebrar você! 💐 Obrigado por confiar em mim para cuidar da sua proteção. Um abraço carinhoso, {corretor}.',
  ] },
  { chave: 'pascoa', titulo: 'Páscoa', movel: pascoa, descricao: 'Domingo de Páscoa.', mensagens: [
    'Feliz Páscoa, {nome}! 🐣 Que este tempo de renovação traga paz, união e muita saúde para você e sua família. — {corretor}',
    '{nome}, desejo uma Páscoa cheia de esperança e de bons momentos em família. Um abraço, {corretor}.',
  ] },
  { chave: 'dia-saude', titulo: 'Dia Mundial da Saúde', dia: '04-07', descricao: 'Bom gancho para falar de cuidado e prevenção.', mensagens: [
    'Oi, {nome}! Hoje é o Dia Mundial da Saúde. 💚 Que tal aproveitar para marcar aquele check-up? Cuidar de si é o melhor investimento. Se quiser revisar suas coberturas de saúde e doenças graves, estou aqui. — {corretor}',
  ] },
  { chave: 'dia-seguro', titulo: 'Dia Continental do Seguro', dia: '05-14', descricao: 'Data do mercado de seguros.', mensagens: [
    '{nome}, hoje é o Dia Continental do Seguro! 🛡️ Obrigado por fazer parte da minha carteira e por entender o valor de proteger quem a gente ama. Qualquer dúvida, conte comigo. — {corretor}',
  ] },
  { chave: 'dia-maes', titulo: 'Dia das Mães', movel: (a) => enesimoDomingo(a, 5, 2), descricao: '2º domingo de maio.', mensagens: [
    'Feliz Dia das Mães, {nome}! 💐 Ser mãe é cuidar todos os dias — e é uma honra ajudar você a proteger quem você ama. Um abraço carinhoso, {corretor}.',
    '{nome}, hoje é dia de celebrar o amor mais forte que existe. ❤️ Que seu dia seja cheio de carinho e alegria. Feliz Dia das Mães! — {corretor}',
    'Oi, {nome}! Um feliz Dia das Mães para você e para a sua mãe. 🌷 Que nunca falte saúde e união na sua família. — {corretor}',
  ] },
  { chave: 'dia-namorados', titulo: 'Dia dos Namorados', dia: '06-12', descricao: 'Para clientes casais.', mensagens: [
    'Feliz Dia dos Namorados, {nome}! ❤️ Que o amor de vocês siga crescendo — e protegido. Um abraço, {corretor}.',
  ] },
  { chave: 'dia-avos', titulo: 'Dia dos Avós', dia: '07-26', descricao: 'Homenagem aos avós.', mensagens: [
    'Feliz Dia dos Avós, {nome}! 👵👴 Obrigado por ser exemplo de amor e cuidado para a família. Muita saúde para você! — {corretor}',
  ] },
  { chave: 'dia-pais', titulo: 'Dia dos Pais', movel: (a) => enesimoDomingo(a, 8, 2), descricao: '2º domingo de agosto.', mensagens: [
    'Feliz Dia dos Pais, {nome}! 👨‍👧‍👦 Ser pai é proteger sempre — e é uma alegria ajudar você nessa missão. Um grande abraço, {corretor}.',
    '{nome}, que seu dia seja cheio de carinho e boas memórias em família. Feliz Dia dos Pais! — {corretor}',
    'Oi, {nome}! Um feliz Dia dos Pais para você e para o seu pai. 💙 Muita saúde e união sempre. — {corretor}',
  ] },
  { chave: 'dia-cliente', titulo: 'Dia do Cliente', dia: '09-15', descricao: 'Agradecimento à carteira.', mensagens: [
    'Feliz Dia do Cliente, {nome}! 🤝 Obrigado pela confiança de sempre. Cuidar da sua proteção é um privilégio. Conte comigo para o que precisar. — {corretor}',
    '{nome}, hoje é o seu dia! Muito obrigado por fazer parte da minha história. Se quiser revisar algo da sua proteção, é só me chamar. — {corretor}',
  ] },
  { chave: 'outubro-rosa', titulo: 'Outubro Rosa', dia: '10-01', descricao: 'Mês de prevenção do câncer de mama.', mensagens: [
    'Oi, {nome}! Começou o Outubro Rosa. 🎗️ Um lembrete carinhoso: prevenção salva vidas, faça seus exames. E lembre que a cobertura de doenças graves ajuda a enfrentar o tratamento com tranquilidade. Qualquer dúvida, estou aqui. — {corretor}',
  ] },
  { chave: 'dia-criancas', titulo: 'Dia das Crianças', dia: '10-12', descricao: 'Para clientes com filhos.', mensagens: [
    'Feliz Dia das Crianças para os pequenos da sua família, {nome}! 🎈 Que eles cresçam cercados de amor e segurança. — {corretor}',
  ] },
  { chave: 'novembro-azul', titulo: 'Novembro Azul', dia: '11-01', descricao: 'Mês da saúde do homem.', mensagens: [
    'Oi, {nome}! Começou o Novembro Azul. 💙 Cuidar da saúde é um ato de amor com quem depende de você — faça seu check-up. Se quiser revisar suas coberturas, conte comigo. — {corretor}',
  ] },
  { chave: 'natal', titulo: 'Natal', dia: '12-25', descricao: 'Boas festas.', mensagens: [
    'Feliz Natal, {nome}! 🎄 Que sua casa esteja cheia de paz, amor e saúde. Obrigado pela confiança neste ano. — {corretor}',
    '{nome}, desejo um Natal abençoado e um Ano Novo de muitas conquistas para você e sua família. 🎁 Um abraço, {corretor}.',
  ] },
];

interface Profissao { chave: string; nome: string; dia: string; artigo: 'do' | 'da' | 'dos'; frase: string; sinonimos: string[] }

export const PROFISSOES: Profissao[] = [
  { chave: 'farmaceutico', nome: 'Farmacêutico', dia: '01-20', artigo: 'do', frase: 'Seu conhecimento cuida da saúde de tanta gente.', sinonimos: ['farmaceutic'] },
  { chave: 'publicitario', nome: 'Publicitário', dia: '02-01', artigo: 'do', frase: 'Criatividade que move negócios.', sinonimos: ['publicitar', 'marketing'] },
  { chave: 'jornalista', nome: 'Jornalista', dia: '04-07', artigo: 'do', frase: 'Informação de qualidade faz toda a diferença.', sinonimos: ['jornalist', 'reporter'] },
  { chave: 'policial', nome: 'Policial', dia: '04-21', artigo: 'do', frase: 'Obrigado por proteger a todos nós.', sinonimos: ['polici', 'delegad', 'investigador'] },
  { chave: 'enfermeiro', nome: 'Enfermeiro', dia: '05-12', artigo: 'do', frase: 'Seu cuidado faz a diferença na vida de muitas pessoas.', sinonimos: ['enfermeir', 'tecnico de enfermagem', 'tecnica de enfermagem'] },
  { chave: 'pedagogo', nome: 'Pedagogo', dia: '05-20', artigo: 'do', frase: 'Educar é construir o futuro.', sinonimos: ['pedagog'] },
  { chave: 'quimico', nome: 'Químico', dia: '06-18', artigo: 'do', frase: 'Ciência que transforma o nosso dia a dia.', sinonimos: ['quimic'] },
  { chave: 'bombeiro', nome: 'Bombeiro', dia: '07-02', artigo: 'do', frase: 'Coragem que salva vidas.', sinonimos: ['bombeir'] },
  { chave: 'comerciante', nome: 'Comerciante', dia: '07-16', artigo: 'do', frase: 'Quem empreende movimenta o país.', sinonimos: ['comerciant', 'lojista'] },
  { chave: 'motorista', nome: 'Motorista', dia: '07-25', artigo: 'do', frase: 'Obrigado por levar pessoas e sonhos com segurança.', sinonimos: ['motorist', 'caminhoneir', 'taxista', 'uber'] },
  { chave: 'agricultor', nome: 'Agricultor', dia: '07-28', artigo: 'do', frase: 'Seu trabalho põe comida na mesa do Brasil.', sinonimos: ['agricultor', 'produtor rural', 'fazendeir', 'pecuarist'] },
  { chave: 'advogado', nome: 'Advogado', dia: '08-11', artigo: 'do', frase: 'Defender direitos é uma missão nobre.', sinonimos: ['advogad', 'juridic', 'jurista'] },
  { chave: 'economista', nome: 'Economista', dia: '08-13', artigo: 'do', frase: 'Boas decisões começam com bons números.', sinonimos: ['economist'] },
  { chave: 'militar', nome: 'Soldado', dia: '08-25', artigo: 'do', frase: 'Obrigado pela dedicação ao país.', sinonimos: ['militar', 'soldad', 'exercito', 'sargento', 'tenente', 'capitao', 'coronel'] },
  { chave: 'psicologo', nome: 'Psicólogo', dia: '08-27', artigo: 'do', frase: 'Cuidar da mente é cuidar da vida.', sinonimos: ['psicolog', 'terapeut'] },
  { chave: 'corretor-imoveis', nome: 'Corretor de Imóveis', dia: '08-27', artigo: 'do', frase: 'Você realiza o sonho da casa própria de muita gente.', sinonimos: ['corretor de imove', 'corretora de imove', 'imobiliari'] },
  { chave: 'bancario', nome: 'Bancário', dia: '08-28', artigo: 'do', frase: 'Seu trabalho faz a vida financeira de muitos girar.', sinonimos: ['bancari', 'gerente de banco'] },
  { chave: 'nutricionista', nome: 'Nutricionista', dia: '08-31', artigo: 'do', frase: 'Saúde começa no prato.', sinonimos: ['nutricionist'] },
  { chave: 'educador-fisico', nome: 'Profissional de Educação Física', dia: '09-01', artigo: 'do', frase: 'Movimento é saúde — obrigado por inspirar tanta gente.', sinonimos: ['educacao fisica', 'educador fisico', 'personal', 'professor de educacao fisica'] },
  { chave: 'administrador', nome: 'Administrador', dia: '09-09', artigo: 'do', frase: 'Organizar e liderar é uma arte.', sinonimos: ['administrador', 'administradora', 'gestor', 'gestora'] },
  { chave: 'veterinario', nome: 'Veterinário', dia: '09-09', artigo: 'do', frase: 'Cuidar de quem não pode pedir ajuda é amor puro.', sinonimos: ['veterinari'] },
  { chave: 'programador', nome: 'Programador', dia: '09-13', artigo: 'do', frase: 'Você constrói o mundo digital em que vivemos.', sinonimos: ['programador', 'desenvolvedor', 'dev ', 'engenheiro de software', 'analista de sistemas', 'ti '] },
  { chave: 'contador', nome: 'Contador', dia: '09-22', artigo: 'do', frase: 'Seu trabalho dá segurança a tantas empresas e famílias.', sinonimos: ['contador', 'contadora', 'contabil'] },
  { chave: 'secretaria', nome: 'Secretária', dia: '09-30', artigo: 'da', frase: 'Organização e dedicação que fazem tudo funcionar.', sinonimos: ['secretari', 'assistente administrativ'] },
  { chave: 'vendedor', nome: 'Vendedor', dia: '10-01', artigo: 'do', frase: 'Quem vende move a economia.', sinonimos: ['vendedor', 'vendedora', 'representante comercial', 'consultor de vendas', 'comercial'] },
  { chave: 'empreendedor', nome: 'Empreendedor', dia: '10-05', artigo: 'do', frase: 'Coragem de começar e persistência de continuar.', sinonimos: ['empreendedor', 'empresari', 'socio', 'dono de'] },
  { chave: 'fisioterapeuta', nome: 'Fisioterapeuta', dia: '10-13', artigo: 'do', frase: 'Você devolve movimento e qualidade de vida.', sinonimos: ['fisioterapeut'] },
  { chave: 'professor', nome: 'Professor', dia: '10-15', artigo: 'do', frase: 'Ensinar é a profissão que forma todas as outras.', sinonimos: ['professor', 'professora', 'docente', 'educador', 'educadora'] },
  { chave: 'medico', nome: 'Médico', dia: '10-18', artigo: 'do', frase: 'Obrigado por cuidar da saúde de tantas pessoas.', sinonimos: ['medic', 'cirurgia', 'pediatra', 'cardiologist', 'ortopedist', 'dermatologist', 'ginecologist', 'anestesist', 'psiquiatra', 'oftalmologist', 'radiologist'] },
  { chave: 'chef', nome: 'Cozinheiro', dia: '10-20', artigo: 'do', frase: 'Sabor que une as pessoas.', sinonimos: ['cozinheir', 'chef', 'confeiteir', 'padeir'] },
  { chave: 'dentista', nome: 'Dentista', dia: '10-25', artigo: 'do', frase: 'Você cuida do sorriso de muita gente.', sinonimos: ['dentist', 'odontolog', 'ortodontist'] },
  { chave: 'servidor-publico', nome: 'Servidor Público', dia: '10-28', artigo: 'do', frase: 'Obrigado por servir a população.', sinonimos: ['servidor public', 'servidora public', 'funcionario public', 'funcionaria public', 'concursad'] },
  { chave: 'designer', nome: 'Designer', dia: '11-05', artigo: 'do', frase: 'Criatividade que dá forma às ideias.', sinonimos: ['designer', 'design '] },
  { chave: 'biomedico', nome: 'Biomédico', dia: '11-20', artigo: 'do', frase: 'Ciência a serviço da vida.', sinonimos: ['biomedic'] },
  { chave: 'fonoaudiologo', nome: 'Fonoaudiólogo', dia: '12-09', artigo: 'do', frase: 'Você ajuda as pessoas a se comunicarem melhor.', sinonimos: ['fonoaudiolog', 'fono '] },
  { chave: 'engenheiro', nome: 'Engenheiro', dia: '12-11', artigo: 'do', frase: 'Você constrói o que move o mundo.', sinonimos: ['engenheir'] },
  { chave: 'arquiteto', nome: 'Arquiteto', dia: '12-15', artigo: 'do', frase: 'Você transforma espaços em lares.', sinonimos: ['arquitet'] },
];

export const MSG_PROFISSAO = [
  'Olá, {nome}! Hoje é o {dia}. 👏 {frase} Parabéns pela sua dedicação! Um abraço, {corretor}.',
  '{nome}, feliz {dia}! {frase} Obrigado pela confiança — e conte comigo para proteger o que você conquistou com o seu trabalho. — {corretor}',
];

// ─── Utilidades ──────────────────────────────────────────────────────────

/** "Médico(a) Cirurgião" → "medico(a) cirurgiao" para comparar profissões. */
export function normalizar(s: string): string {
  return ` ${String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
}

export function profissaoDo(titulo?: string | null): Profissao | null {
  if (!titulo) return null;
  const t = normalizar(titulo);
  // Sinônimo casa no começo de palavra ("medic" pega "médica", não "biomédico").
  // Sinônimo terminado em espaço exige a palavra inteira ("ti ", "dev ").
  // O mais longo vence: "corretor de imove" antes de "comercial".
  let melhor: Profissao | null = null, tam = 0;
  for (const p of PROFISSOES) for (const s of p.sinonimos) {
    if (t.includes(' ' + s) && s.length > tam) { melhor = p; tam = s.length; }
  }
  return melhor;
}

/** Hoje em Brasília, como 'AAAA-MM-DD'. */
export function hojeBrasilia(agora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

const somarDias = (d: string, n: number) => {
  const [a, m, dd] = d.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, dd + n));
  return iso(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
};

/** Aniversário de 29/02 cai em 28/02 nos anos não bissextos. */
function noAno(ano: number, mmdd: string): string {
  const [m, d] = mmdd.split('-').map(Number);
  if (m === 2 && d === 29) {
    const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
    return iso(ano, 2, bissexto ? 29 : 28);
  }
  return iso(ano, m, d);
}

export function primeiroNome(nome: string): string {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : '';
}

/** Troca {nome}, {corretor}, {anos}, {ano}, {dia}, {frase}. */
export function preencher(texto: string, v: Record<string, string | number | undefined>): string {
  return texto.replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined && v[k] !== '' ? String(v[k]) : m))
    .replace(/,? ?—? ?\{corretor\}\.?/g, '') // sem corretor no perfil: some a assinatura
    .replace(/\s+([.,!?])/g, '$1').trim();
}

const plural = (n: number, s: string, p: string) => `${n} ${n === 1 ? s : p}`;

/**
 * Eventos entre `inicio` e `inicio + dias` (inclusive), em ordem de data.
 * Comemorativas e dias de profissão aparecem mesmo sem cliente casado —
 * o corretor pode mandar para a carteira inteira.
 */
export function eventosEntre(inicio: string, dias: number, contatos: ContatoData[], apolices: ApoliceData[]): Evento[] {
  const fim = somarDias(inicio, dias);
  const anoIni = Number(inicio.slice(0, 4)), anoFim = Number(fim.slice(0, 4));
  const dentro = (d: string) => d >= inicio && d <= fim;
  const eventos: Evento[] = [];
  const porId = new Map(contatos.map((c) => [c.id, c]));

  for (let ano = anoIni; ano <= anoFim; ano++) {
    for (const c of contatos) {
      if (!c.nascimento) continue;
      const d = noAno(ano, c.nascimento.slice(5));
      if (!dentro(d)) continue;
      const idade = ano - Number(c.nascimento.slice(0, 4));
      eventos.push({
        id: `aniv-${c.id}-${ano}`, tipo: 'aniversario', data: d,
        titulo: `Aniversário de ${c.nome}`,
        descricao: idade > 0 && idade < 120 ? `Faz ${idade} anos` : 'Aniversário do cliente',
        contatos: [{ id: c.id, nome: c.nome, telefone: c.telefone }],
        mensagens: MSG_ANIVERSARIO, anos: idade,
      });
    }
    for (const a of apolices) {
      const c = porId.get(a.contatoId);
      if (!c || !a.inicio) continue;
      const anos = ano - Number(a.inicio.slice(0, 4));
      if (anos < 1) continue;
      const d = noAno(ano, a.inicio.slice(5));
      if (!dentro(d)) continue;
      eventos.push({
        id: `apol-${a.id}-${ano}`, tipo: 'apolice', data: d,
        titulo: `Apólice de ${c.nome}`,
        descricao: `${a.nome || 'Apólice'} — ${plural(anos, 'ano', 'anos')}`,
        contatos: [{ id: c.id, nome: c.nome, telefone: c.telefone }],
        mensagens: MSG_APOLICE.map((m) => m.replace('{anos}', plural(anos, 'ano', 'anos'))), anos,
      });
    }
    for (const cm of COMEMORATIVAS) {
      const d = cm.movel ? cm.movel(ano) : noAno(ano, cm.dia!);
      if (!dentro(d)) continue;
      eventos.push({
        id: `com-${cm.chave}-${ano}`, tipo: 'comemorativa', data: d, titulo: cm.titulo, descricao: cm.descricao,
        contatos: contatos.map((c) => ({ id: c.id, nome: c.nome, telefone: c.telefone })),
        mensagens: cm.mensagens.map((m) => m.replace('{ano}', String(ano))), geral: true,
      });
    }
    for (const p of PROFISSOES) {
      const d = noAno(ano, p.dia);
      if (!dentro(d)) continue;
      const dia = `Dia ${p.artigo} ${p.nome}`;
      const casados = contatos.filter((c) => profissaoDo(c.profissao)?.chave === p.chave);
      eventos.push({
        id: `prof-${p.chave}-${ano}`, tipo: 'profissao', data: d, titulo: dia,
        descricao: casados.length ? `${plural(casados.length, 'cliente', 'clientes')} com essa profissão` : 'Nenhum cliente cadastrado com essa profissão',
        contatos: casados.map((c) => ({ id: c.id, nome: c.nome, telefone: c.telefone })),
        mensagens: MSG_PROFISSAO.map((m) => m.replace('{dia}', dia).replace('{frase}', p.frase)),
      });
    }
  }
  const ordem: Record<TipoEvento, number> = { aniversario: 0, apolice: 1, profissao: 2, comemorativa: 3 };
  return eventos.sort((a, b) => a.data.localeCompare(b.data) || ordem[a.tipo] - ordem[b.tipo] || a.titulo.localeCompare(b.titulo));
}

/** Biblioteca do ano: todas as comemorativas e profissões com a data daquele ano. */
export function biblioteca(ano: number) {
  return [
    ...COMEMORATIVAS.map((c) => ({ chave: c.chave, tipo: 'comemorativa' as const, titulo: c.titulo, data: c.movel ? c.movel(ano) : noAno(ano, c.dia!), descricao: c.descricao, mensagens: c.mensagens.map((m) => m.replace('{ano}', String(ano))) })),
    ...PROFISSOES.map((p) => {
      const dia = `Dia ${p.artigo} ${p.nome}`;
      return { chave: p.chave, tipo: 'profissao' as const, titulo: dia, data: noAno(ano, p.dia), descricao: p.frase, mensagens: MSG_PROFISSAO.map((m) => m.replace('{dia}', dia).replace('{frase}', p.frase)) };
    }),
    { chave: 'aniversario', tipo: 'aniversario' as const, titulo: 'Aniversário do cliente', data: '', descricao: 'Modelos para o aniversário de nascimento.', mensagens: MSG_ANIVERSARIO },
    { chave: 'apolice', tipo: 'apolice' as const, titulo: 'Aniversário de apólice', data: '', descricao: 'Modelos para o aniversário da apólice ({anos} vira "2 anos").', mensagens: MSG_APOLICE },
  ].sort((a, b) => (a.data || '9').localeCompare(b.data || '9'));
}
