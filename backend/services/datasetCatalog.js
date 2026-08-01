// Declared dataset catalog (custom dashboards, phase 1). Plugins declare
// queryable datasets via manifest.datasets (registered by core/registry.js);
// core Cohesity datasets are registered directly. Widgets/charts only ever
// query declared datasets — never raw SQL — so RBAC is enforceable per
// dataset and internal tables stay refactorable.
//
// Dataset shape:
//   {
//     id: '<ns>.<name>',          // e.g. 'zerto.vpgs'
//     label: 'Zerto VPGs',
//     table: 'zerto_vpgs',        // plugin tables must be prefixed '<ns>_'
//     section: 'overview',        // read permission = `<ns>:<section>:view`
//     defaultSort: 'name',
//     columns: [{ key, label, type, filterable?, aggregatable? }, ...]
//   }
const { hasPermission } = require('./rbac');

const NAME_PATTERN = /^[a-z0-9_-]+$/;
const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMN_TYPES = new Set(['string', 'number', 'boolean', 'datetime', 'enum']);
const FILTER_OPS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', in: 'IN' };
const AGGREGATE_FNS = new Set(['count', 'sum', 'avg', 'min', 'max']);
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;
const MAX_IN_VALUES = 100;

const datasets = new Map(); // id -> normalized dataset

class DatasetQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatasetQueryError';
  }
}

function tablePrefix(ns) {
  return `${ns.replace(/-/g, '_')}_`;
}

function validateDataset(ns, ds, { core }) {
  if (!ds || typeof ds !== 'object') throw new Error(`dataset for '${ns}' must be an object`);
  const { id, label, table, columns } = ds;
  if (typeof id !== 'string' || !id.startsWith(`${ns}.`) || !NAME_PATTERN.test(id.slice(ns.length + 1))) {
    throw new Error(`dataset id '${String(id)}' must be '${ns}.<name>' with name matching ${NAME_PATTERN}`);
  }
  if (datasets.has(id)) throw new Error(`dataset '${id}' is already registered`);
  if (!label || typeof label !== 'string') throw new Error(`dataset '${id}': label is required`);
  if (typeof table !== 'string' || !IDENT_PATTERN.test(table)) {
    throw new Error(`dataset '${id}': invalid table name '${String(table)}'`);
  }
  if (!core && !table.startsWith(tablePrefix(ns))) {
    throw new Error(`dataset '${id}': table '${table}' must be prefixed '${tablePrefix(ns)}'`);
  }
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > 64) {
    throw new Error(`dataset '${id}': columns must be a non-empty array (max 64)`);
  }
  const keys = new Set();
  for (const col of columns) {
    if (!col || typeof col.key !== 'string' || !IDENT_PATTERN.test(col.key)) {
      throw new Error(`dataset '${id}': invalid column key '${String(col && col.key)}'`);
    }
    if (keys.has(col.key)) throw new Error(`dataset '${id}': duplicate column '${col.key}'`);
    keys.add(col.key);
    if (!COLUMN_TYPES.has(col.type)) {
      throw new Error(`dataset '${id}': column '${col.key}' has invalid type '${String(col.type)}'`);
    }
  }
  if (ds.defaultSort != null && !keys.has(ds.defaultSort)) {
    throw new Error(`dataset '${id}': defaultSort '${ds.defaultSort}' is not a declared column`);
  }
  if (ds.section != null && (typeof ds.section !== 'string' || !NAME_PATTERN.test(ds.section))) {
    throw new Error(`dataset '${id}': invalid section '${String(ds.section)}'`);
  }
}

/**
 * Registers a namespace's datasets. Re-registering a namespace replaces its
 * previous datasets (boot/test idempotency). `core: true` skips the
 * table-prefix ownership check (core Cohesity tables predate the convention).
 */
function registerDatasets(ns, list, { core = false } = {}) {
  if (typeof ns !== 'string' || !NAME_PATTERN.test(ns)) throw new Error(`invalid dataset namespace '${String(ns)}'`);
  if (!Array.isArray(list)) throw new Error(`datasets for '${ns}' must be an array`);
  unregisterNamespace(ns);
  const staged = [];
  for (const ds of list) {
    validateDataset(ns, ds, { core });
    if (staged.some((s) => s.id === ds.id)) throw new Error(`dataset '${ds.id}' is declared twice`);
    staged.push({
      id: ds.id,
      ns,
      core,
      label: ds.label,
      table: ds.table,
      section: ds.section || 'overview',
      defaultSort: ds.defaultSort || null,
      columns: ds.columns.map((c) => ({
        key: c.key,
        label: c.label || c.key,
        type: c.type,
        filterable: !!c.filterable,
        aggregatable: !!c.aggregatable,
      })),
    });
  }
  for (const ds of staged) datasets.set(ds.id, ds);
  return staged.length;
}

function unregisterNamespace(ns) {
  for (const [id, ds] of datasets) {
    if (ds.ns === ns) datasets.delete(id);
  }
}

function requiredPermission(ds) {
  return `${ds.ns}:${ds.section}:view`;
}

/** Platform availability: core namespaces are always available; plugin
 *  namespaces require an enabled, active, entitled registry entry. */
function isAvailable(ds) {
  if (ds.core) return true;
  const registry = require('../core/registry'); // lazy: registry requires this module
  const entry = registry.getPlugin(ds.ns);
  return !!(entry && entry.enabled && entry.status === 'active' && entry.entitled);
}

function toPublic(ds) {
  return {
    id: ds.id,
    platform: ds.ns,
    label: ds.label,
    section: ds.section,
    defaultSort: ds.defaultSort,
    permission: requiredPermission(ds),
    columns: ds.columns,
  };
}

/** Catalog visible to a viewer: available platforms + granted datasets only. */
function listDatasets(grants) {
  return Array.from(datasets.values())
    .filter((ds) => isAvailable(ds) && hasPermission(grants, requiredPermission(ds)))
    .map(toPublic);
}

function getDataset(id) {
  return datasets.get(id) || null;
}

function coerceValue(col, value) {
  if (value === null) return null;
  switch (col.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DatasetQueryError(`filter value for '${col.key}' must be a number`);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw new DatasetQueryError(`filter value for '${col.key}' must be a boolean`);
      return value ? 1 : 0;
    default:
      if (typeof value !== 'string' || value.length > 500) {
        throw new DatasetQueryError(`filter value for '${col.key}' must be a string (max 500 chars)`);
      }
      return value;
  }
}

function buildWhere(ds, filters, params) {
  if (filters == null) return '';
  if (!Array.isArray(filters) || filters.length > 20) {
    throw new DatasetQueryError('filters must be an array (max 20)');
  }
  const clauses = [];
  for (const f of filters) {
    const col = ds.columns.find((c) => c.key === (f && f.column));
    if (!col) throw new DatasetQueryError(`unknown filter column '${String(f && f.column)}'`);
    if (!col.filterable) throw new DatasetQueryError(`column '${col.key}' is not filterable`);
    const op = FILTER_OPS[f.op];
    if (!op) throw new DatasetQueryError(`unknown filter op '${String(f.op)}'`);
    if (f.op === 'in') {
      if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > MAX_IN_VALUES) {
        throw new DatasetQueryError(`'in' filter on '${col.key}' needs 1-${MAX_IN_VALUES} values`);
      }
      const coerced = f.value.map((v) => coerceValue(col, v));
      clauses.push(`"${col.key}" IN (${coerced.map(() => '?').join(', ')})`);
      params.push(...coerced);
    } else if (f.value === null && (f.op === 'eq' || f.op === 'neq')) {
      clauses.push(`"${col.key}" IS ${f.op === 'eq' ? '' : 'NOT '}NULL`);
    } else {
      clauses.push(`"${col.key}" ${op} ?`);
      params.push(coerceValue(col, f.value));
    }
  }
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * Runs a declared-shape query against a dataset. Identifiers come only from
 * the dataset declaration; every value is parameterized.
 *
 * query = { columns?, filters?, groupBy?, aggregate?, sort?, limit?, offset? }
 * Grouped result rows are { group, value }.
 */
function queryDataset(db, id, query = {}) {
  const ds = datasets.get(id);
  if (!ds) throw new DatasetQueryError(`unknown dataset '${id}'`);

  const params = [];
  const where = buildWhere(ds, query.filters, params);
  const limit = Math.min(Math.max(1, Number.isInteger(query.limit) ? query.limit : DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Number.isInteger(query.offset) && query.offset > 0 ? query.offset : 0;

  let sql;
  let columns;
  if (query.groupBy != null || query.aggregate != null) {
    const groupCol = ds.columns.find((c) => c.key === query.groupBy);
    if (query.groupBy != null && !groupCol) throw new DatasetQueryError(`unknown groupBy column '${String(query.groupBy)}'`);
    if (groupCol && !groupCol.filterable) throw new DatasetQueryError(`column '${groupCol.key}' is not groupable`);
    const agg = query.aggregate || { fn: 'count', column: '*' };
    if (!AGGREGATE_FNS.has(agg.fn)) throw new DatasetQueryError(`unknown aggregate fn '${String(agg.fn)}'`);
    let aggExpr;
    if (agg.fn === 'count' && (agg.column === '*' || agg.column == null)) {
      aggExpr = 'COUNT(*)';
    } else {
      const aggCol = ds.columns.find((c) => c.key === agg.column);
      if (!aggCol) throw new DatasetQueryError(`unknown aggregate column '${String(agg.column)}'`);
      if (!aggCol.aggregatable) throw new DatasetQueryError(`column '${aggCol.key}' is not aggregatable`);
      aggExpr = `${agg.fn.toUpperCase()}("${aggCol.key}")`;
    }
    if (groupCol) {
      sql = `SELECT "${groupCol.key}" AS "group", ${aggExpr} AS value FROM "${ds.table}"${where} GROUP BY "${groupCol.key}" ORDER BY value DESC LIMIT ${limit} OFFSET ${offset}`;
      columns = ['group', 'value'];
    } else {
      sql = `SELECT ${aggExpr} AS value FROM "${ds.table}"${where}`;
      columns = ['value'];
    }
  } else {
    let selected = ds.columns;
    if (query.columns != null) {
      if (!Array.isArray(query.columns) || query.columns.length === 0) {
        throw new DatasetQueryError('columns must be a non-empty array');
      }
      selected = query.columns.map((key) => {
        const col = ds.columns.find((c) => c.key === key);
        if (!col) throw new DatasetQueryError(`unknown column '${String(key)}'`);
        return col;
      });
    }
    const sortKey = query.sort && query.sort.column != null ? query.sort.column : ds.defaultSort;
    let orderBy = '';
    if (sortKey != null) {
      const sortCol = ds.columns.find((c) => c.key === sortKey);
      if (!sortCol) throw new DatasetQueryError(`unknown sort column '${String(sortKey)}'`);
      const dir = query.sort && query.sort.dir === 'desc' ? 'DESC' : 'ASC';
      orderBy = ` ORDER BY "${sortCol.key}" ${dir}`;
    }
    sql = `SELECT ${selected.map((c) => `"${c.key}"`).join(', ')} FROM "${ds.table}"${where}${orderBy} LIMIT ${limit} OFFSET ${offset}`;
    columns = selected.map((c) => c.key);
  }

  const rows = db.prepare(sql).all(...params);
  return { dataset: ds.id, columns, rows };
}

/** Test-only. */
function _reset() {
  datasets.clear();
}

module.exports = {
  registerDatasets,
  unregisterNamespace,
  listDatasets,
  getDataset,
  requiredPermission,
  isAvailable,
  queryDataset,
  DatasetQueryError,
  _reset,
};
