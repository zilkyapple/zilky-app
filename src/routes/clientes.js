import { Router } from 'express';
import { crearCliente, listClientes, getCliente, buscarClientes, buscarDuplicados, actualizarSeguimiento, listClientesFinalizados, listClientesPorNegocio, listClientesPorNegocios } from '../repositories/clientes.js';
import { listCreditosPorCliente } from '../repositories/creditos.js';
import { listCuotasPorCredito } from '../repositories/cuotas.js';
import { listPagosPorCliente, getSaldoFavor } from '../repositories/pagos.js';
import { estadoCuota, calcularMora } from '../lib/mora.js';
import { getNegocio } from '../repositories/negocios.js';
import { todayAR, diffDays } from '../lib/dates.js';
import { perfilRiesgoCliente, historialFinancieroCliente } from '../services/dashboardService.js';
import { requirePermiso, validarScopeNegocio, scopeNegocios } from '../middleware/authorize.js';

export const clientesRouter = Router();

// Lista/búsqueda global. negocio_id es OPCIONAL: si se pasa, filtra a clientes vinculados
// a ese negocio mediante la relación explícita cliente_negocio.
clientesRouter.get('/', requirePermiso('clientes.ver'), async (req, res, next) => {
  try {
    const { q, negocio_id } = req.query;
    const scope = scopeNegocios(req);
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
clientesRouter.get('/finalizados', requirePermiso('clientes.ver'), async (req, res, next) => {
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
    const duplicados = await buscarDuplicados({ dni, telefono });
    if (duplicados.length && !req.body.forzar) return res.status(409).json({ error: 'Posible cliente duplicado', duplicados });
    res.status(201).json(await crearCliente(req.body));
  } catch (err) { next(err); }
});

clientesRouter.patch('/:id/seguimiento', requirePermiso('clientes.editar'), async (req, res, next) => {
  try { res.json(await actualizarSeguimiento(req.params.id, req.body)); } catch (err) { next(err); }
});

// Detalle: por defecto muestra operaciones del cliente filtradas al scope del usuario.
// Con ?negocio_id=... se puede filtrar la vista a un solo negocio.
clientesRouter.get('/:id', requirePermiso('clientes.ver'), async (req, res, next) => {
  try {
    const cliente = await getCliente(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    const filtroNegocio = req.query.negocio_id || null;
    const scope = scopeNegocios(req);

    if (filtroNegocio && !validarScopeNegocio(req, filtroNegocio)) {
      return res.status(403).json({ error: 'No tenés acceso a ese negocio' });
    }

    const negociosPermitidos = filtroNegocio ? [filtroNegocio] : (scope === null ? null : scope);

    let creditos = await listCreditosPorCliente(req.params.id);
    if (negociosPermitidos) creditos = creditos.filter((cr) => negociosPermitidos.includes(cr.negocio_id));

    const today = todayAR();
    let deudaTotal = 0;
    let proximoVencimiento = null;
    const negociosInvolucrados = new Set();
    const creditosConDetalle = [];
    for (const cr of creditos) {
      negociosInvolucrados.add(cr.negocio_id);
      const negocio = await getNegocio(cr.negocio_id);
      const cuotasRaw = await listCuotasPorCredito(cr.id);
      const cuotas = cuotasRaw.map((c) => {
        const { estado, parcial } = estadoCuota(c, negocio, today);
        const mora = calcularMora(c, negocio, today);
        if (c.saldo_pendiente_centavos > 0) {
          deudaTotal += c.saldo_pendiente_centavos + mora.pendiente;
          if (!proximoVencimiento || c.fecha_vencimiento < proximoVencimiento) proximoVencimiento = c.fecha_vencimiento;
        }
        return { ...c, estado, parcial, moraPendiente: mora.pendiente };
      });
      creditosConDetalle.push({ ...cr, cuotas });
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
      ...cliente, creditos: creditosConDetalle, pagos,
      deudaTotalCentavos: deudaTotal, proximoVencimiento,
      diasHastaVencimiento: proximoVencimiento ? diffDays(proximoVencimiento, today) : null,
      riesgo: await perfilRiesgoCliente(req.params.id, negociosPermitidos),
      historial: await historialFinancieroCliente(req.params.id, negociosPermitidos),
      saldosFavor,
    });
  } catch (err) { next(err); }
});
