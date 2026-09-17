'use strict';

const fs = require('node:fs/promises');
const { constants, createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u;
const TOP_PATH = /^[0-9a-f]{2}\/[0-9a-f]{64}-[0-9a-f-]{36}\.bin$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(code) {
  const error = new Error(`Backup capture failed (${code})`);
  error.code = code;
  return error;
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)
      || path.posix.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw fail('UNSAFE_RELATIVE_PATH');
  }
  return value;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
}

async function privateDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('UNSAFE_DIRECTORY');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw fail('WRONG_DIRECTORY_OWNER');
  await fs.chmod(directory, 0o700);
}

async function space(root, reserve, pending = 0) {
  const disk = await fs.statfs(root, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(reserve) + BigInt(pending)) throw fail('INSUFFICIENT_FREE_DISK');
}

async function hashFile(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

async function stableCopy(source, destination, root, reserve) {
  const beforePath = await fs.lstat(source, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw fail('UNSUPPORTED_SOURCE_ENTRY');
  await space(root, reserve, beforePath.size);
  let input;
  let output;
  const digest = createHash('sha256');
  try {
    input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await input.stat({ bigint: true });
    if (!sameFile(before, beforePath)) throw fail('SOURCE_CHANGED');
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('SOURCE_TOO_LARGE');
    output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
      if (bytesRead === 0) throw fail('SOURCE_CHANGED');
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw fail('COPY_WRITE_FAILED');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await output.sync();
    const after = await input.stat({ bigint: true });
    const afterPath = await fs.lstat(source, { bigint: true });
    if (!sameFile(before, after) || !sameFile(before, afterPath)) throw fail('SOURCE_CHANGED');
    return { size: Number(before.size), sha256: digest.digest('hex') };
  } finally {
    await Promise.allSettled([input?.close(), output?.close()]);
  }
}

async function copyTree(source, destination, label, root, reserve, files, prefix = '') {
  const before = await fs.lstat(source, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw fail('UNSUPPORTED_SOURCE_DIRECTORY');
  if (await fs.realpath(source) !== path.resolve(source)) throw fail('SYMLINK_SOURCE_DIRECTORY');
  await fs.mkdir(destination, { mode: 0o700 });
  const entries = (await fs.readdir(source)).sort();
  for (const entry of entries) {
    if (entry === '.incoming') continue;
    const relative = relativePath(prefix ? `${prefix}/${entry}` : entry);
    const input = path.join(source, entry);
    const output = path.join(destination, entry);
    const info = await fs.lstat(input);
    if (info.isSymbolicLink()) throw fail('SYMLINK_SOURCE_ENTRY');
    if (info.isDirectory()) {
      await copyTree(input, output, label, root, reserve, files, relative);
    } else if (info.isFile()) {
      files.push({ source: label, path: relative, ...await stableCopy(input, output, root, reserve) });
    } else {
      throw fail('UNSUPPORTED_SOURCE_ENTRY');
    }
  }
  const after = await fs.lstat(source, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw fail('SOURCE_DIRECTORY_CHANGED');
}

// These queries are intentionally shared with the isolated restore verifier.
// Exclude OIDs, owners, ACLs and mutable sequence counters from schema identity.
async function inspectSchema(client) {
  const columns = (await client.query(`
    select table_schema, table_name, column_name, ordinal_position,
           column_default, is_nullable, data_type, udt_schema, udt_name,
           character_maximum_length, numeric_precision, numeric_scale,
           datetime_precision, is_identity, identity_generation,
           is_generated, generation_expression, collation_name
    from information_schema.columns
    where table_schema <> 'information_schema' and table_schema !~ '^pg_'
    order by table_schema collate "C", table_name collate "C", ordinal_position
  `)).rows;
  const indexes = (await client.query(`
    select n.nspname as schema, t.relname as table_name, i.relname as name,
           pg_get_indexdef(i.oid) as definition, x.indisvalid as valid,
           x.indisready as ready
    from pg_index x join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
    order by n.nspname collate "C", t.relname collate "C", i.relname collate "C"
  `)).rows;
  const constraints = (await client.query(`
    select n.nspname as schema, t.relname as table_name, c.conname as name,
           c.contype as type, pg_get_constraintdef(c.oid) as definition,
           c.convalidated as validated, c.condeferrable as deferrable,
           c.condeferred as deferred
    from pg_constraint c join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
    where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
    order by n.nspname collate "C", t.relname collate "C", c.conname collate "C"
  `)).rows;
  const sequences = (await client.query(`
    select schemaname as schema, sequencename as name, data_type::text,
           start_value::text, min_value::text, max_value::text,
           increment_by::text, cycle, cache_size::text
    from pg_sequences
    where schemaname <> 'information_schema' and schemaname !~ '^pg_'
    order by schemaname collate "C", sequencename collate "C"
  `)).rows;
  return { columns, indexes, constraints, sequences };
}

function schemaFingerprint(schema) {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

function quotedIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function inspectSnapshot(client) {
  const metadata = (await client.query(`
    select current_database() as name, current_setting('server_version') as version,
           current_setting('server_version_num') as version_num,
           pg_database_size(current_database())::text as size,
           pg_export_snapshot() as snapshot
  `)).rows[0];
  const relations = (await client.query(`
    select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'm') and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
    order by n.nspname collate "C", c.relname collate "C"
  `)).rows;
  const tables = [];
  for (const relation of relations) {
    const result = await client.query(`select count(*)::text as count from ${quotedIdentifier(relation.schema)}.${quotedIdentifier(relation.name)}`);
    tables.push({ ...relation, count: result.rows[0].count });
  }
  const migrations = (await client.query('select id from public.schema_migrations order by id collate "C"')).rows.map((row) => row.id);
  const references = await inspectReferences(client);
  const schema = await inspectSchema(client);
  if (schema.indexes.some((index) => !index.valid || !index.ready)) throw fail('INVALID_DATABASE_INDEX');
  return { metadata, tables, migrations, schema, references };
}

async function inspectReferences(client) {
  const topDashboard = (await client.query(`
    select storage_path as path, file_size::text as size, sha256
    from public.top_dashboard_block_data_versions where storage_path is not null
    order by storage_path collate "C"
  `)).rows.map((row) => ({ ...row, size: Number(row.size) }));
  // Shared route-planner files use the same private, backed-up storage root.
  // Keep the existing manifest shape so pre-migration backups still restore.
  const sharedTable = await client.query("select to_regclass('public.support_shared_dashboard_json_snapshots') as name");
  if (sharedTable.rows[0]?.name) {
    const shared = await client.query(`select storage_path as path, file_size::text as size, sha256
      from public.support_shared_dashboard_json_snapshots order by storage_path collate "C"`);
    topDashboard.push(...shared.rows.map((row) => ({ ...row, size: Number(row.size) })));
    topDashboard.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  const clientDocuments = (await client.query(`
    select file_path as path, file_size::text as size
    from public.client_documents order by file_path collate "C", id
  `)).rows.map((row) => ({ ...row, size: Number(row.size) }));
  return { topDashboard, clientDocuments };
}

function verifyReferences(files, references) {
  const byPath = new Map(files.map((file) => [`${file.source}/${file.path}`, file]));
  for (const reference of references.topDashboard) {
    if (!TOP_PATH.test(reference.path) || !SHA256.test(reference.sha256)
        || !Number.isSafeInteger(reference.size) || reference.size <= 0) throw fail('INVALID_TOP_REFERENCE');
    const file = byPath.get(`top-dashboard/${reference.path}`);
    if (!file || file.size !== reference.size || file.sha256 !== reference.sha256) throw fail('TOP_REFERENCE_MISMATCH');
  }
  for (const reference of references.clientDocuments) {
    relativePath(reference.path);
    if (!reference.path.startsWith('client-documents/') || !Number.isSafeInteger(reference.size)
        || reference.size <= 0) throw fail('INVALID_DOCUMENT_REFERENCE');
    const file = byPath.get(`uploads/${reference.path}`);
    if (!file || file.size !== reference.size) throw fail('DOCUMENT_REFERENCE_MISMATCH');
  }
}

async function validateTar(ctx, filename, expectedFiles) {
  const { stdout } = await ctx.run('/usr/bin/tar', ['--quoting-style=literal', '-tzf', filename], { timeout: 600000 });
  const expected = new Set(expectedFiles);
  const observed = new Set();
  for (const raw of stdout.split('\n').filter(Boolean)) {
    const clean = raw.replace(/^\.\//u, '').replace(/\/$/u, '');
    if (!clean || clean === '.') continue;
    relativePath(clean);
    if (raw.endsWith('/')) continue;
    if (!expected.has(clean) || observed.has(clean)) throw fail('ARCHIVE_LIST_MISMATCH');
    observed.add(clean);
  }
  if (observed.size !== expected.size) throw fail('ARCHIVE_LIST_MISMATCH');
}

async function capture(ctx) {
  const { config } = ctx;
  const previousUmask = process.umask(0o077);
  const published = [];
  let work;
  let ownsWork = false;
  let client;
  let transaction = false;
  try {
    if (!NAME.test(config.project) || !Number.isSafeInteger(config.minFreeBytes) || config.minFreeBytes < 0) throw fail('INVALID_CONFIG');
    const root = await fs.realpath(ctx.root);
    if (root === path.parse(root).root) throw fail('UNSAFE_BACKUP_ROOT');
    for (const dir of ['', '.work', 'postgres', 'files', 'config', 'manifests']) await privateDirectory(path.join(root, dir));
    await space(root, config.minFreeBytes);
    const createdAt = new Date().toISOString();
    const utc = createdAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    const id = `${config.project}-${utc}-${randomBytes(6).toString('hex')}`;
    work = path.join(root, '.work', id);
    await fs.mkdir(work, { mode: 0o700 });
    ownsWork = true;
    const stagedFiles = path.join(work, 'files');
    const stagedConfig = path.join(work, 'config');
    await fs.mkdir(stagedFiles, { mode: 0o700 });
    await fs.mkdir(stagedConfig, { mode: 0o700 });

    client = await ctx.pgClient();
    await client.query('begin isolation level repeatable read read only');
    transaction = true;
    await client.query("set local statement_timeout = '15min'");
    await client.query("set local idle_in_transaction_session_timeout = '60min'");
    const snapshot = await inspectSnapshot(client);
    const postgresMajor = Math.floor(Number(snapshot.metadata.version_num) / 10000);
    const pgDump = path.join(config.pgBin, 'pg_dump');
    const pgRestore = path.join(config.pgBin, 'pg_restore');
    const version = (await ctx.run(pgDump, ['--version'], { timeout: 30000 })).stdout;
    if (!new RegExp(`\\b${postgresMajor}\\.`).test(version)) throw fail('POSTGRES_UTILITY_VERSION_MISMATCH');
    await space(root, config.minFreeBytes, BigInt(snapshot.metadata.size));
    const dump = path.join(work, `${id}.dump`);
    await ctx.run(pgDump, ['--format=custom', '--compress=6', '--no-owner', '--no-acl',
      `--snapshot=${snapshot.metadata.snapshot}`, '--file', dump], { env: ctx.pgEnv, timeout: 1800000 });
    await client.query('commit');
    transaction = false;
    await client.end();
    client = null;
    const dumpInfo = await fs.lstat(dump);
    if (!dumpInfo.isFile() || dumpInfo.size <= 0) throw fail('EMPTY_DATABASE_ARCHIVE');
    await fs.chmod(dump, 0o600);
    const archiveList = await ctx.run(pgRestore, ['--list', dump], { timeout: 600000 });
    if (!archiveList.stdout.includes('TABLE DATA')) throw fail('UNREADABLE_DATABASE_ARCHIVE');

    const files = [];
    const labels = new Set();
    const sources = [];
    for (const source of config.sources) {
      if (!NAME.test(source.name) || labels.has(source.name) || !path.isAbsolute(source.path)
          || path.resolve(source.path) === path.parse(source.path).root) throw fail('INVALID_SOURCE_CONFIG');
      labels.add(source.name);
      const sourceRoot = path.resolve(source.path);
      if (root === sourceRoot || root.startsWith(`${sourceRoot}${path.sep}`)
          || sourceRoot.startsWith(`${root}${path.sep}`)) throw fail('BACKUP_SOURCE_OVERLAP');
      await copyTree(sourceRoot, path.join(stagedFiles, source.name), source.name, root, config.minFreeBytes, files);
      sources.push({ name: source.name, path: sourceRoot });
    }
    files.sort((a, b) => `${a.source}/${a.path}` < `${b.source}/${b.path}` ? -1 : `${a.source}/${a.path}` > `${b.source}/${b.path}` ? 1 : 0);
    verifyReferences(files, snapshot.references);

    const configFiles = [];
    const configNames = new Set();
    for (const entry of config.configFiles) {
      if (!NAME.test(entry.name) || configNames.has(entry.name) || !path.isAbsolute(entry.path)) throw fail('INVALID_CONFIG_FILE');
      configNames.add(entry.name);
      // Explicitly configured files may be release symlinks; resolve once, then
      // read that fixed file with O_NOFOLLOW and stable inode/mtime checks.
      const filename = await fs.realpath(entry.path);
      configFiles.push({ name: entry.name, ...await stableCopy(filename, path.join(stagedConfig, entry.name), root, config.minFreeBytes) });
    }
    if (!configNames.has('app.env')) throw fail('MISSING_APP_CONFIG');
    const releasePath = path.join(config.appCurrent, '.release-id');
    const releaseId = (await fs.readFile(releasePath, 'utf8')).trim();
    if (!NAME.test(releaseId)) throw fail('INVALID_RELEASE_ID');

    const filesArchive = path.join(work, `${id}.files.tar.gz`);
    const configArchive = path.join(work, `${id}.config.tar.gz`);
    const stagedBytes = files.reduce((sum, file) => sum + BigInt(file.size), 0n)
      + configFiles.reduce((sum, file) => sum + BigInt(file.size), 0n);
    await space(root, config.minFreeBytes, stagedBytes + 1024n * 1024n);
    await ctx.run('/usr/bin/tar', ['--format=posix', '--pax-option=delete=atime,delete=ctime', '-czf', filesArchive, '-C', stagedFiles, '.'], { timeout: 1800000 });
    await validateTar(ctx, filesArchive, files.map((file) => `${file.source}/${file.path}`));
    await ctx.run('/usr/bin/tar', ['--format=posix', '--pax-option=delete=atime,delete=ctime', '-czf', configArchive, '-C', stagedConfig, '.'], { timeout: 600000 });
    await validateTar(ctx, configArchive, configFiles.map((file) => file.name));

    const artifacts = [];
    const pending = [
      { kind: 'postgres', source: dump, key: `postgres/${id}.dump` },
      { kind: 'files', source: filesArchive, key: `files/${id}.tar.gz` },
      { kind: 'config', source: configArchive, key: `config/${id}.tar.gz` },
    ];
    for (const artifact of pending) {
      await fs.chmod(artifact.source, 0o600);
      const info = await fs.lstat(artifact.source);
      if (!info.isFile() || info.size <= 0) throw fail('EMPTY_ARTIFACT');
      const handle = await fs.open(artifact.source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      artifacts.push({ kind: artifact.kind, key: artifact.key, size: info.size, sha256: await hashFile(artifact.source) });
    }
    const manifest = {
      version: 1, project: config.project, id, createdAt, completedAt: new Date().toISOString(),
      postgresMajor, databaseVersion: snapshot.metadata.version, databaseName: snapshot.metadata.name,
      releaseId, artifacts, tables: snapshot.tables, migrations: snapshot.migrations,
      schema: snapshot.schema, schemaFingerprint: schemaFingerprint(snapshot.schema),
      files, configFiles, sources, references: snapshot.references,
    };
    const manifestPartial = path.join(work, `${id}.json`);
    const manifestHandle = await fs.open(manifestPartial, 'wx', 0o600);
    try {
      await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await manifestHandle.sync();
    } finally { await manifestHandle.close(); }
    for (const item of [...pending, { source: manifestPartial, key: `manifests/${id}.json` }]) {
      const target = path.join(root, item.key);
      const exists = await fs.lstat(target).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) throw fail('BACKUP_NAME_COLLISION');
      await fs.rename(item.source, target);
      published.push(target);
      const directory = await fs.open(path.dirname(target), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    ctx.log(`Captured ${id}: ${artifacts.length} verified artifacts, ${files.length} files, ${snapshot.tables.length} tables`);
    return manifest;
  } catch (error) {
    for (const filename of published.reverse()) await fs.unlink(filename).catch(() => {});
    if (error?.code && /^[A-Z_]+$/u.test(error.code) && error.message === `Backup capture failed (${error.code})`) throw error;
    throw fail('CAPTURE_IO_OR_DATABASE_ERROR');
  } finally {
    if (client) {
      if (transaction) await client.query('rollback').catch(() => {});
      await client.end().catch(() => {});
    }
    if (ownsWork) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    process.umask(previousUmask);
  }
}

module.exports = { capture, inspectSchema, schemaFingerprint, inspectReferences };
