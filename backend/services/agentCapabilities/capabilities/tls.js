// TLS handshake on the first HTTPS port of the target: is the service
// answering TLS at all, what certificate does it present, when does it
// expire, does the name match. Verification is off so a self-signed
// management cert still yields its details; the result says it is self-signed.
const tls = require('tls');

const HTTPS_PORTS = new Set([443, 8443, 9440, 9669, 5480]);

module.exports = {
  id: 'tls',
  label: 'TLS certificate check',
  description: 'Completes a TLS handshake on the target\'s HTTPS management port and reports the certificate subject, issuer, expiry and whether the name matches. No request is sent after the handshake.',
  risk: 'network-probe',
  defaultEnabled: false,
  appliesTo(target) {
    return (target.ports || [443]).some((p) => HTTPS_PORTS.has(p));
  },
  run(target) {
    const port = (target.ports || [443]).find((p) => HTTPS_PORTS.has(p)) || 443;
    const host = String(target.address || '');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); } };
      const sock = tls.connect({ host, port, servername: /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: 3000 }, () => {
        const cert = sock.getPeerCertificate();
        if (!cert || !cert.subject) return finish({ ok: true, summary: `TLS up on ${port}, no certificate details returned`, data: { port } });
        const subject = cert.subject.CN || Object.values(cert.subject).join(', ');
        const issuer = cert.issuer && (cert.issuer.CN || Object.values(cert.issuer).join(', '));
        const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
        const daysLeft = validTo ? Math.round((validTo.getTime() - Date.now()) / 86400000) : null;
        const selfSigned = !!(cert.issuer && cert.subject && JSON.stringify(cert.issuer) === JSON.stringify(cert.subject));
        const mismatch = sock.servername ? tls.checkServerIdentity(sock.servername, cert) : null;
        const notes = [];
        if (daysLeft != null && daysLeft < 0) notes.push(`EXPIRED ${-daysLeft} days ago`);
        else if (daysLeft != null && daysLeft <= 30) notes.push(`expires in ${daysLeft} days`);
        if (selfSigned) notes.push('self-signed');
        if (mismatch) notes.push('name does not match the certificate');
        finish({
          ok: !(daysLeft != null && daysLeft < 0),
          summary: `TLS up on ${port}: ${subject}${issuer && !selfSigned ? ` issued by ${issuer}` : ''}${validTo ? `, valid to ${validTo.toISOString().slice(0, 10)}` : ''}${notes.length ? ` (${notes.join('; ')})` : ''}`,
          data: { port, subject, issuer, validTo: validTo ? validTo.toISOString() : null, daysLeft, selfSigned, nameMismatch: mismatch ? mismatch.message : null, protocol: sock.getProtocol() },
        });
      });
      sock.once('timeout', () => finish({ ok: false, summary: `no TLS answer on ${port} (timed out)`, data: { port } }));
      sock.once('error', (e) => finish({ ok: false, summary: `TLS failed on ${port}: ${e.code || e.message}`, data: { port, error: e.code || e.message } }));
    });
  },
};
