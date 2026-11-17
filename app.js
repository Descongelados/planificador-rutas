"use strict";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_TRIP_URL = "https://router.project-osrm.org/trip/v1/driving/";
const NOMINATIM_DELAY_MS = 1100; // política de uso: máx. 1 petición por segundo
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

async function geocode(query) {
  const direct = parseCoords(query);
  if (direct) return { ...direct, label: query.trim() };

  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "Accept-Language": "es" } });
  if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error(`No se encontró la dirección: "${query}"`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: query.trim() };
}

async function geocodeAll(queries) {
  const points = [];
  for (let i = 0; i < queries.length; i++) {
    setStatus(`Geocodificando ${i + 1} de ${queries.length}…`);
    const isCoord = parseCoords(queries[i]) !== null;
    points.push(await geocode(queries[i]));
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
      li.textContent = p.label;
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
