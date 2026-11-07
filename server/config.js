// Configuration loading: env vars first, then an optional JSON config file.
import path from 'node:path';
import fs from 'node:fs';

function resolvePaths(rawPaths, cwd) {
  return rawPaths
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map((p) => path.resolve(cwd, p));
}

export function loadConfig(cwd = process.cwd()) {
  const env = process.env;
  const dataDir = path.resolve(cwd, env.DATA_DIR || './data');
  const configFile = path.resolve(cwd, env.BIBLIOTECA_CONFIG || path.join(dataDir, 'config.json'));

  let fileConfig = {};
  if (fs.existsSync(configFile)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8')) || {};
    } catch (err) {
      console.warn(`[config] cannot parse ${configFile}: ${err.message}`);
    }
  }

  // LIBRARY_PATHS is a colon-separated list of folders ("/books:/more-books").
  let rawPaths = [];
  let source = 'default';
  if (env.LIBRARY_PATHS && env.LIBRARY_PATHS.trim()) {
    rawPaths = env.LIBRARY_PATHS.split(path.delimiter);
    source = 'env:LIBRARY_PATHS';
  } else if (Array.isArray(fileConfig.libraryPaths) && fileConfig.libraryPaths.length) {
    rawPaths = fileConfig.libraryPaths;
    source = `file:${configFile}`;
  }
  if (!rawPaths.length) {
    rawPaths = ['./sample-library'];
    source = 'default:sample-library';
  }

  const libraryPaths = [];
  for (const p of resolvePaths(rawPaths, cwd)) {
    if (!fs.existsSync(p)) {
      console.warn(`[config] library path does not exist: ${p}`);
    }
    if (!libraryPaths.includes(p)) libraryPaths.push(p);
  }

  const port = Number(env.PORT || fileConfig.port || 3000);
  return {
    port,
    host: env.HOST || '0.0.0.0',
    cwd,
    configFile,
    configSource: source,
    dataDir,
    dbPath: path.join(dataDir, 'biblioteca.db'),
    coversDir: path.join(dataDir, 'covers'),
    libraryPaths,
    rescanOnStart: (env.RESCAN_ON_START ?? 'true') !== 'false',
    version: '1.0.0',
  };
}
