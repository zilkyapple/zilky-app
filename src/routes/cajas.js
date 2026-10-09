import {Router} from 'express';
import {requireAdmin} from '../middleware/authorize.js';
import {listarCajas,guardarCaja,abrirCaja,detalleCaja,movimientoCaja,cerrarCaja,resolverPendiente} from '../services/cajaService.js';
export const cajasRouter=Router();
// Consolidated cash totals remain administrator-only, including shared-business cashboxes.
cajasRouter.use(requireAdmin);
const handle=fn=>async(req,res,next)=>{try{res.json(await fn(req));}catch(e){next(e);}};
cajasRouter.get('/',handle(()=>listarCajas()));
cajasRouter.post('/',handle(r=>guardarCaja(null,r.body,r.usuarioId)));
cajasRouter.patch('/:id',handle(r=>guardarCaja(r.params.id,r.body,r.usuarioId)));
cajasRouter.get('/:id',handle(r=>detalleCaja(r.params.id)));
cajasRouter.post('/:id/abrir',handle(r=>abrirCaja(r.params.id,r.body,r.usuarioId)));
cajasRouter.post('/sesiones/:id/movimientos',handle(r=>movimientoCaja(r.params.id,r.body,r.usuarioId)));
cajasRouter.post('/sesiones/:id/cerrar',handle(r=>cerrarCaja(r.params.id,r.body,r.usuarioId)));

cajasRouter.post('/movimientos/:id/conciliar',handle(r=>resolverPendiente(r.params.id,r.body,r.usuarioId)));
