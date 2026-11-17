# Planificador de Rutas Óptimas Multi-Destino

Aplicación web estática (HTML, CSS y JavaScript puro) que:

1. Geocodifica direcciones con **Nominatim** (OpenStreetMap).
2. Calcula el orden más rápido con el servicio **OSRM Trip** (problema del viajante).
3. Genera enlaces de **Google Maps** con todas las paradas ordenadas.

## Uso

```
npm install
npm run dev      # desarrollo
npm run build    # genera dist/ para publicar
```

También sirve cualquier servidor estático (p. ej. `python -m http.server`); no se puede abrir con doble clic (`file://`) porque el script es un módulo ES.
Para usar el botón de ubicación en el móvil se requiere HTTPS (o `localhost`).

## Notas

- Nominatim limita a 1 petición/segundo: la app espera ~1,1 s entre direcciones.
- El servidor público de OSRM (`router.project-osrm.org`) es de demostración; para uso intensivo, despliega tu propia instancia y cambia `OSRM_TRIP_URL` en `app.js`.
- Google Maps admite ~10 puntos por enlace; si hay más, se generan varios tramos consecutivos.
- Sin ubicación: puedes escribir coordenadas `lat, lon` directamente como punto de partida o destino.
