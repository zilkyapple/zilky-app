export function badRequest(message) { return Object.assign(new Error(message), {status:400}); }
export function integer(value, name, {min=0,max=2147483647}={}) {
  if (!Number.isSafeInteger(value) || value<min || value>max) throw badRequest(`${name} debe ser un entero entre ${min} y ${max}`);
  return value;
}
export function dateISO(value, name='fecha') {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value) throw badRequest(`${name} inválida`);
  return value;
}
export function text(value, name, max=2000) {
  if (typeof value!=='string' || !value.trim() || value.length>max) throw badRequest(`${name} inválido`);
  return value.trim();
}
