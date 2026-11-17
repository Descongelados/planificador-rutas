# Planificador de Rutas Óptimas Multi-Destino

Aplicación web (HTML, CSS y JavaScript puro) instalable en Android como PWA. Hace lo siguiente:

1. Valida todas las direcciones con **Nominatim** (OpenStreetMap) y avisa de las que no encuentra.
2. Calcula el orden más eficiente de toda la ruta con **OSRM Trip**.
3. Divide la ruta en **zonas de 10 destinos**, cada una con su enlace de **Google Maps**. Cada zona sale de la última parada de la anterior.

## Instalar en Android

1. Abre la URL de la app en **Chrome** en el teléfono. Con GitHub Pages es `https://<usuario>.github.io/planificador-rutas/`.
2. Pulsa **Instalar app en este teléfono**. Si el botón no aparece, abre el menú de Chrome (⋮) y elige **Instalar aplicación** o **Añadir a pantalla de inicio**.
3. Se crea un icono "Rutas" y la app abre a pantalla completa, como una app normal.

Los enlaces "Abrir zona N en Google Maps" abren la app de Google Maps del teléfono.
Hace falta conexión a internet para validar direcciones y calcular la ruta. Sin conexión solo carga la pantalla de la app.

## Publicar (GitHub Pages)

El flujo `.github/workflows/deploy.yml` compila y publica en cada push a `main`.
Solo hay que activarlo una vez: **Settings → Pages → Source: GitHub Actions**.

## Desarrollo

```
npm install
npm run dev      # desarrollo
npm run build    # genera dist/ para publicar
```

Los iconos se generan con `node scripts/make-icons.mjs` (salida en `public/icons/`).

## Notas

- Nominatim limita a 1 petición/segundo: la app espera ~1,1 s entre direcciones nuevas. Las ya buscadas se guardan en el navegador y no se vuelven a consultar.
- El servidor público de OSRM (`router.project-osrm.org`) es de demostración y acepta como máximo 100 puntos por ruta (partida + 99 destinos). Para uso intensivo, despliega tu propia instancia y cambia `OSRM_TRIP_URL` en `app.js`.
- Si Nominatim solo encuentra la calle y no el número, la ubicación es aproximada. La app lo avisa; Google Maps sí usa la dirección completa que escribiste.
- Puedes escribir coordenadas `lat, lon` directamente como punto de partida o destino.
