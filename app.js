"use strict";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_TRIP_URL = "https://router.project-osrm.org/trip/v1/driving/";
const NOMINATIM_DELAY_MS = 1100; // política de uso: máx. 1 petición por segundo
const SEARCH_RADIUS_DEG = 0.5;   // radio de búsqueda de destinos alrededor del origen (~55 km)
const MAX_STOPS_PER_LINK = 10;   // Google Maps: origen + 8 paradas + destino
const MAX_OSRM_POINTS = 100;     // el servidor público de OSRM rechaza más de 100 coordenadas
const CACHE_KEY = "planificador-geocache-v1";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

// --- Almacenamiento local (caché de geocodificación y borrador del formulario) ---

const cache = (() => {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
})();
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* sin almacenamiento */ }
}
function saveDraft() {
  try {
    localStorage.setItem("planificador-start", $("start").value);
    localStorage.setItem("planificador-dests", $("destinations").value);
  } catch { /* sin almacenamiento */ }
}
function loadDraft() {
  try {
    $("start").value = localStorage.getItem("planificador-start") ?? "";
    $("destinations").value = localStorage.getItem("planificador-dests") ?? "";
  } catch { /* sin almacenamiento */ }
}

// --- Geocodificación (Nominatim) ---

// Acepta "lat,lon" directamente (p. ej. de la geolocalización) sin consultar Nominatim.
function parseCoords(text) {
  const m = text.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

function cacheKey(query, near) {
  const zone = near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : "";
  return `${query.trim().toLowerCase()}|${zone}`;
}

let lastRequest = 0;
async function search(query, near) {
  // Respeta el límite de 1 petición/segundo sin esperar cuando la respuesta viene de la caché.
  const wait = lastRequest + NOMINATIM_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();

  let url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
  if (near) {
    // Restringe la búsqueda a ~55 km alrededor del punto de partida.
    const d = SEARCH_RADIUS_DEG;
    url += `&viewbox=${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}&bounded=1`;
  }
  const res = await fetch(url, { headers: { "Accept-Language": "es" } });
  if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
  return (await res.json())[0];
}

// `near`: punto de partida; si se indica, los destinos se buscan cerca de él.
async function geocode(query, near) {
  const label = query.trim();
  const direct = parseCoords(query);
  if (direct) return { ...direct, label };

  const key = cacheKey(query, near);
  if (cache[key]) return { ...cache[key], label };

  let hit = await search(query, near);
  if (!hit && near) {
    // Reintento sin números (calle/CP), por si OSM no tiene ese número exacto.
    const simplified = query.replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").replace(/\s+,/g, ",").replace(/[,\s]+$/, "");
    if (simplified && simplified !== label) hit = await search(simplified, near);
  }
  if (!hit) {
    throw new Error(near ? "no encontrada cerca del punto de partida (agrega colonia o municipio)" : "no encontrada");
  }
  const point = { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), found: hit.display_name };
  cache[key] = point;
  saveCache();
  return { ...point, label };
}

function formatEta(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  return `${Math.round(sec / 60)} min`;
}

// El punto de partida es obligatorio (si falla, se lanza el error).
// Los destinos que no se encuentran se omiten y se devuelven en `failed`.
async function geocodeAll(start, dests) {
  const origin = await geocode(start, null);
  const points = [origin];
  const failed = [];

  // Estimación de tiempo: solo las direcciones que no están en caché hacen petición.
  const pending = dests.map((d) => !parseCoords(d) && !cache[cacheKey(d, origin)]);

  for (let i = 0; i < dests.length; i++) {
    const remaining = pending.slice(i).filter(Boolean).length * (NOMINATIM_DELAY_MS / 1000);
    setStatus(
      `Geocodificando ${i + 1} de ${dests.length}` + (remaining ? ` · quedan ~${formatEta(remaining)}` : "") + "…"
    );
    try {
      points.push(await geocode(dests[i], origin));
    } catch (err) {
      failed.push({ query: dests[i], reason: err.message });
    }
  }
  return { points, failed };
}

// --- Optimización (OSRM) ---

// Devuelve los puntos reordenados (el primero siempre es el punto de partida).
async function optimize(points, roundtrip) {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const params = `?source=first&roundtrip=${roundtrip}${roundtrip ? "" : "&destination=any"}&overview=false`;
  const res = await fetch(OSRM_TRIP_URL + coords + params);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== "Ok") {
    throw new Error(`OSRM no pudo calcular la ruta${data.message ? ": " + data.message : ""}`);
  }
  const ordered = points
    .map((p, i) => ({ p, pos: data.waypoints[i].waypoint_index }))
    .sort((a, b) => a.pos - b.pos)
    .map((x) => x.p);
  const trip = data.trips[0];
  return { ordered, distance: trip.distance, duration: trip.duration };
}

// --- Enlaces de Google Maps ---

// Cada tramo empieza en la última parada del anterior. `from`/`to` son números de parada (1 = partida).
function mapsLinks(ordered, roundtrip) {
  const seq = roundtrip ? [...ordered, ordered[0]] : ordered;
  // Google geocodifica mejor los números de calle que Nominatim, así que se le pasa el texto
  // original; solo se usan coordenadas si el usuario las escribió directamente.
  const fmt = (p) => (parseCoords(p.label) ? `${p.lat},${p.lon}` : p.label.replace(/\|/g, " "));
  const links = [];
  for (let i = 0; i < seq.length - 1; i += MAX_STOPS_PER_LINK - 1) {
    const chunk = seq.slice(i, i + MAX_STOPS_PER_LINK);
    if (chunk.length < 2) break;
    const params = new URLSearchParams({
      api: "1",
      travelmode: "driving",
      origin: fmt(chunk[0]),
      destination: fmt(chunk[chunk.length - 1]),
    });
    const middle = chunk.slice(1, -1).map(fmt).join("|");
    if (middle) params.set("waypoints", middle);
    links.push({
      href: `https://www.google.com/maps/dir/?${params}`,
      from: i + 1,
      to: i + chunk.length,
    });
  }
  return links;
}

// --- Interfaz ---

function formatDuration(sec) {
  const min = Math.round(sec / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

function renderWarnings({ failed = [], dupes = 0 }) {
  const box = $("warnings");
  const nodes = [];
  if (failed.length) {
    const p = document.createElement("p");
    p.textContent = `No se pudieron ubicar ${failed.length} dirección(es); no están incluidas en la ruta:`;
    const ul = document.createElement("ul");
    for (const f of failed) {
      const li = document.createElement("li");
      li.textContent = `${f.query} — ${f.reason}`;
      ul.append(li);
    }
    nodes.push(p, ul);
  }
  if (dupes) {
    const p = document.createElement("p");
    p.textContent = `${dupes} dirección(es) repetida(s) se contaron una sola vez.`;
    nodes.push(p);
  }
  box.replaceChildren(...nodes);
  box.classList.toggle("hidden", nodes.length === 0);
}

function render({ ordered, distance, duration }, roundtrip, notes = {}) {
  $("summary").textContent =
    `${ordered.length - 1} destinos · ${(distance / 1000).toFixed(1)} km · ` +
    `${formatDuration(duration)} aprox. (sin tráfico)`;
  renderWarnings(notes);

  const list = $("stops");
  list.replaceChildren(
    ...ordered.map((p) => {
      const li = document.createElement("li");
      const text = document.createElement("div");
      text.textContent = p.label;
      li.append(text);
      if (p.found) {
        const small = document.createElement("small");
        small.className = "found";
        small.textContent = p.found;
        text.append(small);
      }
      return li;
    })
  );
  if (roundtrip) {
    const li = document.createElement("li");
    li.textContent = `${ordered[0].label} (regreso)`;
    list.append(li);
  }

  const links = mapsLinks(ordered, roundtrip);
  $("links").replaceChildren(
    ...links.map(({ href, from, to }, i) => {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent =
        links.length > 1
          ? `Tramo ${i + 1} de ${links.length} · paradas ${from}–${to}`
          : "Iniciar navegación en Google Maps";
      return a;
    })
  );
  $("result").classList.remove("hidden");
}

async function plan() {
  const start = $("start").value.trim();
  const lines = $("destinations").value.split("\n").map((s) => s.trim()).filter(Boolean);
  // Una dirección repetida se visita una sola vez.
  const dests = [...new Map(lines.map((s) => [s.toLowerCase(), s])).values()];
  const dupes = lines.length - dests.length;
  const roundtrip = $("roundtrip").checked;

  if (!start) return setStatus("Ingresa un punto de partida.", true);
  if (!dests.length) return setStatus("Ingresa al menos un destino.", true);
  if (dests.length + 1 > MAX_OSRM_POINTS) {
    return setStatus(
      `El servidor de rutas admite hasta ${MAX_OSRM_POINTS - 1} destinos por ruta y tienes ${dests.length}. ` +
        "Divide la lista en dos rutas (por zona o por repartidor).",
      true
    );
  }

  const btn = $("plan");
  btn.disabled = true;
  $("result").classList.add("hidden");
  try {
    const { points, failed } = await geocodeAll(start, dests);
    if (points.length === 1) {
      throw new Error("No se pudo ubicar ninguno de los destinos. Revisa que incluyan colonia o municipio.");
    }
    const notes = { failed, dupes };
    if (points.length === 2 && !roundtrip) {
      setStatus("");
      render({ ordered: points, distance: 0, duration: 0 }, false, notes);
      $("summary").textContent = "1 destino";
      return;
    }
    setStatus("Calculando la ruta óptima…");
    const result = await optimize(points, roundtrip);
    setStatus("");
    render(result, roundtrip, notes);
  } catch (err) {
    setStatus(err.message || "Ocurrió un error inesperado.", true);
  } finally {
    btn.disabled = false;
  }
}

function useMyLocation() {
  if (!navigator.geolocation) return setStatus("Geolocalización no disponible.", true);
  setStatus("Obteniendo ubicación…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("start").value = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
      saveDraft();
      setStatus("");
    },
    () => setStatus("No se pudo obtener tu ubicación.", true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

loadDraft();
$("start").addEventListener("input", saveDraft);
$("destinations").addEventListener("input", saveDraft);
$("plan").addEventListener("click", plan);
$("locate").addEventListener("click", useMyLocation);
