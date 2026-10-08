import { Router } from 'express';
import { db } from '../db/connection.js';
import { crearCliente, listClientes, getCliente, buscarClientes, buscarDuplicados, actualizarSeguimiento, listClientesFinalizados, listClientesPorNegocio, listClientesPorNegocios } from '../repositories/clientes.js';
import { listCreditosPorCliente } from '../repositories/creditos.js';
import { listCuotasPorCredito } from '../repositories/cuotas.js';
import { listPagosPorCliente, getSaldoFavor } from '../repositories/pagos.js';
import { estadoCuota, calcularMora } from '../lib/mora.js';
import { getNegocio } from '../repositories/negocios.js';
import { todayAR, diffDays } from '../lib/dates.js';
import { perfilRiesgoCliente, historialFinancieroCliente } from '../services/dashboardService.js';
import { listIncidencias, registrarIncidenciaEquipo } from '../services/incidenciasService.js';
import { gestionCliente, registrarGestion } from '../services/gestionCobranzaService.js';
import { editarDatosCliente, puedeEditarIdentidad } from '../services/clientDataService.js';
import { datosBasicos, versionDatos } from '../lib/clientData.js';
import { resumenVencimientos } from '../lib/vencimientos.js';
import { resumenEliminacion, eliminarClienteSinActividad } from '../services/clientDeletionService.js';
import { requireAdmin, requirePermiso, validarScopeNegocio, scopeNegocios, exigirCliente, exigirPermisoNegocio, scopePara, negocioSolicitado } from '../middleware/authorize.js';

export const clientesRouter = Router();

// Lista/búsqueda global. negocio_id es OPCIONAL: si se pasa, filtra a clientes vinculados
// a ese negocio mediante la relación explícita cliente_negocio.
clientesRouter.get('/', requirePermiso('clientes.ver'), async (req, res, next) => {
  try {
    const { q, negocio_id } = req.query;
    let scope = scopeNegocios(req, 'clientes.ver');
    if (req.query.con_deuda === '1') {
      const financiero=scopePara(req,'cobranzas.ver');
      if(financiero!==null) scope=scope===null?financiero:scope.filter(id=>financiero.includes(id));
      if(negocio_id) scope=scope===null?[negocio_id]:scope.filter(id=>id===negocio_id);
      const {rows}=await db.query(`SELECT DISTINCT cl.* FROM clientes cl
        JOIN cliente_negocio cn ON cn.cliente_id=cl.id
        JOIN creditos cr ON cr.cliente_id=cl.id AND cr.negocio_id=cn.negocio_id
        JOIN cuotas cu ON cu.credito_id=cr.id
        WHERE cu.saldo_pendiente_centavos>0 AND cu.estado_manual IS NULL
        AND ($1::text[] IS NULL OR cn.negocio_id=ANY($1::text[]))
        AND ($2::text IS NULL OR concat_ws(' ',cl.nombre,cl.apellido,cl.dni,cl.telefono,cl.instagram) ILIKE $2)
        ORDER BY cl.nombre`,[scope,q?'%'+q+'%':null]);
      return res.json(rows);
    }
    if (negocio_id) {
      if (!validarScopeNegocio(req, negocio_id)) return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
      res.json(q ? await buscarClientes(q, negocio_id) : await listClientesPorNegocio(negocio_id));
    } else {
      if (scope === null) {
        res.json(q ? await buscarClientes(q, null) : await listClientes());
      } else if (scope.length === 0) {
        res.json([]);
      } else {
        res.json(q ? await buscarClientes(q, scope) : await listClientesPorNegocios(scope));
      }
    }
  } catch (err) { next(err); }
});

// Clientes finalizados es una vista FINANCIERA, sí requiere negocio (ver historial por negocio).
clientesRouter.get('/finalizados', requirePermiso('clientes.ver'), requirePermiso('cobranzas.ver'), async (req, res, next) => {
  try {
    const { negocio_id } = req.query;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id es requerido' });
    if (!validarScopeNegocio(req, negocio_id)) return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
    res.json(await listClientesFinalizados(negocio_id));
  } catch (err) { next(err); }
});

clientesRouter.post('/', requirePermiso('clientes.editar'), async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, dni } = req.body;
    if (!nombre || !apellido) return res.status(400).json({ error: 'nombre y apellido son obligatorios' });
    const negocioId=negocioSolicitado(req);
    if(!negocioId && req.usuario.rol!=='administrador') return res.status(400).json({error:'Seleccioná un negocio para crear el cliente'});
    if(negocioId) exigirPermisoNegocio(req,negocioId,'clientes.editar');
    const duplicados = await buscarDuplicados({ dni, telefono });
    if (duplicados.length && (!req.body.forzar || req.usuario.rol!=='administrador')) return res.status(409).json({ error: 'Ya existe un posible cliente. Solicitá al administrador revisar o vincular su ficha.' });
    res.status(201).json(await crearCliente({...req.body, negocio_id:negocioId}));
  } catch (err) { next(err); }
});

clientesRouter.get('/:id/datos', requirePermiso('clientes.ver'), requirePermiso('clientes.editar'), async (req,res,next) => {
  try {
    await exigirCliente(req, req.params.id, 'clientes.ver');
    if (!await puedeEditarIdentidad(req, req.params.id)) return res.status(403).json({error:'La ficha es compartida. Un administrador debe corregir sus datos.'});
    const c = await getCliente(req.params.id);
    if (!c) return res.status(404).json({error:'Cliente no encontrado'});
    res.json({datos:datosBasicos(c), version:versionDatos(c)});
  } catch(e) {next(e);}
});
clientesRouter.patch('/:id/datos', requirePermiso('clientes.ver'), requirePermiso('clientes.editar'), async(req,res,next) => {
  try {
    await exigirCliente(req, req.params.id, 'clientes.ver');
    res.json(await editarDatosCliente(req));
  } catch(e) {next(e);}
});

clientesRouter.get('/:id/eliminacion', requireAdmin, async(req,res,next) => {
  try {
    await exigirCliente(req,req.params.id,'clientes.ver');
    const r = await resumenEliminacion(req.params.id);
    res.json({nombre:[r.cliente.nombre,r.cliente.apellido].filter(Boolean).join(' '),
      negocios:r.negocios.length,actividad:r.actividad,seguimiento:r.seguimiento,permitido:r.permitido,version:r.version});
  } catch(e) {next(e);}
});
clientesRouter.delete('/:id', requireAdmin, async(req,res,next) => {
  try {
    res.json(await eliminarClienteSinActividad({clienteId:req.params.id,version:req.body.version,confirmacion:req.body.confirmacion,
      motivo:req.body.motivo,solicitudId:req.body.solicitud_id,usuarioId:req.usuarioId}));
  } catch(e) {next(e);}
});

clientesRouter.patch('/:id/seguimiento', requirePermiso('clientes.editar'), async (req, res, next) => {
  try {
    const negocioId = negocioSolicitado(req);
    if (!negocioId) return res.status(400).json({ error: 'negocio_id es requerido para modificar el seguimiento' });
    exigirPermisoNegocio(req, negocioId, 'clientes.editar');
    await exigirCliente(req, req.params.id, 'clientes.editar');
    res.json(await actualizarSeguimiento(req.params.id, req.body));
  } catch (err) { next(err); }
});

clientesRouter.post('/:id/gestion-especial', requireAdmin, async(req,res,next)=>{
  try {
    const negocioId=negocioSolicitado(req);
    if(!negocioId)return res.status(400).json({error:'negocio_id es requerido'});
    if(!['entrada','salida'].includes(req.body.accion))return res.status(400).json({error:'Acción inválida'});
    res.json(await registrarGestion({clienteId:req.params.id,negocioId,accion:req.body.accion,nota:req.body.nota,
      proximoContacto:req.body.proximo_contacto,solicitudId:req.body.solicitud_id,usuario:req.usuario}));
  }catch(e){next(e);}
});
clientesRouter.post('/:id/gestion-especial/seguimiento', requirePermiso('clientes.editar'), requirePermiso('cobranzas.ver'), async(req,res,next)=>{
  try {
    const negocioId=negocioSolicitado(req);
    if(!negocioId)return res.status(400).json({error:'negocio_id es requerido'});
    await exigirCliente(req,req.params.id,'clientes.ver');
    res.json(await registrarGestion({clienteId:req.params.id,negocioId,accion:'seguimiento',nota:req.body.nota,
      proximoContacto:req.body.proximo_contacto,solicitudId:req.body.solicitud_id,usuario:req.usuario}));
  }catch(e){next(e);}
});

// Detalle: por defecto muestra operaciones del cliente filtradas al scope del usuario.
clientesRouter.post('/:id/creditos/:creditoId/incidencias', requireAdmin, async (req,res,next)=>{
  try {
    const negocioId=negocioSolicitado(req);
    if(!negocioId)return res.status(400).json({error:'negocio_id es requerido'});
    res.json(await registrarIncidenciaEquipo({creditoId:req.params.creditoId,clienteId:req.params.id,negocioId,
      tipo:req.body.tipo,fecha:req.body.fecha,motivo:req.body.motivo,solicitudId:req.body.solicitud_id,usuarioId:req.usuarioId}));
  } catch(e) {next(e);}
});

// Con ?negocio_id=... se puede filtrar la vista a un solo negocio.
clientesRouter.get('/:id', requirePermiso('clientes.ver'), async (req, res, next) => {
  try {
    const vinculados = await exigirCliente(req,req.params.id,'clientes.ver');
    const cliente = await getCliente(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    const filtroNegocio = req.query.negocio_id || null;
    const scope = scopeNegocios(req, 'clientes.ver');

    if (filtroNegocio && !validarScopeNegocio(req, filtroNegocio)) {
      return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
    }

    // La ficha individual es información operativa del cliente autorizado.
    // No hereda ni necesita acceso al dashboard consolidado del negocio.
    let negociosPermitidos = vinculados === null ? scope : vinculados;
    if(filtroNegocio) negociosPermitidos=negociosPermitidos===null?[filtroNegocio]:negociosPermitidos.filter(id=>id===filtroNegocio);
    if(negociosPermitidos!==null && !negociosPermitidos.length) return res.json({...cliente, creditos:[],pagos:[],historial:null,riesgo:null,saldosFavor:{},finanzasAutorizadas:false});

    let creditos = await listCreditosPorCliente(req.params.id);
    if (negociosPermitidos) creditos = creditos.filter((cr) => negociosPermitidos.includes(cr.negocio_id));

    const today = todayAR();
    let deudaTotal = 0;
    const negociosInvolucrados = new Set();
    const creditosConDetalle = [];
    for (const cr of creditos) {
      negociosInvolucrados.add(cr.negocio_id);
      const negocio = await getNegocio(cr.negocio_id);
      const cuotasRaw = await listCuotasPorCredito(cr.id);
      const cuotas = cuotasRaw.map((c) => {
        const { estado, parcial } = estadoCuota(c, negocio, today);
        const mora = calcularMora(c, negocio, today);
        if (!c.estado_manual) {
          deudaTotal += c.saldo_pendiente_centavos + mora.pendiente;
        }
        return { ...c, estado, parcial, moraPendiente: mora.pendiente, moraGenerada: mora.acumulada, moraCobrada: mora.pagada, moraPerdonada: mora.perdonada,
          diasHasta: diffDays(c.fecha_vencimiento, today),
          diasAtraso: c.saldo_pendiente_centavos > 0 && !c.estado_manual ? Math.max(0, diffDays(today, c.fecha_vencimiento)) : 0 };
      });
      const items = await db.prepare(`SELECT vd.id, vd.producto_id, vd.descripcion, vd.cantidad,
        vd.precio_unitario_centavos, p.nombre AS producto_nombre, p.variante AS producto_variante,
        p.imei AS producto_imei FROM venta_detalle vd
        LEFT JOIN productos p ON p.id=vd.producto_id AND p.negocio_id=?
        WHERE vd.venta_id=? ORDER BY vd.id`).all(cr.negocio_id, cr.venta_id);
      creditosConDetalle.push({ ...cr, cuotas, items, seguimientoEquipos: negocio.seguimiento_equipos===1,
        moraHistorial: await db.prepare(`SELECT a.fecha_hora,a.motivo,a.datos_nuevos, u.nombre AS autor, cu.numero
          FROM auditoria a JOIN cuotas cu ON cu.id=a.entidad_id LEFT JOIN usuarios u ON u.id=a.empleado
          WHERE cu.credito_id=? AND a.entidad='cuota' AND a.accion='perdonar_mora' ORDER BY a.fecha_hora`).all(cr.id),
        incidencias: await listIncidencias(cr.id) });
    }

    // Saldo a favor es por negocio, se muestra desglosado.
    const saldosFavor = {};
    for (const negId of negociosInvolucrados) {
      if (!negociosPermitidos || negociosPermitidos.includes(negId)) {
        saldosFavor[negId] = await getSaldoFavor(req.params.id, negId);
      }
    }

    let pagos = await listPagosPorCliente(req.params.id);
    if (negociosPermitidos) pagos = pagos.filter((p) => negociosPermitidos.includes(p.negocio_id));

    res.json({
      ...cliente, finanzasAutorizadas:true, creditos: creditosConDetalle, pagos,
      deudaTotalCentavos: deudaTotal,
      ...resumenVencimientos(creditosConDetalle.flatMap(cr => cr.cuotas), today),
      riesgo: await perfilRiesgoCliente(req.params.id, negociosPermitidos),
      historial: await historialFinancieroCliente(req.params.id, negociosPermitidos),
      gestionCobranza: await gestionCliente(req.params.id, negociosPermitidos),
      saldosFavor,
    });
  } catch (err) { next(err); }
});
