// server.js

require('dotenv').config();
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const express     = require('express');
const cors        = require('cors');
const Joi         = require('joi');
const { GoogleSpreadsheet } = require('google-spreadsheet');


// helper para normalizar cabeçalhos de coluna
function normalizeHeader(h) {
  return h
    .normalize('NFD')                    // separa acentos
    .replace(/[\u0300-\u036f]/g, '')     // remove acentos
    .replace(/\s+/g, ' ')                // espaços únicos
    .trim()                              // tira espaços nas pontas
    .toLowerCase();
}

// esquema de validação do payload
const schema = Joi.object({
  cpf: Joi.string().pattern(/^\d{11}$/).required()
});

const app = express();

// 1) Security headers
app.use(helmet());
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "https://cdnjs.cloudflare.com"],
      styleSrc:   ["'self'"],
      imgSrc:     ["'self'", "data:"],
    }
  })
);

// 2) CORS restrito
app.use(cors({
  origin: ['https://confirmacao-conaprev82.netlify.app']
}));

// 3) JSON body parser
app.use(express.json());

// 4) Rate limiter para /confirm
const confirmLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minuto
  max: 10,                  // até 10 requisições/minuto por IP
  message: { 
    error: 'Muitas requisições. Tente novamente mais tarde.' 
  }
});
app.use('/confirm', confirmLimiter);


// configura Google Sheets
const creds = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
);
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
async function accessSheet() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

/* em DEV sempre 'Dia1'
function getSheetNameAndTime() {
  return 'Dia1';
 */ 
  // Em produção:
  const now = new Date();
  const d = now.getDate(), m = now.getMonth()+1, y = now.getFullYear();
  const minutes = now.getHours()*60 + now.getMinutes();
  if (y===2025 && m===8 && d===12 && minutes>=510 && minutes<=1050) return 'Dia1';
  if (y===2025 && m===8 && d===13 && minutes>=510 && minutes<=780) return 'Dia2';
  throw new Error('HORARIO_INVALIDO');
  
}

app.post('/confirm', async (req, res) => {
  // 1) validação do payload
  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: 'CPF inválido. Use 11 dígitos.' });
  }
  const { cpf } = value;

  // 2) determina a aba de check-in
  let sheetName;
  try {
    sheetName = getSheetNameAndTime();
  } catch {
    return res.status(400).json({ error: 'Fora do horário permitido.' });
  }

  try {
    await accessSheet();

    // 3) perfis a checar
    const perfis = [
      'Conselheiros','CNRPPS','Palestrantes','Staffs',
      'Convidados','COPAJURE','Patrocinadores'
    ];

    // 4) busca em todas as abas, acumulando matches
    const matches = [];
    for (const aba of perfis) {
      const ws = doc.sheetsByTitle[aba];
      if (!ws) continue;

      await ws.loadHeaderRow();
      const headers   = ws.headerValues;
      const normHeads = headers.map(normalizeHeader);

      const iCpf   = normHeads.findIndex(h => h === 'cpf');
      const iNome  = normHeads.findIndex(h => h.includes('nome'));
      const iInscr = normHeads.findIndex(h => h.includes('inscricao'));
      if (iCpf < 0 || iNome < 0 || iInscr < 0) {
        throw new Error(`Aba "${aba}" sem colunas obrigatórias: ${headers.join(', ')}`);
      }

      const [cpfKey, nomeKey, inscrKey] = [iCpf, iNome, iInscr].map(i => headers[i]);
      const rows = await ws.getRows({ offset: 0, limit: ws.rowCount });

      const found = rows.find(r => {
        const raw = String(r[cpfKey] || '').trim();
        return raw.replace(/\D/g, '') === cpf;
      });

      if (found) {
        matches.push({
          aba,
          nome:      String(found[nomeKey]  || '').trim(),
          inscricao: String(found[inscrKey] || '').trim()
        });
      }
    }

    // 5) se não achou em nenhuma aba
    if (matches.length === 0) {
      return res.status(404).json({ error: 'CPF não inscrito.' });
    }

    // 6) escolhe quem tiver inscrição ou o primeiro
    const best = matches.find(m => m.inscricao) || matches[0];
    const { nome, inscricao } = best;

    // 7) se mesmo assim não tiver inscrição
    if (!inscricao) {
      return res.status(400).json({
        error: `Olá ${nome}, você não possui número de inscrição.`
      });
    }

    // 8) prepara a aba de check-in
    const checkin = doc.sheetsByTitle[sheetName];
    await checkin.loadHeaderRow();
    const chkHeaders = checkin.headerValues;
    const normChk    = chkHeaders.map(normalizeHeader);

    const idx = {
      inscr: normChk.findIndex(h => h.includes('inscricao')),
      nome:  normChk.findIndex(h => h.includes('nome')),
      data:  normChk.findIndex(h => h === 'data'),
      hora:  normChk.findIndex(h => h.includes('horario'))
    };
    if (Object.values(idx).some(i => i < 0)) {
      throw new Error(`Aba "${sheetName}" faltam colunas de check-in obrigatórias`);
    }
    const [chkInscrKey, chkNomeKey, chkDataKey, chkHoraKey]
      = ['inscr', 'nome', 'data', 'hora'].map(k => chkHeaders[idx[k]]);

    // 9) detecta duplicata
    const existing = await checkin.getRows({ offset: 0, limit: checkin.rowCount });
    const dup = existing.find(r =>
      String(r._rawData[idx.inscr] || '').trim() === inscricao
    );
    if (dup) {
      return res.status(409).json({
        message:   `Inscrição já confirmada em ${dup._rawData[idx.data]} às ${dup._rawData[idx.hora]}.`,
        nome, inscricao,
        dia: sheetName,
        data: dup._rawData[idx.data],
        hora: dup._rawData[idx.hora]
      });
    }

    // 10) grava check-in
    const now  = new Date();
    const data = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hora = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
    });

    await checkin.addRow({
      [chkInscrKey]: inscricao,
      [chkNomeKey]:  nome,
      [chkDataKey]:  data,
      [chkHoraKey]:  hora
    });

    // 11) resposta de sucesso
    return res.json({ inscricao, nome, dia: sheetName, data, hora });

  } catch (err) {
    console.error('Erro no /confirm:', err);
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

// health-check
app.get('/', (_req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
