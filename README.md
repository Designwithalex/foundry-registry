# Foundry Registry

Registro público de component keys del sistema de diseño Foundry.

El plugin [Foundry Guardian](https://github.com/Designwithalex/foundry-guardian-kitkat)
baja este archivo al abrirse para saber qué componentes pertenecen al
sistema. Publicar una versión nueva acá alcanza para que todos los usuarios
del plugin la tomen: no hace falta una release nueva en Figma Community.

## El archivo

```
https://raw.githubusercontent.com/Designwithalex/foundry-registry/main/foundry-registry.json
```

```json
{
  "schema": 2,
  "version": "2026-09-06T12:00:00.000Z",
  "generatedAt": "2026-09-06T12:00:00.000Z",
  "sources": [
    { "name": "Foundry Components", "componentCount": 1200,
      "componentSetCount": 180, "privateCount": 240 }
  ],
  "componentKeys": ["..."],
  "componentSetKeys": ["..."],
  "styleKeys": ["..."],
  "privatePrefixes": [".", "_"]
}
```

Sólo contiene component keys, que son identificadores opacos. No expone los
IDs de los archivos de Figma ni nada del contenido de los diseños.

## Por qué existe

Los endpoints `/v1/files/:key/components` y `/component_sets` de la REST API
de Figma devuelven **sólo lo publicado en la librería**. Un componente con
prefijo `.` o `_` es privado por convención y nunca se publica, así que su
key no aparece por ahí.

El generador lee además `/v1/files/:key`, el documento completo, cuyos mapas
`components` y `componentSets` incluyen los privados. Sin eso, el plugin
marca como legacy piezas internas que sí son del sistema.

## Cómo se actualiza

Automático, todos los lunes, vía GitHub Actions. Necesita dos secrets:

| Secret | Contenido |
|---|---|
| `FIGMA_TOKEN` | Personal Access Token de Figma con lectura sobre los archivos de Foundry. |
| `FOUNDRY_FILES` | JSON con la lista de archivos: `[{"fileKey":"...","name":"Foundry Components"}]` |

Los IDs de los archivos de Figma van en un secret y no en el repo, porque
este repo es público y un fileKey permite abrir el archivo si alguna vez
quedó compartido por link.

El workflow aborta si el registro resultante tiene menos de mil keys, para
que un token vencido no publique un registro vacío que haría que el plugin
marcara todo como legacy.

A mano:

```bash
FIGMA_TOKEN=figd_xxx node scripts/build-registry.mjs \
  --out foundry-registry.json --no-bundle --redact-sources
```

Si el script avisa que algunos componentes volvieron con key vacía, la REST
API no está exponiendo esas keys. En ese caso hay que exportar el registro
desde el propio plugin, cuya API sí ve la key de todo componente publicado o
no, y fusionarlo:

```bash
node scripts/build-registry.mjs --merge export-del-plugin.json \
  --out foundry-registry.json --no-bundle --redact-sources
```

## Consumir el registro desde otro plugin

Es un JSON estático sin autenticación. Cualquier herramienta puede usarlo:

```js
const res = await fetch('https://raw.githubusercontent.com/Designwithalex/foundry-registry/main/foundry-registry.json');
const registry = await res.json();
const keys = new Set([...registry.componentKeys, ...registry.componentSetKeys]);
keys.has(instance.mainComponent.key); // ¿es de Foundry?
```

Conviene cachear el resultado y tener un fallback embebido, porque
`raw.githubusercontent.com` tiene rate limits por IP.
