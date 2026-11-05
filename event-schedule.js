(function exposeSchedule(root, factory) {
  const schedule = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = schedule;
  if (root) root.CONAPREV_EVENT_SCHEDULE = schedule;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const EVENT_TIME_ZONE = 'America/Sao_Paulo';
  const EVENT_NAME = '86ª Reunião Ordinária do CONAPREV';

  const WINDOWS = Object.freeze([
    Object.freeze({
      day: 'Dia1',
      label: 'primeiro dia',
      opensAt: '2026-11-05T08:00:00-03:00',
      closesAt: '2026-11-05T18:00:00-03:00',
      openingMessage: 'A confirmação de presença estará disponível a partir das 08h00 do dia 5 de novembro de 2026.'
    }),
    Object.freeze({
      day: 'Dia2',
      label: 'segundo dia',
      opensAt: '2026-11-06T08:30:00-03:00',
      closesAt: '2026-11-06T15:00:00-03:00',
      openingMessage: 'A confirmação de presença estará disponível a partir das 08h30 do dia 6 de novembro de 2026.'
    })
  ]);

  function asDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Relógio inválido para avaliação da janela do evento.');
    return date;
  }

  function getWindowStatus(clock = new Date()) {
    const now = asDate(clock);

    for (let index = 0; index < WINDOWS.length; index += 1) {
      const window = WINDOWS[index];
      const opensAt = new Date(window.opensAt);
      const closesAt = new Date(window.closesAt);

      if (now >= opensAt && now < closesAt) {
        return { status: 'open', day: window.day, label: window.label, opensAt, closesAt };
      }

      if (now < opensAt) {
        return {
          status: 'before',
          nextDay: window.day,
          label: window.label,
          nextStart: opensAt,
          message: window.openingMessage
        };
      }
    }

    return {
      status: 'after',
      message: 'O período de confirmação de presença deste dia foi encerrado.'
    };
  }

  return Object.freeze({ EVENT_TIME_ZONE, EVENT_NAME, WINDOWS, getWindowStatus });
}));
