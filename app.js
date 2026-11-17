"use strict";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_TRIP_URL = "https://router.project-osrm.org/trip/v1/driving/";
const NOMINATIM_DELAY_MS = 1100; // política de uso: máx. 1 petición por segundo
const SEARCH_RADIUS_DEG = 0.5;   // radio de búsqueda de destinos alrededor del origen (~55 km)
const MAX_STOPS_PER_LINK = 10;   // Google Maps: origen + 8 paradas + destino

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

// Acepta "lat,lon" directamente (p. ej. de la geolocalización) sin consultar Nominatim.
function parseCoords(text) {
  const m = text.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

async function search(query, near) {
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
  const direct = parseCoords(query);
  if (direct) return { ...direct, label: query.trim() };

  let hit = await search(query, near);
  if (!hit && near) {
    // Reintento sin números (calle/CP), por si OSM no tiene ese número exacto.
    const simplified = query.replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").replace(/\s+,/g, ",").replace(/[,\s]+$/, "");
    if (simplified && simplified !== query.trim()) {
      await sleep(NOMINATIM_DELAY_MS);
      hit = await search(simplified, near);
    }
  }
  if (!hit) {
    throw new Error(
      `No se encontró "${query.trim()}"` + (near ? " cerca del punto de partida. Agrega colonia o municipio." : ".")
    );
  }
  return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), label: query.trim(), found: hit.display_name };
}

async function geocodeAll(queries) {
  const points = [];
  for (let i = 0; i < queries.length; i++) {
    setStatus(`Geocodificando ${i + 1} de ${queries.length}…`);
    const isCoord = parseCoords(queries[i]) !== null;
    points.push(await geocode(queries[i], i === 0 ? null : points[0]));
    if (!isCoord && i < queries.length - 1) await sleep(NOMINATIM_DELAY_MS);
  }
  return points;
}

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

function mapsLinks(ordered, roundtrip) {
  const seq = roundtrip ? [...ordered, ordered[0]] : ordered;
  const fmt = (p) => `${p.lat},${p.lon}`;
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
    links.push(`https://www.google.com/maps/dir/?${params}`);
  }
  return links;
}

function formatDuration(sec) {
  const min = Math.round(sec / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

function render({ ordered, distance, duration }, roundtrip) {
  $("summary").textContent =
    `${ordered.length - 1} destinos · ${(distance / 1000).toFixed(1)} km · ` +
    `${formatDuration(duration)} aprox. (sin tráfico)`;

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
    ...links.map((href, i) => {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = links.length > 1 ? `Navegar tramo ${i + 1} de ${links.length}` : "Iniciar navegación en Google Maps";
      return a;
    })
  );
  $("result").classList.remove("hidden");
}

async function plan() {
  const start = $("start").value.trim();
  const dests = $("destinations").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const roundtrip = $("roundtrip").checked;

  if (!start) return setStatus("Ingresa un punto de partida.", true);
  if (!dests.length) return setStatus("Ingresa al menos un destino.", true);

  const btn = $("plan");
  btn.disabled = true;
  $("result").classList.add("hidden");
  try {
    const points = await geocodeAll([start, ...dests]);
    if (points.length === 2 && !roundtrip) {
      setStatus("");
      render({ ordered: points, distance: 0, duration: 0 }, false);
      $("summary").textContent = "1 destino";
      return;
    }
    setStatus("Calculando la ruta óptima…");
    const result = await optimize(points, roundtrip);
    setStatus("");
    render(result, roundtrip);
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
      setStatus("");
    },
    () => setStatus("No se pudo obtener tu ubicación.", true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

$("plan").addEventListener("click", plan);
$("locate").addEventListener("click", useMyLocation);
