const MAX_EVENTS = 120;
const events = [];
let sequence = 0;

function cleanText(value, maxLength = 240) {
  return String(value || '')
    .replace(/https?:\/\/[^\s]+/gi, '[地址已隐藏]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, maxLength);
}

function cleanMeta(meta) {
  const output = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' || typeof value === 'boolean') output[key] = value;
    else output[key] = cleanText(value, 120);
  }
  return output;
}

export function recordDiagnostic(level, event, message, meta = {}) {
  const entry = {
    id: ++sequence,
    at: new Date().toISOString(),
    level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
    event: cleanText(event, 80),
    message: cleanText(message),
    meta: cleanMeta(meta),
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return entry;
}

export function diagnosticEvents(limit = 60) {
  const count = Math.max(1, Math.min(MAX_EVENTS, Number.parseInt(limit, 10) || 60));
  return events.slice(-count).reverse();
}

export function clearDiagnostics() {
  events.length = 0;
}
