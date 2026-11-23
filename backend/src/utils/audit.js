// Audit logging helper — every mutating route calls logAudit() so the
// audit_logs table records who did what, to which entity, and when.
// Never log passwords, tokens, or password_hash values.
const { query } = require('../config/db');

async function logAudit({ userId, action, entityType, entityId, oldValues, newValues, req }) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        userId || null, action, entityType || null, entityId || null,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        req?.ip || null, req?.get?.('user-agent') || null,
      ],
    );
  } catch (err) {
    // Audit failure must never break the user's request.
    console.error('[audit] failed to write log:', err.message);
  }
}

module.exports = { logAudit };
