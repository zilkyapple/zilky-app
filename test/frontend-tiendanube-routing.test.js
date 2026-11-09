import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
function browser({admin=false,negocio='n1',permisos={'tienda.pedidos':true,'ventas.crear':true}}={}){
  const dom=new JSDOM(read('index.html'),{url:'https://zilky.test/#/mas',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[];
  const capacidades={puede_cobrar:false,puede_elegir_cliente:false,elegir_vendedor:admin};
  w.fetch=async url=>{
    calls.push(url);
    let result;
    if(url.startsWith('/api/tiendanube/pedidos/opciones?'))result={capacidades,clientes:[],vendedores:[]};
    else if(url.startsWith('/api/tiendanube/pedidos?'))result={capacidades,pedidos:[{order_id:'40',estado:'pendiente'}]};
    else if(url.startsWith('/api/tiendanube/estado?'))result={conexion:null,links:[],configuracion_servidor:false};
    else if(url.startsWith('/api/tiendanube/diagnostico?'))result={listo:false,bloqueos:['SIN_CONEXION']};
    else if(url.startsWith('/api/tiendanube/privacidad?'))result=[];
    else throw Error('Unexpected local fake request '+url);
    return {ok:true,status:200,json:async()=>result};
  };
  w.eval(read('vendor/purify.min.js'));
  // JSDOM eval cannot import ES modules. Load the original view sources and
  // shim only their import expressions; execute the complete app router.
  for(const [name,exportName] of [['tiendanubePedidos.js','tiendanubePedidosView'],['tiendanubeAdmin.js','tiendanubeAdminView']]){
    w.eval('(()=>{'+read(name).replace(/export (?=(?:async )?function)/g,'')+'\nwindow.'+exportName+'='+exportName+';})();');
  }
  w.qaPedidosModule={tiendanubePedidosView:w.tiendanubePedidosView};
  w.qaAdminModule={tiendanubeAdminView:w.tiendanubeAdminView};
  const source=read('app.js')
    .replace("await import('./tiendanubePedidos.js')",'await Promise.resolve(window.qaPedidosModule)')
    .replace("await import('./tiendanubeAdmin.js')",'await Promise.resolve(window.qaAdminModule)');
  w.eval(source+'\nwindow.qaState=state;');
  w.qaState.usuario={id:admin?'admin':'emp',rol:admin?'administrador':'empleado',
    negocios:[{negocio_id:'n1',activo:1,permisos}]};
  w.qaState.negocioActual=negocio;
  w.qaState.negocios=[{id:'n1',nombre:'Negocio propio'}];
  return {w,calls,view:w.document.getElementById('view'),async route(path){w.history.replaceState({},'','/#/'+path);await w.render();}};
}

test('router monta pedidos Tiendanube para empleado con ambos permisos del negocio',async()=>{
  const b=browser();try{
    await b.route('mas');
    const link=b.view.querySelector('a[href="#/tiendanube/pedidos"]');
    assert.ok(link&&!link.hidden);
    await b.route('tiendanube/pedidos');
    assert.ok(b.view.querySelector('[data-tn-orders-refresh]'));
    assert.ok(b.view.querySelector('[data-tn-order="40"]'));
    assert.deepEqual(b.calls,['/api/tiendanube/pedidos?negocio_id=n1','/api/tiendanube/pedidos/opciones?negocio_id=n1&buscar=']);
  }finally{b.w.close();}
});

test('router rechaza pedidos sin uno de los permisos o en otro negocio antes de consultar',async()=>{
  for(const options of [{permisos:{'tienda.pedidos':true}},{permisos:{'ventas.crear':true}},{negocio:'n2'}]){
    const b=browser(options);try{
      await b.route('tiendanube/pedidos');
      assert.equal(b.view.querySelector('[data-tn-orders-refresh]'),null);
      assert.match(b.view.textContent,/permiso para gestionar pedidos y ventas/);
      assert.deepEqual(b.calls,[]);
    }finally{b.w.close();}
  }
});

test('router conserva configuración Tiendanube y otras pantallas solo para administrador',async()=>{
  const employee=browser();try{
    for(const path of ['tiendanube','tiendanube/configuracion','configuracion','caja','contratos','exportaciones']){
      await employee.route(path);
      assert.match(employee.view.textContent,/Requiere administrador/);
      assert.deepEqual(employee.calls,[]);
    }
  }finally{employee.w.close();}
  const admin=browser({admin:true});try{
    await admin.route('tiendanube');
    assert.ok(admin.view.querySelector('[data-tn-refresh]'));
    assert.match(admin.view.textContent,/Conexión con Tiendanube/);
    assert.ok(admin.calls.includes('/api/tiendanube/estado?negocio_id=n1'));
    await admin.route('tiendanube/pedidos');
    assert.ok(admin.view.querySelector('[data-tn-orders-refresh]'));
  }finally{admin.w.close();}
});
