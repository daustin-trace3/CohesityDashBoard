// AWS cost drill-down helpers: per-service notes for the By Service table and resolution of Cost
// Explorer resource ids to inventory names. Pure functions over an injected db handle so the
// marketplace pack can copy this file unchanged.

const REGION_PREFIX_RE = /^[A-Z]{2,4}\d?-/;
const stripRegion = (usageType) => String(usageType || '').replace(REGION_PREFIX_RE, '');

/** Lightsail component a usage type belongs to, or null. */
function lightsailComponent(usageType) {
  const t = stripRegion(usageType).toLowerCase();
  if (!t) return null;
  if (t.includes('database')) return 'databases';
  if (t.includes('disk')) return 'block storage';
  if (t.includes('bucket')) return 'object storage';
  if (t.includes('loadbalancer')) return 'load balancers';
  if (t.includes('distribution') || t.includes('cdn')) return 'CDN distributions';
  if (t.includes('datatransfer') || t.includes('dataxfer')) return 'data transfer';
  if (t.includes('snapshot')) return 'snapshots';
  if (t.includes('domain') || t.includes('dns')) return 'DNS';
  if (t.includes('bundleusage') || t.startsWith('bundle')) return 'instances';
  return null;
}

const joinList = (items) => (items.length <= 1 ? items.join('')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Notes (array of short sentences) for one service line.
 * ctx: { db, accountId (optional), usageTypes: string[] seen in the window for this service }.
 */
function serviceNotes(service, ctx = {}) {
  const notes = [];
  const usageTypes = ctx.usageTypes || [];
  if (service === 'Amazon Relational Database Service') {
    notes.push('Includes Aurora (RDS and Aurora bill under this line).');
    if (ctx.db) {
      const acct = ctx.accountId ? 'WHERE account_id = ?' : '';
      const args = ctx.accountId ? [ctx.accountId] : [];
      const row = ctx.db.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN LOWER(engine) LIKE 'aurora%' THEN 1 ELSE 0 END) AS aurora
        FROM aws_rds_instances ${acct}
      `).get(...args);
      if (row?.total > 0) notes.push(`${row.aurora || 0} of ${row.total} registered instances run Aurora engines.`);
    }
    if (usageTypes.some((u) => stripRegion(u).toLowerCase().startsWith('aurora'))) {
      notes.push('Aurora storage and I/O usage types present.');
    }
  } else if (service === 'Amazon Lightsail') {
    const order = ['instances', 'databases', 'block storage', 'object storage', 'load balancers',
      'CDN distributions', 'data transfer', 'snapshots', 'DNS'];
    const found = new Set(usageTypes.map(lightsailComponent).filter(Boolean));
    const components = order.filter((c) => found.has(c));
    notes.push(components.length
      ? `Covers ${joinList(components)}.`
      : 'Instances, databases, disks, buckets, load balancers and CDN all bill under this line.');
  }
  return notes;
}

const arnTail = (arn) => {
  const s = String(arn || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
  return i >= 0 ? s.slice(i + 1) : s;
};

const LIGHTSAIL_KINDS = {
  Instance: 'Lightsail instance', RelationalDatabase: 'Lightsail database', Disk: 'Lightsail disk',
  Bucket: 'Lightsail bucket', LoadBalancer: 'Lightsail load balancer',
  Distribution: 'Lightsail distribution', Domain: 'Lightsail domain',
};

/**
 * Resolve a Cost Explorer resource id to { label, kind, link }. Never throws on an odd id.
 */
function resolveCostResource(resourceId, service, db, accountId) {
  const id = String(resourceId || '');
  const acct = accountId ? ' AND account_id = ?' : '';
  const acctArg = accountId ? [accountId] : [];
  const find = (sql, value) => {
    try { return db.prepare(`${sql}${acct}`).get(value, ...acctArg) || null; } catch { return null; }
  };
  const fallback = (kind) => ({ label: arnTail(id) || id, kind, link: null });
  try {
    const parts = id.startsWith('arn:') ? id.split(':') : null;
    const arnService = parts ? parts[2] : null;
    const arnResource = parts ? parts.slice(5).join(':') : '';

    if (/^i-[0-9a-z]+$/i.test(id) || (arnService === 'ec2' && /^instance\/i-/.test(arnResource))) {
      const iid = arnTail(id);
      const r = find('SELECT name FROM aws_ec2_instances WHERE instance_id = ?', iid);
      return { label: r?.name || iid, kind: 'EC2 instance', link: `/aws/ec2?q=${iid}` };
    }
    if (/^vol-[0-9a-z]+$/i.test(id) || (arnService === 'ec2' && /^volume\/vol-/.test(arnResource))) {
      const vid = arnTail(id);
      const r = find('SELECT volume_id FROM aws_ebs_volumes WHERE volume_id = ?', vid);
      return { label: r?.volume_id || vid, kind: 'EBS volume', link: `/aws/ec2?q=${vid}` };
    }
    if (arnService === 'lightsail' || (!parts && service === 'Amazon Lightsail')) {
      const segment = parts ? arnResource.split('/')[0] : null;
      const name = arnTail(id);
      const kind = (segment && LIGHTSAIL_KINDS[segment]) || (parts ? 'Lightsail resource' : 'Lightsail instance');
      const r = (!segment || segment === 'Instance')
        ? find('SELECT name FROM aws_lightsail_instances WHERE name = ?', name) : null;
      if (!parts && !r) return { label: name, kind: 'Lightsail resource', link: null };
      return { label: r?.name || name, kind, link: `/aws/lightsail?q=${r?.name || name}` };
    }
    if (arnService === 'rds') {
      const isCluster = /^cluster:/.test(arnResource);
      const dbId = arnTail(id);
      const r = find('SELECT db_id FROM aws_rds_instances WHERE db_id = ?', dbId);
      return { label: r?.db_id || dbId, kind: isCluster ? 'Aurora cluster' : 'RDS instance', link: `/aws/rds?q=${dbId}` };
    }
    if (!parts && service === 'Amazon Relational Database Service') {
      const r = find('SELECT db_id FROM aws_rds_instances WHERE db_id = ?', id);
      if (r) return { label: r.db_id, kind: 'RDS instance', link: `/aws/rds?q=${r.db_id}` };
    }
    if (!parts && service === 'Amazon Simple Storage Service') {
      const r = find('SELECT name FROM aws_s3_buckets WHERE name = ?', id);
      return { label: r?.name || id, kind: 'S3 bucket', link: `/aws/s3?q=${id}` };
    }
    if (arnService === 'lambda') {
      const name = arnTail(id);
      const r = find('SELECT name FROM aws_lambda_functions WHERE name = ?', name);
      return { label: r?.name || name, kind: 'Lambda function', link: `/aws/lambda?q=${name}` };
    }
    if (arnService === 'dynamodb') {
      const name = arnTail(id);
      const r = find('SELECT name FROM aws_dynamo_tables WHERE name = ?', name);
      return { label: r?.name || name, kind: 'DynamoDB table', link: `/aws/dynamo?q=${name}` };
    }
    if (arnService === 'ecs') return { label: arnTail(id) || id, kind: 'ECS', link: '/aws/ecs' };
    if (arnService) return fallback(arnService.toUpperCase());
    return fallback('Resource');
  } catch {
    return { label: id, kind: 'Resource', link: null };
  }
}

module.exports = { serviceNotes, lightsailComponent, resolveCostResource, stripRegion };
