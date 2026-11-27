// Las pruebas de navegador revisan importes, botones e historiales de cada compra.
// En la ficha esos datos viven dentro del detalle plegable y sus pestañas; este
// script los deja abiertos para que las pruebas los vean todos a la vez.
export const expandirFicha=context=>context.addInitScript(()=>{
  const abrir=()=>{
    document.querySelectorAll('details.compra-detalle:not([data-qa-abierto])').forEach(d=>{d.open=true;d.dataset.qaAbierto='1';});
    document.querySelectorAll('.compra-panel[hidden]:not([data-qa-visible])').forEach(p=>{p.hidden=false;p.dataset.qaVisible='1';});
  };
  new MutationObserver(abrir).observe(document,{childList:true,subtree:true});
});
