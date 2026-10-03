// Esta suite resetea tablas: nunca aceptar una URL de producción por accidente.
const url=process.env.TEST_DATABASE_URL;
if(!url) throw new Error('Definí TEST_DATABASE_URL: base local descartable cuyo nombre termine en _test');
const parsed=new URL(url);
if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) throw new Error('Las pruebas solo aceptan una base local descartable con sufijo _test');
process.env.DATABASE_URL=url;
process.env.JWT_SECRET='test-secret-solo-para-tests';
process.env.RESEND_API_KEY='';
process.env.APP_BASE_URL='';
