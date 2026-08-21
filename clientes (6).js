import { Router } from 'express';
import { crearCliente, listClientes, getCliente, buscarClientes, buscarDuplicados, actualizarSeguimiento, listClientesFinalizados } from '../repositories/clientes.js';
import { listCreditosPorCliente } from '../repositories/creditos.js';
import { listCuotasPorCredito } from '../repositories/cuotas.js';
import { listPagosPorCliente, getSaldoFavor } from '../repositories/pagos.js';
import { estadoCuota, calcularMora } from '../lib/mora.js';
import { getNegocio } from '../repositories/negocios.js';
import { todayAR, diffDays } from '../lib/dates.js';
import { perfilRiesgoCliente, historialFinancieroCliente } from '../services/dashboardService.js';

export const clientesRouter = Router();

// Lista/búsqueda global. negocio_id es OPCIONAL: si se pasa, filtra a clientes que
// compraron en ese negocio (útil al elegir cliente para una venta), pero no particiona
// la base de clientes.
clientesRouter.get('/', async (req, res, next) => {
  try {
    const { q, negocio_id } = req.query;
    res.json(q ? await buscarClientes(q, negocio_id || null) : await listClientes());
  } catch (err) { next(err); }
});

// Clientes finalizados es una vista FINANCIERA, sí requiere negocio (ver historial por negocio).
clientesRouter.get('/finalizados', async (req, res, next) => {
  try {
    const { negocio_id } = req.query;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id es requerido' });
    res.json(await listClientesFinalizados(negocio_id));
  } catch (err) { next(err); }
});

clientesRouter.post('/', async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, dni } = req.body;
    if (!nombre || !apellido) return res.status(400).json({ error: 'nombre y apellido son obligatorios' });
    const duplicados = await buscarDuplicados({ dni, telefono });
    if (duplicados.length && !req.body.forzar) return res.status(409).json({ error: 'Posible cliente duplicado', duplicados });
    res.status(201).json(await crearCliente(req.body));
  } catch (err) { next(err); }
});

clientesRouter.patch('/:id/seguimiento', async (req, res, next) => {
  try { res.json(await actualizarSeguimiento(req.params.id, req.body)); } catch (err) { next(err); }
});

// Detalle: por defecto muestra TODAS las operaciones del cliente (todos los negocios).
// Con ?negocio_id=... se puede filtrar la vista a un solo negocio (sección 5 del pedido).
clientesRouter.get('/:id', async (req, res, next) => {
  try {
    const cliente = await getCliente(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    const filtroNegocio = req.query.negocio_id || null;

    let creditos = await listCreditosPorCliente(req.params.id);
    if (filtroNegocio) creditos = creditos.filter((cr) => cr.negocio_id === filtroNegocio);

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

    // Saldo a favor es por negocio (tiene sentido: puede deber en Apple y tener saldo
    // a favor en Indumentaria), así que se muestra desglosado, no como un único número.
    const saldosFavor = {};
    for (const negId of negociosInvolucrados) saldosFavor[negId] = await getSaldoFavor(req.params.id, negId);

    let pagos = await listPagosPorCliente(req.params.id);
    if (filtroNegocio) pagos = pagos.filter((p) => p.negocio_id === filtroNegocio);

    res.json({
      ...cliente, creditos: creditosConDetalle, pagos,
      deudaTotalCentavos: deudaTotal, proximoVencimiento,
      diasHastaVencimiento: proximoVencimiento ? diffDays(proximoVencimiento, today) : null,
      riesgo: await perfilRiesgoCliente(req.params.id),
      historial: await historialFinancieroCliente(req.params.id, filtroNegocio),
      saldosFavor,
    });
  } catch (err) { next(err); }
});
