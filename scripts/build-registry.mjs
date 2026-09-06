#!/usr/bin/env node
/**
 * build-registry.mjs — genera el registro de keys de Foundry.
 *
 *   FIGMA_TOKEN=figd_xxx node scripts/build-registry.mjs
 *
 * Salida:
 *   registry/foundry-registry.json  → el archivo que se publica y que el
 *                                     plugin baja en runtime
 *   foundryKeys.json                → snapshot embebido en el build
 *
 * Por qué dos endpoints por archivo:
 *
 *   /v1/files/:key/components        devuelve SOLO lo publicado en la
 *   /v1/files/:key/component_sets    librería. Los componentes privados
 *                                    (prefijo "." o "_") nunca aparecen.
 *                                    Ese es el origen del bug de
 *                                    ".tab_segment = legacy".
 *
 *   /v1/files/:key                   devuelve el documento completo, con
 *                                    los mapas `components` y
 *                                    `componentSets` de TODO el archivo,
 *                                    publicado o no.
 *
 * Si tu plan de Figma devuelve `key: ""` para componentes no publicados,
 * el script lo avisa: en ese caso usá el export del propio plugin
 * (pestaña Status → Exportar registro) y fusionalo con --merge.
 *
 * Flags:
 *   --merge <archivo.json>   fusiona un export hecho desde el plugin
 *   --out <ruta>             cambia la salida del registro
 *   --no-bundle              no reescribe foundryKeys.json
 *   --dry-run                no escribe nada
 *   --redact-sources         omite los fileKey de Figma en la salida
 *   --files <archivo.json>   lista de archivos a leer, en vez de la fija
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// Archivos fuente de Foundry.
//
// Orden de resolución, para que el repo público del registro no tenga que
// versionar los IDs de los archivos de Figma:
//   1. la variable de entorno FOUNDRY_FILES, con el JSON del array
//   2. --files <ruta a un JSON>
//   3. la lista por defecto de acá abajo
const DEFAULT_FOUNDRY_FILES = [
  // Vacío a propósito: este repo es público y no versiona los IDs de los
  // archivos de Figma. El workflow los pasa por el secret FOUNDRY_FILES.
];

const PRIVATE_PREFIXES = ['.', '_'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

async function resolveFoundryFiles() {
  if (process.env.FOUNDRY_FILES) {
    try {
      const parsed = JSON.parse(process.env.FOUNDRY_FILES);
      if (Array.isArray(parsed) && parsed.length) return parsed;
      console.error('FOUNDRY_FILES no es un array con elementos.');
      process.exit(1);
    } catch (e) {
      console.error('FOUNDRY_FILES no es JSON válido: ' + e.message);
      process.exit(1);
    }
  }
  const filesPath = value('--files', null);
  if (filesPath) {
    const raw = await fs.readFile(path.resolve(process.cwd(), filesPath), 'utf8');
    return JSON.parse(raw);
  }
  if (!DEFAULT_FOUNDRY_FILES.length) {
    console.error(
      'No hay archivos de Figma configurados.\n' +
      'Pasá FOUNDRY_FILES con el JSON del array, o --files <ruta.json>.\n' +
      'Formato: [{"fileKey":"...","name":"Foundry Components"}]',
    );
    process.exit(1);
  }
  return DEFAULT_FOUNDRY_FILES;
}

const FOUNDRY_FILES = await resolveFoundryFiles();

const TOKEN = process.env.FIGMA_TOKEN || process.env.FIGMA_PAT || '';
const OUT = path.resolve(root, value('--out', 'registry/foundry-registry.json'));
const BUNDLE = path.resolve(root, 'foundryKeys.json');
const MERGE = value('--merge', null);
const DRY = flag('--dry-run');

if (!TOKEN && !MERGE) {
  console.error('Falta FIGMA_TOKEN. Usá: FIGMA_TOKEN=figd_xxx node scripts/build-registry.mjs');
  process.exit(1);
}

const headers = { 'X-Figma-Token': TOKEN };

async function api(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} en ${url}\n${body.slice(0, 400)}`);
  }
  return res.json();
}

const isPrivate = (name) => !!name && PRIVATE_PREFIXES.some(p => name.trim().startsWith(p));

async function collectFile(file) {
  const stats = {
    fileKey: file.fileKey,
    name: file.name,
    publishedComponents: 0,
    publishedSets: 0,
    documentComponents: 0,
    documentSets: 0,
    privateCount: 0,
    emptyKeyCount: 0,
    styleCount: 0,
    error: null,
  };
  const componentKeys = new Set();
  const componentSetKeys = new Set();
  const styleKeys = new Set();

  // 1. Publicados en la librería
  try {
    const [comps, sets, styles] = await Promise.all([
      api(`https://api.figma.com/v1/files/${file.fileKey}/components`),
      api(`https://api.figma.com/v1/files/${file.fileKey}/component_sets`),
      api(`https://api.figma.com/v1/files/${file.fileKey}/styles`),
    ]);
    for (const c of comps.meta?.components || []) if (c.key) { componentKeys.add(c.key); stats.publishedComponents++; }
    for (const s of sets.meta?.component_sets || []) if (s.key) { componentSetKeys.add(s.key); stats.publishedSets++; }
    for (const s of styles.meta?.styles || []) if (s.key) { styleKeys.add(s.key); stats.styleCount++; }
  } catch (e) {
    stats.error = String(e.message || e);
  }

  // 2. Documento completo: acá aparecen los privados
  try {
    const doc = await api(`https://api.figma.com/v1/files/${file.fileKey}`);
    for (const [, c] of Object.entries(doc.components || {})) {
      stats.documentComponents++;
      if (isPrivate(c.name)) stats.privateCount++;
      if (c.key) componentKeys.add(c.key); else stats.emptyKeyCount++;
    }
    for (const [, s] of Object.entries(doc.componentSets || {})) {
      stats.documentSets++;
      if (isPrivate(s.name)) stats.privateCount++;
      if (s.key) componentSetKeys.add(s.key); else stats.emptyKeyCount++;
    }
  } catch (e) {
    stats.error = (stats.error ? stats.error + ' | ' : '') + String(e.message || e);
  }

  return { stats, componentKeys, componentSetKeys, styleKeys };
}

const allComponents = new Set();
const allSets = new Set();
const allStyles = new Set();
const sources = [];

if (TOKEN) {
  for (const file of FOUNDRY_FILES) {
    process.stdout.write(`→ ${file.name} (${file.fileKey}) … `);
    const { stats, componentKeys, componentSetKeys, styleKeys } = await collectFile(file);
    for (const k of componentKeys) allComponents.add(k);
    for (const k of componentSetKeys) allSets.add(k);
    for (const k of styleKeys) allStyles.add(k);
    sources.push({
      fileKey: file.fileKey,
      name: file.name,
      componentCount: componentKeys.size,
      componentSetCount: componentSetKeys.size,
      privateCount: stats.privateCount,
    });
    if (stats.error) console.log(`ERROR: ${stats.error}`);
    else console.log(
      `${componentKeys.size} comp · ${componentSetKeys.size} sets · ` +
      `${stats.privateCount} privados · ${stats.publishedComponents} publicados` +
      (stats.emptyKeyCount ? ` · ${stats.emptyKeyCount} SIN KEY` : ''),
    );
    if (stats.emptyKeyCount) {
      console.log(
        `   ⚠ ${stats.emptyKeyCount} componentes de "${file.name}" volvieron con key vacía.\n` +
        '     La REST API no expone la key de esos componentes. Exportá el registro\n' +
        '     desde el plugin (Status → Exportar registro) y fusionalo con --merge.',
      );
    }
  }
}

// Fusión con un export hecho desde el plugin
if (MERGE) {
  const rawMerge = JSON.parse(await fs.readFile(path.resolve(process.cwd(), MERGE), 'utf8'));
  const before = allComponents.size + allSets.size;
  for (const k of rawMerge.componentKeys || []) if (k) allComponents.add(k);
  for (const k of rawMerge.componentSetKeys || []) if (k) allSets.add(k);
  for (const k of rawMerge.styleKeys || []) if (k) allStyles.add(k);
  for (const s of rawMerge.sources || []) {
    if (!sources.some(x => x.fileKey === s.fileKey)) sources.push(s);
  }
  console.log(`→ merge ${MERGE}: +${allComponents.size + allSets.size - before} keys nuevas`);
}

// En el repo público del registro no hace falta exponer los IDs de los
// archivos de Figma: con --redact-sources se publican sólo los nombres.
const publishedSources = flag('--redact-sources')
  ? sources.map(({ fileKey, ...rest }) => rest)
  : sources;

const registry = {
  schema: 2,
  version: new Date().toISOString(),
  generatedAt: new Date().toISOString(),
  sources: publishedSources,
  componentKeys: [...allComponents].sort(),
  componentSetKeys: [...allSets].sort(),
  styleKeys: [...allStyles].sort(),
  privatePrefixes: PRIVATE_PREFIXES,
};

const total = registry.componentKeys.length + registry.componentSetKeys.length;
console.log(`\nTotal: ${total} keys (${registry.componentKeys.length} componentes, ${registry.componentSetKeys.length} sets, ${registry.styleKeys.length} estilos)`);

if (DRY) {
  console.log('--dry-run: no se escribió nada.');
  process.exit(0);
}

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(registry, null, 2) + '\n');
console.log(`Escrito ${path.relative(root, OUT)}`);

if (!flag('--no-bundle')) {
  await fs.writeFile(BUNDLE, JSON.stringify(registry) + '\n');
  console.log(`Escrito ${path.relative(root, BUNDLE)} (snapshot embebido)`);
}
