// server.js

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(cors(), express.json());

// Decodifica e parseia o JSON inteiro da conta de serviço
const creds = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
);
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);

async function accessSheet() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// em DEV sempre escreve na aba "Dia1"
function getSheetNameAndTime() {
  // comente as validações reais e libere esta linha em DEV:
  return 'Dia1';
  // — em produção você reabilita esta lógica:
  /*
  const now = new Date();
  const dia = now.getDate();
  const mes = now.getMonth()+1;
  const ano = now.getFullYear();
  const minutos = now.getHours()*60 + now.getMinutes();
  if (ano === 2025 && mes === 8 && dia === 12 && minutos>=510 && minutos<=1050) return 'Dia1';
  if (ano === 2025 && mes === 8 && dia === 13 && minutos>=510 && minutos<=780) return 'Dia2';
  throw new Error('HORARIO_INVALIDO');
  */
}

app.post('/confirm', async (req, res) => {
  const { cpf } = req.body;
  if (!cpf || !/^\d{11}$/.test(cpf)) {
    return res.status(400).json({ error: 'CPF inválido. Use 11 dígitos.' });
  }

  let sheetName;
  try {
    sheetName = getSheetNameAndTime();
  } catch {
    return res.status(400).json({ error: 'Fora do horário permitido.' });
  }

  try {
    await accessSheet();

    // 1) Buscar cadastro em qualquer perfil
    const perfis = [
      'Conselheiros','CNRPPS','Palestrantes','Staffs',
      'Convidados','COPAJURE','Patrocinadores'
    ];
    let inscritoData = null;

    for (const aba of perfis) {
      const perfilSheet = doc.sheetsByTitle[aba];
      await perfilSheet.loadHeaderRow();
      const headers = perfilSheet.headerValues;

      // detecta colunas de inscrição, nome e cpf
      const inscrKey = headers.find(h => h.toLowerCase().includes('inscri'));
      const nomeKey  = headers.find(h => h.toLowerCase().includes('nome'));
      const cpfKey   = headers.find(h => h.toLowerCase().includes('cpf'));
      if (!cpfKey) {
        throw new Error(`Na aba "${aba}" não foi encontrada uma coluna de CPF: ${headers.join(', ')}`);
      }

      const rows = await perfilSheet.getRows();
      const found = rows.find(r =>
        String((r[cpfKey]||'')).replace(/\D/g,'') === cpf
      );
      if (found) {
        inscritoData = {
          inscricao: String(found[inscrKey]||'').trim(),
          nome:      String(found[nomeKey]||'').trim()
        };
        break;
      }
    }

    if (!inscritoData) {
      return res.status(404).json({ error: 'CPF não inscrito.' });
    }

    // 2) Impedir quem não tiver número de inscrição
    if (!inscritoData.inscricao) {
      return res.status(400).json({
        error: `Olá ${inscritoData.nome}, você não possui número de inscrição.`
      });
    }

    // 3) Prepara aba de check-in e carrega cabeçalhos
    const checkinSheet = doc.sheetsByTitle[sheetName];
    await checkinSheet.loadHeaderRow();
    const chkHeaders = checkinSheet.headerValues;

    // valida presença das colunas obrigatórias
    const chkInscrKey = chkHeaders.find(h => h.toLowerCase().includes('numero de inscrição'));
    const chkNomeKey  = chkHeaders.find(h => h.toLowerCase().includes('nome'));
    const chkDataKey  = chkHeaders.find(h => h.toLowerCase().includes('data'));
    const chkHoraKey  = chkHeaders.find(h =>
      h.toLowerCase().includes('horário') ||
      h.toLowerCase().includes('horario')
    );

    if (!chkInscrKey || !chkNomeKey || !chkDataKey || !chkHoraKey) {
      throw new Error(
        `Na aba "${sheetName}" faltam colunas de check-in: ` +
        `inscricao="${chkInscrKey}", nome="${chkNomeKey}", ` +
        `data="${chkDataKey}", hora="${chkHoraKey}"`
      );
    }

    // 4) Verifica duplicata
    const existingRows = await checkinSheet.getRows();
    const foundCheckin = existingRows.find(r =>
      String(r[chkInscrKey]).trim() === inscritoData.inscricao
    );
    if (foundCheckin) {
      return res.status(409).json({
        message:   `Inscrição já confirmada em ${foundCheckin[chkDataKey]} às ${foundCheckin[chkHoraKey]}.`,
        nome:      inscritoData.nome,
        inscricao: inscritoData.inscricao,
        dia:       sheetName,
        data:      foundCheckin[chkDataKey],
        hora:      foundCheckin[chkHoraKey],
      });
    }

    // 5) Grava check-in
    const now  = new Date();
    const data = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hora = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo'
    });

    await checkinSheet.addRow({
      [chkInscrKey]: inscritoData.inscricao,
      [chkNomeKey]:  inscritoData.nome,
      [chkDataKey]:  data,
      [chkHoraKey]:  hora
    });

    return res.json({
      inscricao: inscritoData.inscricao,
      nome:      inscritoData.nome,
      dia:       sheetName,
      data,
      hora
    });

  } catch (err) {
    console.error('Erro no /confirm:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Erro interno. Tente novamente.' });
  }
});

// health‐check
app.get('/', (_req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});