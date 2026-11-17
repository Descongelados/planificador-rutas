"use strict";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_TRIP_URL = "https://router.project-osrm.org/trip/v1/driving/";
const NOMINATIM_DELAY_MS = 1100; // política de uso: máx. 1 petición por segundo
const SEARCH_RADIUS_DEG = 0.5;   // radio de búsqueda de destinos alrededor del origen (~55 km)
const ZONE_SIZE = 10;            // destinos por zona (origen + 9 paradas intermedias + destino por enlace)
const MAX_OSRM_POINTS = 100;     // el servidor público de OSRM rechaza más de 100 coordenadas
const CACHE_KEY = "planificador-geocache-v2";

const PRECISION_LABEL = {
  exacta: "Dirección exacta",
  calle: "Solo calle (sin número)",
  zona: "Zona aproximada",
};

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

// exacta: Nominatim devolvió número de casa; calle: solo la vía; zona: colonia, ciudad u otro.
function precisionOf(hit) {
  if (hit.address?.house_number) return "exacta";
  if (hit.class === "highway") return "calle";
  return "zona";
}

let lastRequest = 0;
async function search(query, near) {
  // Respeta el límite de 1 petición/segundo sin esperar cuando la respuesta viene de la caché.
  const wait = lastRequest + NOMINATIM_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();

  let url = `${NOMINATIM_URL}?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(query)}`;
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
  if (direct) return { ...direct, label, precision: "exacta" };

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
  const point = {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    found: hit.display_name,
    precision: precisionOf(hit),
  };
  cache[key] = point;
  saveCache();
  return { ...point, label };
}

function formatEta(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  return `${Math.round(sec / 60)} min`;
}

// El punto de partida es obligatorio (si falla, se lanza el error).
// Los destinos que no se encuentran se devuelven en `failed`.
async function geocodeAll(start, dests) {
  const origin = await geocode(start, null);
  const points = [origin];
  const failed = [];

  // Estimación de tiempo: solo las direcciones que no están en caché hacen petición.
  const pending = dests.map((d) => !parseCoords(d) && !cache[cacheKey(d, origin)]);

  for (let i = 0; i < dests.length; i++) {
    const remaining = pending.slice(i).filter(Boolean).length * (NOMINATIM_DELAY_MS / 1000);
    setStatus(
      `Validando dirección ${i + 1} de ${dests.length}` + (remaining ? ` · quedan ~${formatEta(remaining)}` : "") + "…"
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

// Devuelve los puntos reordenados (el primero siempre es el punto de partida) y los tramos
// (`legs[i]` va del punto i al i+1 del orden devuelto; con regreso hay un tramo extra al origen).
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
  const legs = trip.legs.map((l) => ({ distance: l.distance, duration: l.duration }));
  return { ordered, legs, distance: trip.distance, duration: trip.duration };
}

// --- Zonas y enlaces de Google Maps ---

// Google geocodifica mejor los números de calle que Nominatim, así que se le pasa el texto
// original; solo se usan coordenadas si el usuario las escribió directamente.
function mapsPlace(p) {
  return parseCoords(p.label) ? `${p.lat},${p.lon}` : p.label.replace(/\|/g, " ");
}

function mapsUrl(origin, stops) {
  const params = new URLSearchParams({
    api: "1",
    travelmode: "driving",
    origin: mapsPlace(origin),
    destination: mapsPlace(stops[stops.length - 1]),
  });
  const middle = stops.slice(0, -1).map(mapsPlace).join("|");
  if (middle) params.set("waypoints", middle);
  return `https://www.google.com/maps/dir/?${params}`;
}

// Divide la ruta ya optimizada en zonas consecutivas de ZONE_SIZE destinos.
// Cada zona sale de la última parada de la anterior, así el conductor no tiene que mover nada.
// Con regreso, el retorno al punto de partida cuenta como una parada más de la última zona.
function buildZones(ordered, legs, roundtrip) {
  const stops = ordered.slice(1);
  if (roundtrip) stops.push({ ...ordered[0], isReturn: true });

  const zones = [];
  for (let i = 0; i < stops.length; i += ZONE_SIZE) {
    const chunk = stops.slice(i, i + ZONE_SIZE);
    const origin = i === 0 ? ordered[0] : stops[i - 1];
    const zoneLegs = legs.slice(i, i + chunk.length);
    zones.push({
      origin,
      stops: chunk,
      first: i + 1,
      distance: zoneLegs.reduce((s, l) => s + l.distance, 0),
      duration: zoneLegs.reduce((s, l) => s + l.duration, 0),
      href: mapsUrl(origin, chunk),
    });
  }
  return zones;
}

// --- Interfaz ---

function formatDuration(sec) {
  const min = Math.round(sec / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderWarnings({ failed = [], dupes = 0, points = [] }) {
  const nodes = [];
  if (failed.length) {
    nodes.push(el("p", `Se omitieron ${failed.length} dirección(es) que no se pudieron ubicar:`));
    const ul = el("ul");
    for (const f of failed) ul.append(el("li", `${f.query} — ${f.reason}`));
    nodes.push(ul);
  }
  const rough = points.slice(1).filter((p) => p.precision !== "exacta");
  if (rough.length) {
    const calle = rough.filter((p) => p.precision === "calle").length;
    const zona = rough.length - calle;
    const parts = [];
    if (calle) parts.push(`${calle} solo por calle`);
    if (zona) parts.push(`${zona} por zona aproximada`);
    nodes.push(
      el(
        "p",
        `Ubicación aproximada en ${rough.length} de ${points.length - 1} direcciones (${parts.join(", ")}). ` +
          "El orden de paradas muy cercanas puede no ser exacto; Google Maps sí usa la dirección completa."
      )
    );
  }
  if (dupes) nodes.push(el("p", `${dupes} dirección(es) repetida(s) se contaron una sola vez.`));

  const box = $("warnings");
  box.replaceChildren(...nodes);
  box.classList.toggle("hidden", nodes.length === 0);
}

function renderZone(zone, index, total, roundtrip) {
  const wrap = el("div", undefined, "zone");
  wrap.append(el("h3", `Zona ${index + 1} de ${total}`));
  wrap.append(
    el(
      "p",
      `${zone.stops.length} parada(s) · ${(zone.distance / 1000).toFixed(1)} km · ${formatDuration(zone.duration)}`,
      "summary"
    )
  );
  wrap.append(el("p", `Sale de: ${zone.origin.label}`, "origin"));

  const list = el("ol", undefined, "stops");
  list.style.counterReset = `stop ${zone.first - 1}`;
  for (const p of zone.stops) {
    const li = el("li");
    const text = el("div", p.isReturn ? `${p.label} (regreso)` : p.label);
    if (p.found) {
      const small = el("small", `${PRECISION_LABEL[p.precision]} · ${p.found}`, "found");
      small.classList.add(`prec-${p.precision}`);
      text.append(small);
    }
    li.append(text);
    list.append(li);
  }
  wrap.append(list);

  const a = el("a", `Abrir zona ${index + 1} en Google Maps`, "maps-link");
  a.href = zone.href;
  a.target = "_blank";
  a.rel = "noopener";
  wrap.append(a);
  return wrap;
}

function render({ ordered, legs, distance, duration }, roundtrip, notes) {
  const zones = buildZones(ordered, legs, roundtrip);
  $("summary").textContent =
    `${ordered.length - 1} destinos · ${zones.length} zona(s) · ${(distance / 1000).toFixed(1)} km · ` +
    `${formatDuration(duration)} aprox. (sin tráfico)`;
  renderWarnings({ ...notes, points: ordered });
  $("zones").replaceChildren(...zones.map((z, i) => renderZone(z, i, zones.length, roundtrip)));
  $("result").classList.remove("hidden");
}

function showValidation({ points, failed }) {
  $("validation-summary").textContent =
    `${points.length - 1} dirección(es) ubicadas y ${failed.length} sin ubicar.`;
  $("validation-failed").replaceChildren(...failed.map((f) => el("li", `${f.query} — ${f.reason}`)));
  $("validation").classList.remove("hidden");
}

function setBusy(busy) {
  $("plan").disabled = busy;
  $("continue").disabled = busy;
}

let pending = null; // resultado de la validación a la espera de confirmar

async function finish({ points, failed, dupes, roundtrip }) {
  setBusy(true);
  $("validation").classList.add("hidden");
  try {
    setStatus("Calculando la ruta más eficiente…");
    const result = await optimize(points, roundtrip);
    setStatus("");
    render(result, roundtrip, { failed, dupes });
  } catch (err) {
    setStatus(err.message || "Ocurrió un error inesperado.", true);
  } finally {
    setBusy(false);
  }
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

  setBusy(true);
  pending = null;
  $("result").classList.add("hidden");
  $("validation").classList.add("hidden");
  try {
    const geo = await geocodeAll(start, dests);
    if (geo.points.length === 1) {
      throw new Error("No se pudo ubicar ninguno de los destinos. Revisa que incluyan colonia o municipio.");
    }
    pending = { ...geo, dupes, roundtrip };
    if (geo.failed.length) {
      // Todas las direcciones deben validarse: con fallos, el usuario decide antes de calcular.
      setStatus("");
      showValidation(geo);
      return;
    }
    setBusy(false);
    await finish(pending);
  } catch (err) {
    setStatus(err.message || "Ocurrió un error inesperado.", true);
  } finally {
    setBusy(false);
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
$("continue").addEventListener("click", () => pending && finish(pending));
$("locate").addEventListener("click", useMyLocation);
