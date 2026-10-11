// Persist the exact financial request before sending it. Reloads cannot turn an
// uncertain partial payment, adjustment or return into a second operation.
export function pendingMutation({key,api,setHTML,toast,container,onSuccess}) {
 let busy=false;
 const read=()=>{try{return JSON.parse(sessionStorage.getItem(key)||'null');}catch{return null;}};
 const show=()=>{
  const box=container();if(!box)return;const pending=read();
  if(!pending){box.replaceChildren();return;}
  setHTML(box,'<div class="card sale-pending"><strong>Hay una operación pendiente de confirmar</strong><p>Comprobá el resultado antes de registrar otra. Se usará la misma solicitud, aunque hayas recargado la página.</p><button type="button" class="btn btn-primary">Comprobar operación pendiente</button></div>');
  const button=box.querySelector('button');button.disabled=busy;button.onclick=async()=>{try{await send(read());await onSuccess();toast('Operación confirmada');}catch(e){toast(e.message,true);}};
 };
 async function send(pending){
  if(busy)throw Error('La operación se está comprobando');if(!pending)return;
  busy=true;show();
  try{const r=await api(pending.path,{method:pending.method,body:JSON.stringify(pending.body)});sessionStorage.removeItem(key);return r;}
  catch(e){if(e.status>=400&&e.status<500&&e.status!==401&&e.status!==408&&e.status!==429)sessionStorage.removeItem(key);throw e;}
  finally{busy=false;show();}
 }
 return {show,async run(path,body,method='POST'){
  const pending=read();if(pending)throw Error('Primero comprobá la operación pendiente con el botón de arriba');
  const request={path,body,method};sessionStorage.setItem(key,JSON.stringify(request));return send(request);
 }};
}
