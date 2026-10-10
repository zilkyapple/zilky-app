import {Router} from 'express';
import {db} from '../db/connection.js';
import {requireAdmin} from '../middleware/authorize.js';
import {configuracionComision,resumenComisiones} from '../services/comisionesService.js';
import {dateISO} from '../lib/validation.js';
export function csvCell(value){let s=String(value??'');if(/^[\s]*[=+@-]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function rowsCSV(rows){const keys=Object.keys(rows[0]||{});return '\uFEFF'+[keys.map(csvCell).join(';'),...rows.map(r=>keys.map(k=>csvCell(r[k])).join(';'))].join('\r\n');}
export const exportacionesRouter=Router();exportacionesRouter.use(requireAdmin);
exportacionesRouter.get('/',async(req,res,next)=>{try{
 const {negocio_id:n,tipo,desde,hasta}=req.query;
 if(typeof n!=='string')return res.status(400).json({error:'Elegí un negocio'});await configuracionComision(n);dateISO(desde);dateISO(hasta);if(desde>hasta)return res.status(400).json({error:'Rango inválido'});
 let rows;
 if(tipo==='clientes')rows=await db.prepare(`SELECT c.id,c.nombre,c.apellido,c.telefono,c.dni,c.direccion,c.ciudad,c.provincia,c.notas FROM clientes c JOIN cliente_negocio cn ON cn.cliente_id=c.id WHERE cn.negocio_id=? ORDER BY c.nombre`).all(n);
 else if(tipo==='ventas')rows=await db.prepare(`SELECT v.id,v.fecha,c.nombre,c.apellido,v.modalidad,v.monto_total_centavos/100.0 AS total_pesos,v.entrega_inicial_centavos/100.0 AS entrega_pesos,v.notas FROM ventas v JOIN clientes c ON c.id=v.cliente_id WHERE v.negocio_id=? AND v.fecha BETWEEN ? AND ? ORDER BY v.fecha,v.id`).all(n,desde,hasta);
 else if(tipo==='pagos')rows=await db.prepare(`SELECT p.id,p.fecha_hora,c.nombre,c.apellido,p.credito_id,p.tipo,p.monto_centavos/100.0 AS importe_pesos,p.medio_pago,p.anulado,p.motivo_anulacion,p.nota FROM pagos p JOIN clientes c ON c.id=p.cliente_id WHERE p.negocio_id=? AND substring(p.fecha_hora,1,10) BETWEEN ? AND ? ORDER BY p.fecha_hora,p.id`).all(n,desde,hasta);
 else if(tipo==='cuotas')rows=await db.prepare(`SELECT q.id,cr.id AS credito_id,c.nombre,c.apellido,q.numero,q.fecha_vencimiento,q.monto_centavos/100.0 AS importe_pesos,q.saldo_pendiente_centavos/100.0 AS capital_pendiente_pesos,q.mora_generada_centavos/100.0 AS mora_registrada_pesos,q.mora_pagada_centavos/100.0 AS mora_pagada_pesos,q.mora_perdonada_centavos/100.0 AS mora_perdonada_pesos,q.fecha_saldada,q.estado_manual FROM cuotas q JOIN creditos cr ON cr.id=q.credito_id JOIN clientes c ON c.id=cr.cliente_id WHERE cr.negocio_id=? AND q.fecha_vencimiento BETWEEN ? AND ? ORDER BY q.fecha_vencimiento,q.id`).all(n,desde,hasta);
 else if(tipo==='productos')rows=await db.prepare(`SELECT id,nombre,categoria,variante,sku,stock,stock_minimo,precio_contado_centavos/100.0 AS precio_contado_pesos,precio_financiado_centavos/100.0 AS precio_financiado_pesos,costo_centavos/100.0 AS costo_pesos,imei,estado FROM productos WHERE negocio_id=? ORDER BY nombre`).all(n);
 else if(tipo==='comisiones'){const r=await resumenComisiones(n,null,desde,hasta);rows=r.eventos.map(x=>({fecha:x.fecha,empleado:x.nombre,usuario_id:x.usuario_id,venta_id:x.venta_id,momento:x.momento,importe_pesos:Number(x.importe_centavos)/100,motivo:x.motivo}));}
 else return res.status(400).json({error:'Tipo de exportación inválido'});
 res.set('Cache-Control','no-store');res.json({filename:`zilky-${tipo}-${desde}-${hasta}.csv`,csv:rowsCSV(rows),filas:rows.length});
 }catch(e){next(e);}});
