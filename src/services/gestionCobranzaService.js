import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { nowAR, todayAR } from '../lib/dates.js';
import { badRequest, dateISO, text } from '../lib/validation.js';
import { calcularMora } from '../lib/mora.js';
import { getNegocio } from '../repositories/negocios.js';
import { auditar } from '../lib/audit.js';

export async function gestionCliente(clienteId, negocios=null) {
  const filas=await db.query(`SELECT cn.negocio_id, COALESCE(cc.gestion_especial,0) AS gestion_especial, COALESCE(cc.modo,'revisar') AS modo, cc.proximo_contacto
    FROM cliente_negocio cn LEFT JOIN cliente_negocio_cobranza cc USING (cliente_id,negocio_id)
    WHERE cn.cliente_id=$1 AND ($2::text[] IS NULL OR cn.negocio_id=ANY($2::text[]))`,[clienteId,negocios]);
  for(const f of filas.rows) f.historial=await db.prepare('SELECT * FROM cobranza_gestion_eventos WHERE cliente_id=? AND negocio_id=? ORDER BY secuencia').all(clienteId,f.negocio_id);
  for(const f of filas.rows) f.historialModo=await db.prepare(`SELECT a.fecha_hora,a.motivo,a.datos_nuevos,u.nombre AS autor FROM auditoria a LEFT JOIN usuarios u ON u.id=a.empleado
    WHERE a.entidad='cobranza_modo' AND a.entidad_id=? AND a.datos_nuevos::jsonb->>'negocio_id'=? ORDER BY a.fecha_hora,a.id`).all(clienteId,f.negocio_id);
  return filas.rows;
}

// Clasificación de cobranza por cliente y negocio. No cambia créditos, cuotas, pagos ni stock.
export async function registrarGestion({clienteId,negocioId,accion,nota,proximoContacto=null,solicitudId,usuario}) {
  if(!['entrada','salida','seguimiento'].includes(accion))throw badRequest('Acción inválida');
  const razon=text(nota,'motivo o seguimiento',2000);
  const solicitud=text(solicitudId,'identificador de solicitud',128);
  if(!/^[a-zA-Z0-9-]{16,128}$/.test(solicitud))throw badRequest('Identificador de solicitud inválido');
  if(accion==='salida')proximoContacto=null;
  else { dateISO(proximoContacto,'próximo contacto'); if(proximoContacto<todayAR())throw badRequest('El próximo contacto no puede estar en el pasado'); }
  return db.transaction(async()=>{
    await db.lockClienteNegocio(clienteId,negocioId);
    const vinculo=await db.prepare('SELECT 1 FROM cliente_negocio WHERE cliente_id=? AND negocio_id=?').get(clienteId,negocioId);
    if(!vinculo)throw Object.assign(new Error('Cliente no encontrado en este negocio'),{status:404});
    const anterior=await db.prepare('SELECT * FROM cobranza_gestion_eventos WHERE cliente_id=? AND negocio_id=? AND solicitud_id=?').get(clienteId,negocioId,solicitud);
    if(anterior){
      if(anterior.accion!==accion||anterior.nota!==razon||anterior.proximo_contacto!==proximoContacto)throw Object.assign(new Error('La solicitud ya se usó con otros datos'),{status:409});
      return anterior;
    }
    const config=await db.prepare('SELECT * FROM cliente_negocio_cobranza WHERE cliente_id=? AND negocio_id=?').get(clienteId,negocioId);
    const especial=config?.gestion_especial===1;
    if((accion==='entrada'&&especial)||(accion!=='entrada'&&!especial))throw Object.assign(new Error('La clasificación cambió. Actualizá la ficha antes de continuar.'),{status:409});
    const negocio=await getNegocio(negocioId),hoy=todayAR();
    const cuotas=await db.prepare(`SELECT cu.* FROM cuotas cu JOIN creditos cr ON cr.id=cu.credito_id
      WHERE cr.cliente_id=? AND cr.negocio_id=? AND cu.saldo_pendiente_centavos>0 AND cu.estado_manual IS NULL`).all(clienteId,negocioId);
    const capital=cuotas.reduce((s,c)=>s+c.saldo_pendiente_centavos,0),mora=cuotas.reduce((s,c)=>s+calcularMora(c,negocio,hoy).pendiente,0);
    if(accion==='entrada'&&capital===0)throw Object.assign(new Error('El cliente no tiene deuda pendiente en este negocio'),{status:409});
    const evento={id:id(),cliente_id:clienteId,negocio_id:negocioId,accion,fecha:nowAR(),usuario_id:usuario.id,
      usuario_nombre:usuario.nombre||usuario.email||usuario.id,deuda_centavos:capital+mora,capital_centavos:capital,mora_centavos:mora,
      nota:razon,proximo_contacto:proximoContacto,solicitud_id:solicitud};
    await db.query(`INSERT INTO cobranza_gestion_eventos
      (id,cliente_id,negocio_id,accion,fecha,usuario_id,usuario_nombre,deuda_centavos,capital_centavos,mora_centavos,nota,proximo_contacto,solicitud_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,Object.values(evento));
    await db.prepare(`INSERT INTO cliente_negocio_cobranza(cliente_id,negocio_id,gestion_especial,proximo_contacto)
      VALUES (?,?,?,?) ON CONFLICT (cliente_id,negocio_id) DO UPDATE SET gestion_especial=EXCLUDED.gestion_especial,proximo_contacto=EXCLUDED.proximo_contacto`)
      .run(clienteId,negocioId,accion==='salida'?0:1,proximoContacto);
    await auditar('cliente',clienteId,'gestion_especial_'+accion,config||null,evento,usuario.id,razon);
    return await db.prepare('SELECT * FROM cobranza_gestion_eventos WHERE id=?').get(evento.id);
  });
}
