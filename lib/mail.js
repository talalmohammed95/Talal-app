// Email through any SMTP provider (nodemailer). Optional: without it, accounts skip email
// confirmation (the admin still approves everyone) and the admin hands out password-reset links.
import nodemailer from "nodemailer";
import { appendFileSync } from "node:fs";

const env = process.env;
let transport;

export const mailEnabled = () => !!((env.SMTP_HOST && env.MAIL_FROM) || env.MAIL_LOG_FILE);

export async function sendMail(to, subject, text) {
  if (!mailEnabled()) return false;
  if (env.MAIL_LOG_FILE) { // local testing: write emails to a file instead of sending them
    appendFileSync(env.MAIL_LOG_FILE, JSON.stringify({ to, subject, text }) + "\n");
    return true;
  }
  if (!transport) {
    const port = Number(env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST, port, secure: port === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
    });
  }
  await transport.sendMail({ from: env.MAIL_FROM, to, subject, text });
  return true;
}

// Sends without failing the request: a failed notification shouldn't block sign-up or approval.
export async function trySendMail(to, subject, text) {
  try { return await sendMail(to, subject, text); }
  catch (e) { console.error("Email failed:", e.message); return false; }
}
