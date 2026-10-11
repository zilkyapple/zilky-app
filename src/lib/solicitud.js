import {createHash} from 'node:crypto';
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function solicitudId(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw fail('Solicitud inválida');return value;}
function ordenado(v){if(Array.isArray(v))return v.map(ordenado);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordenado(v[k])]));return v;}
export const huella=v=>createHash('sha256').update(JSON.stringify(ordenado(v))).digest('hex');
