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

// Region prefixes Cost Explorer puts in front of usage types (USE1-BundleUsage:8GB).
const REGION_PREFIXES = {
  USE1: 'us-east-1', USE2: 'us-east-2', USW1: 'us-west-1', USW2: 'us-west-2', CAN1: 'ca-central-1',
  EUW1: 'eu-west-1', EUW2: 'eu-west-2', EUW3: 'eu-west-3', EUC1: 'eu-central-1', EUN1: 'eu-north-1',
  APN1: 'ap-northeast-1', APN2: 'ap-northeast-2', APS1: 'ap-southeast-1', APS2: 'ap-southeast-2',
  APS3: 'ap-south-1', SAE1: 'sa-east-1',
};

const OBJECT_CAP = 25;

/**
 * Derived mapping: which inventory objects a usage type names (region, bundle size, instance type,
 * volume type, engine class). Returns { mode: 'inventory', objects, objectCount, rule }.
 * objects: [{ resourceId, label, kind, link }], at most 25; objectCount is the full match count.
 */
function usageTypeObjects(usageType, service, db, accountId) {
  const raw = String(usageType || '');
  const m = /^([A-Z]{3,4}\d)-(.+)$/.exec(raw);
  const prefixRegion = m && REGION_PREFIXES[m[1]] ? REGION_PREFIXES[m[1]] : null;
  const body = prefixRegion ? m[2] : raw;
  const svc = String(service || '');
  const isLightsail = /lightsail/i.test(svc) || /^(BundleUsage|DatabaseUsage|LoadBalancerUsage|DiskUsage)/i.test(body);
  // Lightsail types without a prefix are unknown-region; EC2, EBS and RDS default to us-east-1.
  const region = prefixRegion || (isLightsail ? null : 'us-east-1');
  const regionText = region || 'any region';
  const acct = accountId ? ' AND account_id = ?' : '';
  const acctArg = accountId ? [accountId] : [];
  const empty = (rule = null) => ({ mode: 'inventory', objects: [], objectCount: 0, rule });

  const q = (sql, args = []) => {
    try { return db.prepare(`${sql}${acct}`).all(...args, ...acctArg); } catch { return []; }
  };
  const azLike = region ? ' AND az LIKE ?' : '';
  const azArg = region ? [`${region}%`] : [];
  const out = (rows, kind, linkBase, pick, rule) => {
    const objects = rows.slice(0, OBJECT_CAP).map((r) => {
      const id = pick(r);
      return { resourceId: id, label: id, kind, link: linkBase ? `${linkBase}?q=${id}` : null };
    });
    return { mode: 'inventory', objects, objectCount: rows.length, rule };
  };

  let t;
  if (isLightsail) {
    if ((t = /^BundleUsage:(\d+(?:\.\d+)?)GB(_win)?$/i.exec(body))) {
      const win = t[2] ? 1 : 0;
      const rows = q(`SELECT name FROM aws_lightsail_instances WHERE ram_gb = ? AND COALESCE(is_windows, 0) = ?${azLike}`,
        [Number(t[1]), win, ...azArg]);
      return out(rows, 'Lightsail instance', '/aws/lightsail', (r) => r.name,
        `${win ? 'Windows instances' : 'Instances'} on a ${t[1]} GB bundle in ${regionText}`);
    }
    if ((t = /^DatabaseUsage:(\d+(?:\.\d+)?)GB/i.exec(body))) {
      const rows = q(`SELECT name FROM aws_lightsail_databases WHERE ram_gb = ?${azLike}`, [Number(t[1]), ...azArg]);
      return out(rows, 'Lightsail database', '/aws/lightsail', (r) => r.name, `Databases on a ${t[1]} GB bundle in ${regionText}`);
    }
    const lower = body.toLowerCase();
    if (lower.startsWith('loadbalancer')) {
      return out(q(`SELECT name FROM aws_lightsail_load_balancers WHERE 1=1${azLike}`, azArg), 'Lightsail load balancer',
        '/aws/lightsail', (r) => r.name, `All load balancers in ${regionText}`);
    }
    if (lower.startsWith('disk')) {
      return out(q(`SELECT name FROM aws_lightsail_disks WHERE 1=1${azLike}`, azArg), 'Lightsail disk',
        '/aws/lightsail', (r) => r.name, `All disks in ${regionText}`);
    }
    if (lower.includes('bucket')) {
      return out(q('SELECT name FROM aws_lightsail_buckets WHERE 1=1'), 'Lightsail bucket', '/aws/lightsail', (r) => r.name, 'All Lightsail buckets');
    }
    if (lower.includes('snapshot')) {
      return out(q(`SELECT name FROM aws_lightsail_instances WHERE snapshot_count > 0${azLike}`, azArg), 'Lightsail instance',
        '/aws/lightsail', (r) => r.name, `Instances with snapshots in ${regionText}`);
    }
    if (lower.includes('distribution') || lower.includes('cdn')) {
      return out(q('SELECT name FROM aws_lightsail_distributions WHERE 1=1'), 'Lightsail distribution', '/aws/lightsail', (r) => r.name, 'All CDN distributions');
    }
    if (lower.includes('dns')) {
      return out(q('SELECT name FROM aws_lightsail_domains WHERE 1=1'), 'Lightsail domain', '/aws/lightsail', (r) => r.name, 'All DNS domains');
    }
    if (lower.includes('staticip') || lower.includes('idleaddress')) {
      return out(q('SELECT name FROM aws_lightsail_static_ips WHERE 1=1'), 'Lightsail static IP', '/aws/lightsail', (r) => r.name, 'All static IPs');
    }
    if (lower.includes('totaldataxfer')) {
      return out(q(`SELECT name FROM aws_lightsail_instances WHERE 1=1${azLike}`, azArg), 'Lightsail instance',
        '/aws/lightsail', (r) => r.name, `All instances in ${regionText}, transfer is pooled`);
    }
    return empty();
  }

  if (/dynamo/i.test(svc)) {
    return out(q('SELECT name FROM aws_dynamo_tables WHERE 1=1'), 'DynamoDB table', '/aws/dynamo', (r) => r.name, 'All DynamoDB tables');
  }
  if ((t = /^(?:BoxUsage|SpotUsage|DedicatedUsage|HeavyUsage):(.+)$/i.exec(body))) {
    const rows = q(`SELECT instance_id, name FROM aws_ec2_instances WHERE instance_type = ?${azLike}`, [t[1], ...azArg]);
    return out(rows, 'EC2 instance', '/aws/ec2', (r) => r.name || r.instance_id, `EC2 instances of type ${t[1]} in ${regionText}`);
  }
  if ((t = /^EBS:VolumeUsage(?:\.(.+))?$/i.exec(body))) {
    const vt = t[1] || 'standard';
    const rows = q(`SELECT volume_id FROM aws_ebs_volumes WHERE volume_type = ?${azLike}`, [vt, ...azArg]);
    return out(rows, 'EBS volume', '/aws/ec2', (r) => r.volume_id, `${vt} volumes in ${regionText}`);
  }
  if (/^EBS:SnapshotUsage/i.test(body)) return empty('Snapshots are not inventoried');
  if (/^PublicIPv4:IdleAddress/i.test(body)) return empty('Idle Elastic IPs are not inventoried');
  if (/^PublicIPv4:InUseAddress/i.test(body)) {
    const rows = q(`SELECT instance_id, name FROM aws_ec2_instances WHERE public_ip IS NOT NULL AND public_ip != ''${azLike}`, azArg);
    return out(rows, 'EC2 instance', '/aws/ec2', (r) => r.name || r.instance_id, `EC2 instances with a public IP in ${regionText}`);
  }
  if (/^NatGateway/i.test(body)) return empty('NAT gateways are not inventoried');
  if ((t = /^InstanceUsage:(.+)$/i.exec(body))) {
    const rows = q('SELECT db_id FROM aws_rds_instances WHERE instance_class = ?', [t[1]]);
    return out(rows, 'RDS instance', '/aws/rds', (r) => r.db_id, `RDS instances of class ${t[1]}`);
  }
  if (/^Aurora:/i.test(body)) {
    return out(q("SELECT db_id FROM aws_rds_instances WHERE LOWER(engine) LIKE 'aurora%'"), 'RDS instance', '/aws/rds',
      (r) => r.db_id, 'Instances running Aurora engines');
  }
  if (/^RDS:ChargedBackupUsage/i.test(body)) {
    return out(q('SELECT db_id FROM aws_rds_instances WHERE 1=1'), 'RDS instance', '/aws/rds', (r) => r.db_id, 'All RDS instances');
  }
  if (/^(TimedStorage-|Requests-)/i.test(body)) {
    const rows = q('SELECT name FROM aws_s3_buckets WHERE region = ?', [region]);
    return out(rows, 'S3 bucket', '/aws/s3', (r) => r.name, `S3 buckets in ${regionText}`);
  }
  if (/^(Lambda-GB-Second|Request)$/i.test(body)) {
    // Lambda rows carry no region column; the account scope is the best available match.
    return out(q('SELECT name FROM aws_lambda_functions WHERE 1=1'), 'Lambda function', '/aws/lambda', (r) => r.name, 'All Lambda functions');
  }
  return empty();
}

module.exports = { serviceNotes, lightsailComponent, resolveCostResource, stripRegion, usageTypeObjects, REGION_PREFIXES };

