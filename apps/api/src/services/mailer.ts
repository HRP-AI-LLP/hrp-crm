/**
 * Platform mail (invitations, password resets) through Resend's HTTP API — free tier is
 * 3,000 emails/month. Optional: without RESEND_API_KEY the API returns the link instead so
 * an administrator can pass it on.
 */
import type { Env } from '../env';

export function mailerConfigured(env: Env): boolean {
  return !!env.RESEND_API_KEY;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Simple branded HTML around a message with one call-to-action button. */
export function actionEmail(opts: { heading: string; intro: string; cta: string; url: string; footer: string }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0">
<tr><td style="background:#062f59;border-radius:12px 12px 0 0;padding:18px 24px;color:#ffffff;font-weight:700;font-size:16px">HRP Synapse</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px;color:#075492">${esc(opts.heading)}</h1>
<p style="margin:0 0 20px;line-height:1.55">${esc(opts.intro)}</p>
<p style="margin:0 0 24px"><a href="${esc(opts.url)}" style="display:inline-block;background:#075492;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(opts.cta)}</a></p>
<p style="margin:0;color:#64748b;font-size:13px;line-height:1.5">${esc(opts.footer)}<br>If the button does not work, copy this link: <span style="word-break:break-all">${esc(opts.url)}</span></p>
</td></tr></table>
<p style="color:#94a3b8;font-size:12px;margin:16px 0 0">HRP AI LLP · www.hrpai.in</p>
</td></tr></table></body></html>`;
  const text = `${opts.heading}\n\n${opts.intro}\n\n${opts.cta}: ${opts.url}\n\n${opts.footer}`;
  return { html, text };
}

export async function sendPlatformMail(env: Env, msg: { to: string; subject: string; html: string; text: string }): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM ?? 'HRP Synapse <no-reply@hrpai.in>', to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
  }).catch(() => null);
  if (!res?.ok) {
    console.error(JSON.stringify({ level: 'error', msg: 'platform mail failed', status: res?.status ?? 'network' }));
    return false;
  }
  return true;
}

/** Base URL of the app for links in mail (shared app host in production). */
export function appOrigin(env: Env, requestUrl: string): string {
  if (env.APP_HOST) return `https://${env.APP_HOST}`;
  return new URL(requestUrl).origin;
}
