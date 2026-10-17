// Notification fan-out. Always writes the in-app notification; additionally emails/texts the user when a
// provider is configured and the user opted in. Every external attempt is recorded in `notifications`
// (channel + status pending/sent/failed + error) and runs in the background: a slow or failing provider can
// never delay or roll back the action that triggered it.
module.exports = (db, { mailer = null, sms = null, appUrl = '' } = {}) => {
  const insert = db.prepare(`INSERT INTO notifications(user_id,report_id,type,message,channel,status,error,created_at,link)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const finish = db.prepare('UPDATE notifications SET status=?, error=? WHERE id=?');
  const pending = new Set();

  function notify(userId, reportId, type, message, link = null) {
    if (!userId) return;
    try { insert.run(userId, reportId ?? null, type, message, 'in_app', 'delivered', null, Date.now(), link); }
    catch (e) { console.error('notification failed:', e.message); }
    if (!mailer && !sms) return;

    let u;
    try { u = db.prepare('SELECT email, phone, notify_email, notify_sms, email_verified, active FROM users WHERE id=?').get(userId); }
    catch (e) { console.error('notification failed:', e.message); return; }
    if (!u || !u.active) return;
    const target = link || (reportId ? `#/reports/${reportId}` : '');
    const url = appUrl && target ? `${appUrl}/${target}` : '';

    const dispatch = (channel, send) => {
      let id;
      try { id = Number(insert.run(userId, reportId ?? null, type, message, channel, 'pending', null, Date.now(), link).lastInsertRowid); }
      catch (e) { console.error('notification failed:', e.message); return; }
      const p = Promise.resolve().then(send)
        .then(() => finish.run('sent', null, id), (e) => finish.run('failed', String(e?.message || e).slice(0, 300), id))
        .catch((e) => console.error('notification bookkeeping failed:', e.message))
        .finally(() => pending.delete(p));
      pending.add(p);
    };
    const oneLine = message.replace(/\s+/g, ' ');
    if (mailer && u.notify_email && u.email_verified && u.email) dispatch('email', () => mailer.send(u.email, `Civic Repair Desk: ${oneLine.slice(0, 80)}`, url ? `${message}\n\n${url}` : message));
    if (sms && u.notify_sms && u.phone) dispatch('sms', () => sms.send(u.phone, (oneLine.slice(0, 280) + (url ? ' ' + url : ''))));
  }
  // Account mail (verification, password reset): fire-and-forget through the same tracking set.
  // Failures are logged without the message body, which contains a secret link.
  notify.sendEmail = (to, subject, text) => {
    if (!mailer) return false;
    const p = Promise.resolve().then(() => mailer.send(to, subject, text))
      .catch((e) => console.error('account email failed:', e.message)).finally(() => pending.delete(p));
    pending.add(p);
    return true;
  };
  notify.flush = () => Promise.allSettled([...pending]); // lets tests (and graceful shutdown) wait for deliveries
  return notify;
};
