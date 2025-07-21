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
    
    // nomes das abas onde buscamos o cadastro
    const perfis = ['Conselheiros', 'CNRPPS', 'Palestrantes', 'Staffs', 'Convidados', 'COPAJURE', 'Patrocinadores'];
    let inscritoData = null;

    for (const aba of perfis) {
      const perfilSheet = doc.sheetsByTitle[aba];
      await perfilSheet.loadHeaderRow();
      const headers = perfilSheet.headerValues;

      // detecta dinamicamente a coluna de inscrição e a de nome
      const inscrKey = headers.find(h => h.toLowerCase().includes('inscri'));
      const nomeKey   = headers.find(h => h.toLowerCase().includes('nome'));
      const rows = await perfilSheet.getRows();

      const found = rows.find(r =>
        String(r.CPF).replace(/\D/g, '') === cpf
      );
      if (found) {
        inscritoData = {
          inscricao: String(found[inscrKey] || '').trim(),
          nome:      String(found[nomeKey]   || '').trim()
        };
        break;
      }
    }

    if (!inscritoData) {
      return res.status(404).json({ error: 'CPF não inscrito.' });
    }

    //quem não tiver um número válido na coluna “NUMERO DE INSCRIÇÃO” é impedido de chegar até o passo de gravar o check-in.
    if (!inscritoData.inscricao) {
      return res
      .status(400)
      .json({
        error: `Olá ${inscritoData.nome}, você não possui número de inscrição.`
      });
    }

    // 2) Prepara a aba de check-in (Dia1 ou Dia2)
    const checkinSheet = doc.sheetsByTitle[sheetName];
    await checkinSheet.loadHeaderRow();
    const chkHeaders = checkinSheet.headerValues;

    //Caso alguma das colunas não seja encontrada
    if (
      !chkHeaders.find(h => h.toLowerCase().includes('numero de inscrição')) ||
      !chkHeaders.find(h => h.toLowerCase().includes('nome'))   ||
      !chkHeaders.find(h => h.toLowerCase().includes('data'))   ||
      (
        !chkHeaders.find(h => h.toLowerCase().includes('horário')) &&
        !chkHeaders.find(h => h.toLowerCase().includes('horario'))
      )
    ) {
      throw new Error(
        `Colunas de check-in não encontradas em ${sheetName}: ${chkHeaders.join(', ')}`
      );
    }

    // encontra dinamicamente as colunas de check-in
    const chkInscrKey = chkHeaders.find(h => h.toLowerCase().includes('numero de inscrição'));
    const chkNomeKey  = chkHeaders.find(h => h.toLowerCase().includes('nome'));
    const chkDataKey  = chkHeaders.find(h => h.toLowerCase().includes('data'));
    const chkHoraKey  = chkHeaders.find(h =>
      h.toLowerCase().includes('horário') ||
      h.toLowerCase().includes('horario')
    );

    // 3) Verifica duplicata
    const existingRows = await checkinSheet.getRows();
    const foundCheckin = existingRows.find(r =>
      String(r[chkInscrKey]).trim() === inscritoData.inscricao
    );

    if (foundCheckin) {
      // Retorna 409 e todos os dados que o frontend precisa
      return res.status(409).json({
        message:   `Inscrição já confirmada em ${foundCheckin[chkDataKey]} às ${foundCheckin[chkHoraKey]}.`,
        nome:      inscritoData.nome,
        inscricao: inscritoData.inscricao,
        dia:       sheetName,
        data:      foundCheckin[chkDataKey],
        hora:      foundCheckin[chkHoraKey],
      });
    }

    // 4) Adiciona o check-in
    const now  = new Date();
    const data = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hora = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
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
    return res.status(500).json({ error: 'Erro interno. Tente novamente em alguns instantes.' });
  }
});

// health‐check
app.get('/', (_req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});