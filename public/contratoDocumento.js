// Shared strict document format. No arbitrary HTML, styles, links or scripts.
export const tags = new Set(['p','div','br','strong','b','em','i','u','h1','h2','h3','ul','ol','li','table','thead','tbody','tr','th','td']);
export const escape = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function normalizeDocument(input) {
 let count=0,size=0;
 function node(n,depth=0){
  if(++count>10000||depth>30)throw new Error('Documento demasiado complejo');
  if(typeof n==='string'){size+=n.length;if(size>70000)throw new Error('Documento demasiado largo');return n;}
  if(!n||!tags.has(n.tag)||!Array.isArray(n.children))throw new Error('Formato de documento inválido');
  const result={tag:n.tag,children:n.children.map(c=>node(c,depth+1))};
  if(['left','center','right','justify'].includes(n.align))result.align=n.align;
  return result;
 }
 if(!Array.isArray(input))throw new Error('Documento inválido');return input.map(n=>node(n));
}
export function documentHTML(input){const render=n=>typeof n==='string'?escape(n):`<${n.tag}${n.align?` style="text-align:${n.align}"`:''}>${n.children.map(render).join('')}${n.tag==='br'?'':`</${n.tag}>`}`;return normalizeDocument(input).map(render).join('');}
export function pageSettings(p={}){if(!['A4','Letter','Legal'].includes(p.size)||!['portrait','landscape'].includes(p.orientation))throw new Error('Formato de página inválido');return {size:p.size,orientation:p.orientation};}
export function printHTML(doc,page,title,{draft=false}={}){page=pageSettings(page);return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escape(title)}</title><style>@page{size:${page.size} ${page.orientation};margin:18mm}body{font:11pt Arial,sans-serif;color:#111;line-height:1.45;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}th,td{border:1px solid #777;padding:5px}thead{display:table-header-group}tr{break-inside:avoid}h1,h2,h3{break-after:avoid}h1{font-size:18pt}h2{font-size:14pt}p{white-space:pre-wrap}</style></head><body>${draft?'<p><strong>BORRADOR — no emitido ni firmado</strong></p>':''}${documentHTML(doc)}</body></html>`;}
