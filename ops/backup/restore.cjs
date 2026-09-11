'use strict';

// Restore drills never accept a database URL or connect to the application DB.
// All PostgreSQL connection details below belong to one disposable cluster.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const PROJECT = 'kts-next-admin';
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_NAMES = new Set(['uploads', 'shared-uploads', 'top-dashboard', 'firmware']);
const KEY_COLUMNS = {
  admin_users: ['id', 'login', 'password_hash'],
  client_companies: ['id'],
  client_users: ['id', 'company_id'],
  client_documents: ['id', 'file_path', 'file_size'],
  wholesale_products: ['id', 'sku', 'category_id'],
  wholesale_categories: ['id', 'title'],
  wholesale_price_lists: ['id', 'token'],
  schema_migrations: ['id', 'applied_at'],
  top_dashboard_blocks: ['id'],
  top_dashboard_block_versions: ['block_id', 'id', 'html_content', 'sha256'],
  top_dashboard_block_data_versions: ['block_id', 'id', 'storage_path', 'compressed_payload', 'file_size', 'sha256'],
};

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function relativeName(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f\\]/.test(value) || value.startsWith('/')) {
    throw fail('RESTORE_UNSAFE_PATH');
  }
  if (value.split('/').some((part) => !part || part === '.' || part === '..')) throw fail('RESTORE_UNSAFE_PATH');
  return value;
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw fail('RESTORE_INVALID_IDENTIFIER');
  return '"' + value.replaceAll('"', '""') + '"';
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyArtifact(root, artifact) {
  const key = relativeName(artifact.key);
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || !SHA256.test(artifact.sha256)) {
    throw fail('RESTORE_INVALID_ARTIFACT');
  }
  const target = path.join(root, key);
  const real = await fsp.realpath(target);
  const stat = await fsp.lstat(target);
  if (!real.startsWith(root + path.sep) || !stat.isFile() || stat.isSymbolicLink()
      || stat.size !== artifact.size || await digest(target) !== artifact.sha256) {
    throw fail('RESTORE_ARTIFACT_INTEGRITY');
  }
  return target;
}

function expectedFiles(manifest, kind) {
  const expected = new Map();
  const entries = kind === 'files' ? manifest.files : manifest.configFiles;
  if (!Array.isArray(entries)) throw fail('RESTORE_MISSING_FILE_INVENTORY');
  for (const item of entries) {
    if (kind === 'files' && !SOURCE_NAMES.has(item.source)) throw fail('RESTORE_UNKNOWN_FILE_SOURCE');
    const name = relativeName(kind === 'files' ? item.source + '/' + item.path : item.name);
    if (expected.has(name) || !Number.isSafeInteger(item.size) || item.size < 0 || !SHA256.test(item.sha256)) {
      throw fail('RESTORE_INVALID_FILE_INVENTORY');
    }
    expected.set(name, item);
  }
  return expected;
}

function tarNumber(bytes) {
  // GNU base-256 size fields are deliberately not accepted: capture uses POSIX.
  const value = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(value)) throw fail('RESTORE_TAR_NUMBER');
  const number = value ? parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(number) || number < 0) throw fail('RESTORE_TAR_NUMBER');
  return number;
}

function tarText(bytes) {
  const zero = bytes.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(zero < 0 ? bytes : bytes.subarray(0, zero));
}

function readPax(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw fail('RESTORE_TAR_PAX');
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw fail('RESTORE_TAR_PAX');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length
        || bytes[offset + length - 1] !== 10) throw fail('RESTORE_TAR_PAX');
    const record = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(space + 1, offset + length - 1));
    const equal = record.indexOf('=');
    if (equal < 1) throw fail('RESTORE_TAR_PAX');
    const key = record.slice(0, equal);
    // Reject sparse files, link targets, ACLs, xattrs and unknown extensions.
    if (!['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)
        || Object.hasOwn(result, key)) throw fail('RESTORE_TAR_PAX');
    result[key] = record.slice(equal + 1);
    offset += length;
  }
  return result;
}

// Stream archives, checking every regular file against the signed-by-hash
// inventory. Nothing is extracted: traversal, links, devices and tar bombs
// cannot write to the host. This also proves the config archive is readable
// without printing or materializing its secret contents.
async function verifyTar(archive, expected, cancelled) {
  const source = fs.createReadStream(archive);
  const gunzip = zlib.createGunzip();
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const seen = new Set();
  const directories = new Set();
  for (const label of SOURCE_NAMES) directories.add(label);
  for (const name of expected.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join('/'));
  }
  let carry = Buffer.alloc(0);
  let entry = null;
  let padding = 0;
  let zeros = 0;
  let pax = null;
  let longName = null;
  let bytesVerified = 0;
  const finishEntry = () => {
    if (entry.type === 'x') pax = readPax(Buffer.concat(entry.chunks));
    else if (entry.type === 'L') longName = tarText(Buffer.concat(entry.chunks)).replace(/\n$/, '');
    else if (entry.type === '0') {
      if (entry.hash.digest('hex') !== expected.get(entry.name).sha256) throw fail('RESTORE_FILE_CHECKSUM');
      seen.add(entry.name);
      bytesVerified += entry.size;
    }
    padding = (512 - entry.size % 512) % 512;
    entry = null;
  };
  try {
    for await (const chunk of gunzip) {
      if (cancelled()) throw fail('RESTORE_INTERRUPTED');
      let data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      carry = Buffer.alloc(0);
      while (data.length) {
        if (entry) {
          const length = Math.min(entry.remaining, data.length);
          if (entry.hash) entry.hash.update(data.subarray(0, length));
          else if (entry.chunks) entry.chunks.push(Buffer.from(data.subarray(0, length)));
          entry.remaining -= length;
          data = data.subarray(length);
          if (entry.remaining === 0) finishEntry();
          continue;
        }
        if (padding) {
          const length = Math.min(padding, data.length);
          if (data.subarray(0, length).some((byte) => byte !== 0)) throw fail('RESTORE_TAR_PADDING');
          padding -= length;
          data = data.subarray(length);
          continue;
        }
        if (data.length < 512) { carry = Buffer.from(data); break; }
        const header = data.subarray(0, 512);
        data = data.subarray(512);
        if (header.every((byte) => byte === 0)) { zeros += 1; continue; }
        if (zeros) throw fail('RESTORE_TAR_TRAILING_ENTRY');
        const storedSum = tarNumber(header.subarray(148, 156));
        const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (storedSum !== sum) throw fail('RESTORE_TAR_HEADER_CHECKSUM');
        const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
        if (!['0', '5', 'x', 'L'].includes(type)) throw fail('RESTORE_TAR_UNSAFE_TYPE');
        let name = tarText(header.subarray(0, 100));
        const prefix = tarText(header.subarray(345, 500));
        if (prefix) name = prefix + '/' + name;
        let size = tarNumber(header.subarray(124, 136));
        if (type === 'x' || type === 'L') {
          if (size > 1024 * 1024 || pax || longName) throw fail('RESTORE_TAR_METADATA');
          entry = { type, size, remaining: size, chunks: [] };
        } else {
          name = pax?.path ?? longName ?? name;
          if (pax?.size !== undefined) {
            if (!/^(0|[1-9][0-9]*)$/.test(pax.size)) throw fail('RESTORE_TAR_NUMBER');
            size = Number(pax.size);
            if (!Number.isSafeInteger(size)) throw fail('RESTORE_TAR_NUMBER');
          }
          pax = null;
          longName = null;
          name = name.replace(/^\.\//, '').replace(/\/$/, '');
          const isRoot = type === '5' && (name === '' || name === '.');
          if (!isRoot) relativeName(name);
          if (type === '5') {
            if (size || (!isRoot && !directories.has(name) && !SOURCE_NAMES.has(name.split('/')[0]))) {
              throw fail('RESTORE_TAR_UNKNOWN_DIRECTORY');
            }
            entry = { type, name, size, remaining: 0 };
          } else {
            const item = expected.get(name);
            if (!item || seen.has(name) || item.size !== size) throw fail('RESTORE_TAR_INVENTORY_MISMATCH');
            entry = { type, name, size, remaining: size, hash: crypto.createHash('sha256') };
          }
        }
        if (!entry.remaining) finishEntry();
      }
    }
    if (entry || padding || carry.length || zeros < 2 || pax || longName || seen.size !== expected.size) {
      throw fail('RESTORE_TAR_INCOMPLETE');
    }
    return { count: seen.size, bytes: bytesVerified };
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}

async function capacity(config, directory) {
  let availableMemory = os.freemem();
  if (process.platform === 'linux') {
    const mem = await fsp.readFile('/proc/meminfo', 'utf8');
    const match = mem.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match) availableMemory = Number(match[1]) * 1024;
  }
  if (availableMemory < (config.minRestoreMemoryBytes ?? 1024 ** 3)) throw fail('RESTORE_INSUFFICIENT_MEMORY');
  const disk = await fsp.statfs(directory);
  if (disk.bavail * disk.bsize < (config.minFreeBytes ?? 3 * 1024 ** 3)) throw fail('RESTORE_INSUFFICIENT_DISK');
}

function compareRows(actual, expected, code) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw fail(code);
}

function logicalSchema(schema) {
  if (!schema || !Array.isArray(schema.columns)) throw fail('RESTORE_SCHEMA_INVENTORY_INVALID');
  const positions = new Map();
  const columns = schema.columns.map((column) => {
    const key = JSON.stringify([column.table_schema, column.table_name]);
    const previous = positions.get(key) ?? { physical: 0, logical: 0 };
    if (!Number.isSafeInteger(column.ordinal_position) || column.ordinal_position <= previous.physical) {
      throw fail('RESTORE_SCHEMA_COLUMN_ORDER_INVALID');
    }
    const position = { physical: column.ordinal_position, logical: previous.logical + 1 };
    positions.set(key, position);
    // DROP COLUMN leaves holes in attnum/information_schema.ordinal_position.
    // A logical pg_dump restore omits those invisible tombstones. Compare the
    // visible column order, preserving every name/type/default/constraint.
    return { ...column, ordinal_position: position.logical };
  });
  return { ...schema, columns };
}

async function canonicalChecks(client, schema) {
  const constraints = [];
  for (const constraint of schema.constraints) {
    if (constraint.type !== 'c') { constraints.push(constraint); continue; }
    if (typeof constraint.definition !== 'string' || !constraint.definition.startsWith('CHECK (')) {
      throw fail('RESTORE_CHECK_DEFINITION_INVALID');
    }
    const temporary = 'kts_check_' + crypto.randomBytes(8).toString('hex');
    const qualified = 'pg_temp.' + quoteIdentifier(temporary);
    await client.query(`create temporary table ${quoteIdentifier(temporary)}
      (like ${quoteIdentifier(constraint.schema)}.${quoteIdentifier(constraint.table_name)})`);
    try {
      // PostgreSQL can flatten associative AND groups after reparsing a CHECK
      // generated from BETWEEN. Let its own parser/deparser canonicalize both
      // definitions; never remove parentheses or rewrite Boolean text ourselves.
      await client.query(`alter table ${qualified} add constraint ${quoteIdentifier(constraint.name)} ${constraint.definition}`);
      const result = await client.query(`select pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = $1::regclass and conname = $2`, [qualified, constraint.name]);
      if (result.rows.length !== 1) throw fail('RESTORE_CHECK_CANONICALIZATION_FAILED');
      constraints.push({ ...constraint, definition: result.rows[0].definition });
    } finally {
      await client.query(`drop table ${qualified}`);
    }
  }
  return { ...schema, constraints };
}

async function validateDatabase(ctx, client, manifest, files) {
  const capture = require('./capture.cjs');
  const schema = await capture.inspectSchema(client);
  // First verify the captured schema's original fingerprint exactly. Only then
  // normalize the non-restorable physical dropped-column slots on both sides.
  const sourceSchemaValid = SHA256.test(manifest.schemaFingerprint) && manifest.schema
    && capture.schemaFingerprint(manifest.schema) === manifest.schemaFingerprint;
  const expectedLogicalFingerprint = sourceSchemaValid
    ? capture.schemaFingerprint(await canonicalChecks(client, logicalSchema(manifest.schema))) : null;
  const actualLogicalFingerprint = capture.schemaFingerprint(await canonicalChecks(client, logicalSchema(schema)));
  if (!sourceSchemaValid || actualLogicalFingerprint !== expectedLogicalFingerprint) {
    const differences = [];
    for (const section of ['columns', 'indexes', 'constraints', 'sequences']) {
      const identify = (record) => JSON.stringify(Object.fromEntries(
        ['schema', 'table_schema', 'table_name', 'column_name', 'name'].filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]])));
      const before = new Map((manifest.schema?.[section] ?? []).map((record) => [identify(record), record]));
      const after = new Map(schema[section].map((record) => [identify(record), record]));
      for (const identity of new Set([...before.keys(), ...after.keys()])) {
        const original = before.get(identity), restored = after.get(identity);
        const properties = [...new Set([...Object.keys(original ?? {}), ...Object.keys(restored ?? {})])]
          .filter((key) => JSON.stringify(original?.[key]) !== JSON.stringify(restored?.[key]));
        if (!original || !restored || properties.length) differences.push({ section, identity: JSON.parse(identity), properties,
          missingBefore: !original, missingAfter: !restored });
      }
    }
    if (ctx.atomicJson) await ctx.atomicJson(path.join(ctx.root, 'state', 'schema-diagnostic.json'), {
      id: manifest.id, expectedFingerprint: manifest.schemaFingerprint, actualFingerprint: capture.schemaFingerprint(schema),
      expectedFingerprintMatchesSchema: !!sourceSchemaValid, expectedLogicalFingerprint, actualLogicalFingerprint,
      differences, expected: manifest.schema, actual: schema,
    });
    ctx.log('restore_schema_mismatch ' + JSON.stringify(differences.slice(0, 5)));
    throw fail('RESTORE_SCHEMA_MISMATCH');
  }
  const tables = (await client.query(`select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'm') and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
    order by n.nspname collate "C", c.relname collate "C"`)).rows;
  const expectedTables = manifest.tables.map(({ schema: s, name }) => ({ schema: s, name }));
  compareRows(tables, expectedTables, 'RESTORE_TABLES_MISMATCH');
  let rowCount = 0n;
  for (const table of manifest.tables) {
    if (!/^(0|[1-9][0-9]*)$/.test(String(table.count))) throw fail('RESTORE_INVALID_ROW_COUNT');
    const result = await client.query(`select count(*)::text as count from ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`);
    if (result.rows[0].count !== String(table.count)) throw fail('RESTORE_ROW_COUNT_MISMATCH');
    rowCount += BigInt(table.count);
  }
  const columns = (await client.query(`select table_name, column_name from information_schema.columns
    where table_schema = 'public'`)).rows;
  const columnSet = new Set(columns.map((column) => column.table_name + '.' + column.column_name));
  for (const [table, names] of Object.entries(KEY_COLUMNS)) {
    if (names.some((name) => !columnSet.has(table + '.' + name))) throw fail('RESTORE_KEY_COLUMN_MISSING');
  }
  const migrations = (await client.query('select id from public.schema_migrations order by id collate "C"')).rows.map((row) => row.id);
  compareRows(migrations, manifest.migrations, 'RESTORE_MIGRATIONS_MISMATCH');
  const references = await capture.inspectReferences(client);
  compareRows(references, manifest.references, 'RESTORE_REFERENCES_MISMATCH');
  const top = references.topDashboard;
  for (const ref of top) {
    const file = files.get('top-dashboard/' + relativeName(ref.path));
    if (!file || file.size !== ref.size || file.sha256 !== ref.sha256) throw fail('RESTORE_TOP_FILE_MISSING');
  }
  const documents = references.clientDocuments;
  for (const document of documents) {
    if (!document.path.startsWith('client-documents/')) throw fail('RESTORE_DOCUMENT_PATH_UNSUPPORTED');
    const file = files.get('uploads/' + relativeName(document.path));
    if (!file || file.size !== document.size) throw fail('RESTORE_DOCUMENT_FILE_MISSING');
  }
  // A dump restored in a single transaction has already enforced all foreign
  // keys. Check the TOP payload invariant explicitly because files live outside DB.
  const invalidTop = await client.query(`select count(*)::text as count
    from public.top_dashboard_block_data_versions
    where (compressed_payload is null) = (storage_path is null)`);
  if (invalidTop.rows[0].count !== '0') throw fail('RESTORE_TOP_PAYLOAD_INVARIANT');
  return { tables: tables.length, rows: rowCount.toString(), migrations: migrations.length,
    topFiles: top.length, clientDocuments: documents.length, schemaFingerprint: actualLogicalFingerprint,
    sourceSchemaFingerprint: manifest.schemaFingerprint };
}

async function restore(ctx, manifest, downloadedRoot) {
  const { config } = ctx;
  if (manifest?.project !== PROJECT || !/^[A-Za-z0-9_-]+$/.test(manifest.id)
      || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.tables)
      || !Array.isArray(manifest.migrations) || process.getuid?.() === 0) throw fail('RESTORE_INVALID_CONTEXT');
  if (!path.isAbsolute(config.pgBin) || !path.isAbsolute(config.restoreRoot)) throw fail('RESTORE_INVALID_PATH');
  const root = await fsp.realpath(ctx.root);
  if (!path.resolve(config.restoreRoot).startsWith(root + path.sep)) throw fail('RESTORE_UNSAFE_TEMP_ROOT');
  await fsp.mkdir(config.restoreRoot, { recursive: true, mode: 0o700 });
  const restoreRoot = await fsp.realpath(config.restoreRoot);
  if (!restoreRoot.startsWith(root + path.sep) || restoreRoot === root) throw fail('RESTORE_UNSAFE_TEMP_ROOT');
  const rootStat = await fsp.stat(restoreRoot);
  if ((rootStat.mode & 0o077) || rootStat.uid !== process.getuid()) throw fail('RESTORE_UNSAFE_TEMP_PERMISSIONS');
  if (Buffer.byteLength(path.join(restoreRoot, 'kts-drill-XXXXXX/socket')) > 85) throw fail('RESTORE_SOCKET_PATH_TOO_LONG');
  await capacity(config, restoreRoot);
  const downloadRoot = await fsp.realpath(downloadedRoot);
  const artifacts = new Map();
  for (const artifact of manifest.artifacts) {
    if (!['postgres', 'files', 'config'].includes(artifact.kind) || artifacts.has(artifact.kind)) throw fail('RESTORE_INVALID_ARTIFACT_SET');
    artifacts.set(artifact.kind, { ...artifact, localPath: await verifyArtifact(downloadRoot, artifact) });
  }
  if (artifacts.size !== 3) throw fail('RESTORE_INCOMPLETE_BACKUP_SET');
  const temporary = await fsp.mkdtemp(path.join(restoreRoot, 'kts-drill-'));
  await fsp.chmod(temporary, 0o700);
  const marker = crypto.randomBytes(32).toString('hex');
  const markerFile = path.join(temporary, '.kts-restore-owner');
  await fsp.writeFile(markerFile, marker, { mode: 0o600, flag: 'wx' });
  const data = path.join(temporary, 'pgdata');
  const socket = path.join(temporary, 'socket');
  await fsp.mkdir(socket, { mode: 0o700 });
  const port = String(crypto.randomInt(20000, 60000));
  const bootstrap = 'kts_bootstrap_' + crypto.randomBytes(6).toString('hex');
  const database = 'kts_restore_' + crypto.randomBytes(6).toString('hex');
  const role = 'kts_restore';
  const env = { PATH: config.pgBin + ':/usr/bin:/bin', HOME: temporary, LANG: 'C', LC_ALL: 'C',
    PGHOST: socket, PGPORT: port, PGUSER: bootstrap, PGDATABASE: 'postgres',
    PGPASSFILE: path.join(temporary, '.unused-pgpass'), PGCONNECT_TIMEOUT: '10',
    PGSSLMODE: 'disable', PGTARGETSESSIONATTRS: 'read-write' };
  let started = false;
  let cancelled = false;
  let client;
  let cleaning;
  let startPromise;
  const pending = new Set();
  let stage = 'PREPARE';
  const run = async (binary, args, options = {}) => {
    if (cancelled && binary !== 'pg_ctl') throw fail('RESTORE_INTERRUPTED');
    const promise = ctx.run(path.join(config.pgBin, binary), args, { env, timeout: 60_000, ...options });
    pending.add(promise);
    try { return await promise; } finally { pending.delete(promise); }
  };
  const cleanup = () => cleaning ??= (async () => {
    if (startPromise) await startPromise.catch(() => {});
    if (client) { await client.end().catch(() => {}); client = null; }
    const control = async (args) => run('pg_ctl', ['-D', data, ...args], { timeout: 45_000 });
    let running = started;
    if (await fsp.stat(path.join(data, 'postmaster.pid')).then(() => true, () => false)) running = true;
    if (running) {
      await control(['-m', 'fast', '-w', '-t', '30', 'stop']).catch(async () => {
        await control(['-m', 'immediate', '-w', '-t', '10', 'stop']);
      }).catch(() => { throw fail('RESTORE_STOP_FAILED_DIRECTORY_PRESERVED'); });
      // A successful waited pg_ctl stop plus absent postmaster.pid is required;
      // generic command errors are never treated as proof of shutdown.
      if (await fsp.stat(path.join(data, 'postmaster.pid')).then(() => true, () => false)) {
        throw fail('RESTORE_PID_REMAINS_DIRECTORY_PRESERVED');
      }
    }
    await Promise.allSettled([...pending]);
    const stat = await fsp.lstat(temporary);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || path.dirname(temporary) !== restoreRoot || !path.basename(temporary).startsWith('kts-drill-')
        || await fsp.realpath(temporary) !== temporary || await fsp.readFile(markerFile, 'utf8') !== marker) {
      throw fail('RESTORE_CLEANUP_GUARD_FAILED');
    }
    await fsp.rm(temporary, { recursive: true, force: false });
  })();
  const onSignal = () => {
    cancelled = true;
    // The orchestrator owns process termination; a live cluster is stopped here
    // immediately as well as in finally. Never remove its directory on failure.
    cleanup().catch(() => ctx.log('restore_cleanup_failed_directory_preserved'));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    const version = await run('postgres', ['--version']);
    const major = String(version.stdout).match(/PostgreSQL\)\s+(\d+)/)?.[1];
    if (!major || Number(major) !== Number(manifest.postgresMajor)) throw fail('RESTORE_POSTGRES_VERSION_MISMATCH');
    stage = 'FILES';
    const fileInventory = expectedFiles(manifest, 'files');
    const fileReport = await verifyTar(artifacts.get('files').localPath, fileInventory, () => cancelled);
    const configReport = await verifyTar(artifacts.get('config').localPath, expectedFiles(manifest, 'config'), () => cancelled);
    stage = 'INITDB';
    await run('initdb', ['-D', data, '--username=' + bootstrap, '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--no-locale']);
    // Write configuration, avoiding pg_ctl -o's shell interpretation entirely.
    const pgConfigString = (value) => "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
    await fsp.appendFile(path.join(data, 'postgresql.conf'), '\n' + [
      "listen_addresses = ''", 'unix_socket_directories = ' + pgConfigString(socket),
      'unix_socket_permissions = 0700', 'port = ' + port, "shared_buffers = '64MB'", "work_mem = '4MB'",
      "maintenance_work_mem = '64MB'", 'max_connections = 10', 'max_worker_processes = 2',
      'max_parallel_workers = 0', "max_wal_size = '256MB'", 'log_min_messages = panic',
      'log_min_error_statement = panic', 'log_statement = none'].join('\n') + '\n', { mode: 0o600 });
    startPromise = run('pg_ctl', ['-D', data, '-l', path.join(temporary, 'postgres.log'), '-w', '-t', '30', 'start']);
    await startPromise;
    started = true;
    const { Client } = ctx.pgModule ?? require(path.join(config.appCurrent, 'node_modules/pg'));
    // Explicit options suppress every pg connection environment default.
    const connection = (user, db) => new Client({ host: socket, port: Number(port), user,
      database: db, password: crypto.randomBytes(32).toString('hex'), ssl: false,
      connectionTimeoutMillis: 10_000, query_timeout: 120_000, statement_timeout: 110_000,
      application_name: 'kts-isolated-restore', options: '' });
    client = connection(bootstrap, 'postgres');
    await client.connect();
    await client.query(`create role ${quoteIdentifier(role)} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await client.query(`create database ${quoteIdentifier(database)} owner ${quoteIdentifier(role)} template template0`);
    await client.end(); client = null;
    stage = 'PG_RESTORE';
    await run('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--no-password',
      '--host=' + socket, '--port=' + port, '--username=' + role, '--dbname=' + database,
      artifacts.get('postgres').localPath], { timeout: 30 * 60_000, env: { ...env, PGUSER: role, PGDATABASE: database } });
    stage = 'VALIDATE';
    client = connection(role, database);
    await client.connect();
    const privilege = (await client.query(`select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      from pg_roles where rolname = current_user`)).rows[0];
    if (!privilege || Object.values(privilege).some(Boolean)) throw fail('RESTORE_ROLE_PRIVILEGED');
    const databaseReport = await validateDatabase(ctx, client, manifest, fileInventory);
    const report = { project: PROJECT, id: manifest.id, restoredAt: new Date().toISOString(),
      source: downloadRoot === root ? 'local-backup' : 'yandex-object-storage', postgresMajor: Number(major), ...databaseReport,
      files: fileReport, configFiles: configReport,
      artifacts: manifest.artifacts.map(({ kind, size, sha256 }) => ({ kind, size, sha256 })) };
    if (cancelled) throw fail('RESTORE_INTERRUPTED');
    ctx.log('restore_verified', { id: manifest.id, tables: report.tables, files: fileReport.count });
    return report;
  } catch (error) {
    // pg errors can contain row values. Do not propagate arbitrary stderr,
    // error detail, connection options, SQL text or stack from dependencies.
    throw /^RESTORE_[A-Z_]+$/.test(error?.code ?? '') ? error : fail('RESTORE_' + stage + '_FAILED');
  } finally {
    try {
      await cleanup();
      if (cancelled) throw fail('RESTORE_INTERRUPTED');
    } finally {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    }
  }
}

module.exports = { restore };
