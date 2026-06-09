const BASE_URL = process.env.BUILDIUM_BASE_URL || 'https://api.buildium.com';
const CLIENT_ID = process.env.BUILDIUM_CLIENT_ID;
const CLIENT_SECRET = process.env.BUILDIUM_CLIENT_SECRET;

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const LEASE_STATUSES = ['Active', 'Past', 'Future'];

function pick(obj, ...names) {
  if (!obj) return undefined;
  for (const n of names) if (obj[n] !== undefined) return obj[n];
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined) return v;
  }
  return undefined;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fullName(t) {
  const first = pick(t, 'FirstName', 'first_name') || '';
  const last = pick(t, 'LastName', 'last_name') || '';
  return `${first} ${last}`.trim();
}

function assertCreds() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    const e = new Error('Buildium credentials are not set. Add BUILDIUM_CLIENT_ID and BUILDIUM_CLIENT_SECRET as environment variables in the Vercel dashboard.');
    e.code = 'NO_CREDENTIALS';
    throw e;
  }
}

async function buildiumGet(pathname, params = {}) {
  assertCreds();
  const url = new URL(BASE_URL + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else if (value !== undefined && value !== null) url.searchParams.append(key, value);
  }
  const res = await fetch(url, {
    headers: {
      'x-buildium-client-id': CLIENT_ID,
      'x-buildium-client-secret': CLIENT_SECRET,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { }
    const e = new Error(`Buildium ${pathname} → ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    e.code = res.status === 401 || res.status === 403 ? 'AUTH' : 'BUILDIUM_ERROR';
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function getAll(pathname, params = {}) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await buildiumGet(pathname, { ...params, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const glAccounts = await getAll('/v1/glaccounts');
    const rentals    = await getAll('/v1/rentals');
    const leases     = await getAll('/v1/leases', { leasestatuses: LEASE_STATUSES });
    const balances   = await getAll('/v1/leases/outstandingbalances', { leasestatuses: LEASE_STATUSES });

    const glById = new Map();
    for (const g of glAccounts) {
      const id = pick(g, 'Id', 'id');
      glById.set(String(id), { id, name: pick(g, 'Name', 'name') || 'Unnamed GL account', type: pick(g, 'Type', 'type') || null });
    }

    const propNameById = new Map();
    for (const p of rentals) {
      propNameById.set(String(pick(p, 'Id', 'id')), pick(p, 'Name', 'name') || 'Unknown property');
    }

    const leaseById = new Map();
    for (const l of leases) {
      const current  = pick(l, 'CurrentTenants', 'current_tenants') || [];
      const everyone = pick(l, 'Tenants', 'tenants') || [];
      const tenants  = (current.length ? current : everyone).map(fullName).filter(Boolean);
      leaseById.set(String(pick(l, 'Id', 'id')), {
        tenants,
        unitNumber: pick(l, 'UnitNumber', 'unit_number') || null,
        from:       pick(l, 'LeaseFromDate', 'lease_from_date') || null,
        to:         pick(l, 'LeaseToDate', 'lease_to_date') || null,
        status:     pick(l, 'LeaseStatus', 'lease_status') || null,
        propertyId: pick(l, 'PropertyId', 'property_id') || null,
      });
    }

    const glSeen = new Map();
    const rows = balances.map((b) => {
      const leaseId    = pick(b, 'LeaseId', 'lease_id');
      const lease      = leaseById.get(String(leaseId)) || {};
      const propertyId = lease.propertyId ?? pick(b, 'PropertyId', 'property_id');

      const breakdown = (pick(b, 'Balances', 'balances') || []).map((line) => {
        const glId = pick(line, 'GLAccountId', 'GlAccountId', 'gl_account_id');
        const gl   = glById.get(String(glId));
        if (gl) glSeen.set(String(glId), gl);
        return { glAccountId: glId, glName: gl ? gl.name : `GL account #${glId}`, glType: gl ? gl.type : null, amount: num(pick(line, 'TotalBalance', 'total_balance')) };
      });

      return {
        leaseId,
        tenants:      lease.tenants || [],
        propertyId,
        propertyName: propNameById.get(String(propertyId)) || 'Unknown property',
        unitNumber:   lease.unitNumber,
        from:         lease.from,
        to:           lease.to,
        status:       lease.status,
        totalBalance: num(pick(b, 'TotalBalance', 'total_balance')),
        aging: {
          d0_30:    num(pick(b, 'Balance0To30Days', 'balance0_to30_days')),
          d31_60:   num(pick(b, 'Balance31To60Days', 'balance31_to60_days')),
          d61_90:   num(pick(b, 'Balance61To90Days', 'balance61_to90_days')),
          d90_plus: num(pick(b, 'BalanceOver90Days', 'balance_over90_days')),
        },
        breakdown,
      };
    });

    const glList           = [...glSeen.values()].sort((a, b) => a.name.localeCompare(b.name));
    const totalOutstanding = rows.reduce((s, r) => s + r.totalBalance, 0);

    res.status(200).json({ generatedAt: new Date().toISOString(), currency: 'USD', totals: { totalOutstanding, leaseCount: rows.length }, glAccounts: glList, rows });
  } catch (err) {
    const status = err.code === 'NO_CREDENTIALS' ? 400 : err.code === 'AUTH' ? 401 : 502;
    res.status(status).json({ error: err.message, code: err.code || 'ERROR' });
  }
}
