import { Resend } from 'resend';

const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
// Transporte inyectable para comprobar el correo sin credenciales ni envíos reales.
export function crearServicioEmail({ client, baseURL, from = 'Zilky <onboarding@resend.dev>' }) {
  let base;
  try {
    base = new URL(baseURL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) base = null;
  } catch { base = null; }
  return {
    isEmailConfigured: () => !!(client && base),
    async enviarInvitacionEmail({ email, nombre, token }) {
      if (!client || !base) throw new Error('El envío de email no está configurado');
      const url = new URL(base);
      url.search = ''; url.hash = ''; url.searchParams.set('token', token);
      const link = url.href;
      const display = nombre || email;
      try {
        const { data, error } = await client.emails.send({
          from, to: email, subject: 'Fuiste invitado a Zilky',
          text: `¡Hola ${display}! Te invitaron a Zilky como empleado. Creá tu contraseña en ${link}\nEl enlace expira en 7 días y se utiliza una sola vez. Si no esperabas esta invitación, ignorá este mensaje.`,
          html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px"><h2>¡Hola ${escapeHTML(display)}!</h2><p>Te invitaron a Zilky como empleado.</p><p><a href="${escapeHTML(link)}">Aceptar invitación y crear contraseña</a></p><p>Si el botón no funciona: ${escapeHTML(link)}</p><p>Este enlace expira en 7 días y se utiliza una sola vez. Si no esperabas esta invitación, ignorá este mensaje.</p></div>`
        });
        if (error || !data?.id) throw new Error('Error del proveedor');
        return { messageId: data.id };
      } catch { throw new Error('No se pudo enviar el email de invitación'); }
    }
  };
}
const servicio = crearServicioEmail({
  client: process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null,
  baseURL: process.env.APP_BASE_URL,
  from: process.env.RESEND_FROM || undefined
});
export const enviarInvitacionEmail = servicio.enviarInvitacionEmail;
export const isEmailConfigured = servicio.isEmailConfigured;
