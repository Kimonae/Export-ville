
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

let map;
let cityLayer;
let extractedData = null;

document.addEventListener("DOMContentLoaded", () => {
  map = L.map("map").setView([45.548, 2.31], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 20
  }).addTo(map);

  cityLayer = L.featureGroup().addTo(map);

  document.getElementById("btn-search").onclick = searchCity;
const exportOptions = document.getElementById("export-options");

document.getElementById("btn-export").onclick = () => {
  exportOptions.hidden = !exportOptions.hidden;
  updateExportPreview();
};

document.querySelectorAll(
  '#export-options input, #export-options select'
).forEach(input => {
  input.addEventListener("change", updateExportPreview);
});

document.getElementById("btn-generate-export")
  .addEventListener("click", generateExport);
});

// Coordonnées


const EARTH_RADIUS = 6371008.8;

function distanceGPS(a, b) {
  const rad = degrees => degrees * Math.PI / 180;

  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS *
    Math.asin(Math.sqrt(Math.min(1, h)));
}

// Projection locale en mètres.
// Adaptée aux mesures locales, pas aux grandes distances.
function toLocalMeters(point, origin) {
  const rad = Math.PI / 180;
  const lat0 = origin.lat * rad;

  return {
    x: EARTH_RADIUS *
      (point.lon - origin.lon) * rad * Math.cos(lat0),
    y: EARTH_RADIUS *
      (point.lat - origin.lat) * rad
  };
}

function calculatePolygon(points, origin) {
  if (points.length < 3) {
    return { area: null, perimeter: null, edges: [] };
  }

  const edges = [];
  let perimeter = 0;
  let twiceArea = 0;

  const local = points.map(p => toLocalMeters(p, origin));

  for (let i = 0; i < points.length; i++) {
    const next = (i + 1) % points.length;

    const length = distanceGPS(points[i], points[next]);

    edges.push({
      de: i + 1,
      vers: next + 1,
      longueur_m: round(length, 2)
    });

    perimeter += length;

    twiceArea +=
      local[i].x * local[next].y -
      local[next].x * local[i].y;
  }

  return {
    area: round(Math.abs(twiceArea) / 2, 2),
    perimeter: round(perimeter, 2),
    edges
  };
}

function calculateCentroid(points, origin) {
  if (!points.length) return null;

  const local = points.map(p => toLocalMeters(p, origin));

  // Centroïde surfacique pour un polygone.
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < local.length; i++) {
    const a = local[i];
    const b = local[(i + 1) % local.length];
    const cross = a.x * b.y - b.x * a.y;

    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }

  if (Math.abs(twiceArea) < 1e-8) {
    return {
      lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
      lon: points.reduce((s, p) => s + p.lon, 0) / points.length
    };
  }

  cx /= 3 * twiceArea;
  cy /= 3 * twiceArea;

  const rad = 180 / Math.PI;

  return {
    lat: origin.lat + (cy / EARTH_RADIUS) * rad,
    lon: origin.lon +
      (cx / (EARTH_RADIUS * Math.cos(origin.lat * Math.PI / 180))) * rad
  };
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

// Sélection ville


async function searchCity() {
  const input = document.getElementById("city");
  const name = input.value.trim();

  if (!name) {
    alert("Entre le nom d'une ville.");
    return;
  }

  const button = document.getElementById("btn-search");
  button.disabled = true;

  try {
    setStatus("Recherche de la ville...");

    const url = new URL(
      "https://nominatim.openstreetmap.org/search"
    );

    url.search = new URLSearchParams({
      q: name,
      format: "jsonv2",
      countrycodes: "fr",
      limit: "5",
      addressdetails: "1"
    });

    const response = await fetch(url);

    if (!response.ok) throw new Error("Recherche géographique impossible.");

    const results = await response.json();

    // On privilégie une relation administrative.
    const city = results.find(item =>
      item.osm_type === "relation" &&
      item.class === "boundary" &&
      item.type === "administrative"
    ) || results.find(item => item.osm_type === "relation");

    if (!city) {
      throw new Error(
        "Limite administrative introuvable. Essaie avec le nom complet."
      );
    }

    const bounds = city.boundingbox.map(Number);

    map.fitBounds([
      [bounds[0], bounds[2]],
      [bounds[1], bounds[3]]
    ]);

    setStatus("Téléchargement des bâtiments et des routes...");

    const osmId = Number(city.osm_id);

    // Identifiant de zone dérivé d'une relation OSM.
    const areaId = 3600000000 + osmId;

    const query = `
      [out:json][timeout:120];
      area(${areaId})->.zone;
      (
        way["building"](area.zone);
        way["highway"](area.zone);
      );
      out body;
      >;
      out skel qt;
    `;

    const osmResponse = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: new URLSearchParams({ data: query })
    });
    if (!osmResponse.ok) {
      const details = await osmResponse.text();

      console.error("Erreur Overpass :", {
        status: osmResponse.status,
        statusText: osmResponse.statusText,
        details: details.slice(0, 2000)
      });

      throw new Error(
        `Overpass HTTP ${osmResponse.status} : ` +
        (details.slice(0, 250) || osmResponse.statusText)
      );
    }

    const osm = await osmResponse.json();

    extractedData = processOSM(osm, {
      name: city.display_name,
      osmId,
      bounds
    });

    renderData(extractedData);

    document.getElementById("btn-export").disabled = false;

    setStatus(
      `${extractedData.batiments.length} bâtiments et ` +
      `${extractedData.routes.length} routes récupérés.`
    );
  } catch (error) {
    console.error(error);
    setStatus(error.message);
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

// TRANSFORMATION OSM -> JSON GÉOMÉTRIQUE


function processOSM(osm, city) {
  const nodes = new Map();
  const ways = [];

  for (const element of osm.elements) {
    if (element.type === "node") {
      nodes.set(element.id, {
        lat: element.lat,
        lon: element.lon
      });
    }

    if (element.type === "way") {
      ways.push(element);
    }
  }

  const nodeCoords = way =>
    (way.nodes || [])
      .map(id => nodes.get(id))
      .filter(Boolean);

  const buildingWays = ways.filter(
    way => way.tags?.building
  );

  const roadWays = ways.filter(
    way => way.tags?.highway && !way.tags?.building
  );

  // Origine commune pour les coordonnées locales.
  const origin = {
    lat: (city.bounds[0] + city.bounds[1]) / 2,
    lon: (city.bounds[2] + city.bounds[3]) / 2
  };

  const buildings = buildingWays.map(way => {
    let points = nodeCoords(way);

    // Les bâtiments fermés sont représentés sans
    // répéter le premier sommet à la fin.
    if (
      points.length > 1 &&
      points[0].lat === points.at(-1).lat &&
      points[0].lon === points.at(-1).lon
    ) {
      points = points.slice(0, -1);
    }

    const geometry = calculatePolygon(points, origin);
    const center = calculateCentroid(points, origin);

    return {
      id: `building_${way.id}`,
      osm_id: way.id,
      type: way.tags.building,
      nom: way.tags.name || null,
      niveaux: numberOrNull(way.tags["building:levels"]),
      hauteur_m: numberOrNull(way.tags.height),
      centre_gps: center,
      sommets: points.map((p, i) => ({
        id: i + 1,
        lat: p.lat,
        lon: p.lon,
        x_m: round(toLocalMeters(p, origin).x),
        y_m: round(toLocalMeters(p, origin).y)
      })),
      aretes: geometry.edges,
      perimetre_m: geometry.perimeter,
      surface_m2: geometry.area,
      tags: way.tags
    };
  });

  const roads = roadWays.map(way => {
    const points = nodeCoords(way);

    let length = 0;
    for (let i = 1; i < points.length; i++) {
      length += distanceGPS(points[i - 1], points[i]);
    }

    return {
      id: `road_${way.id}`,
      osm_id: way.id,
      nom: way.tags.name || null,
      type: way.tags.highway,
      trace_gps: points.map(p => ({
        lat: p.lat,
        lon: p.lon,
        x_m: round(toLocalMeters(p, origin).x),
        y_m: round(toLocalMeters(p, origin).y)
      })),
      longueur_m: round(length, 2),
      largeur_m: numberOrNull(way.tags.width),
      tags: way.tags
    };
  });

  // Distances entre contours des bâtiments.
  // On ne conserve que les paires proches.
  const relations = [];

  for (let i = 0; i < buildings.length; i++) {
    for (let j = i + 1; j < buildings.length; j++) {
      const a = buildings[i];
      const b = buildings[j];

      const centerDistance = distanceGPS(
        a.centre_gps,
        b.centre_gps
      );

      if (centerDistance > 100) continue;

      let minimum = Infinity;

      for (const pa of a.sommets) {
        for (const pb of b.sommets) {
          minimum = Math.min(
            minimum,
            distanceGPS(pa, pb)
          );
        }
      }

      relations.push({
        source: a.id,
        cible: b.id,
        distance_minimale_entre_sommets_m: round(minimum),
        distance_centres_m: round(centerDistance)
      });
    }
  }

  return {
    schema_version: "1.0.0",
    source: "OpenStreetMap",
    attribution: "© OpenStreetMap contributors",
    date_extraction: new Date().toISOString(),

    ville: {
      nom: city.name,
      osm_id: city.osmId,
      origine_locale_gps: [origin.lat, origin.lon],
      unite_locale: "metre",
      projection_locale: "ENU approximative",
      limites_bbox: city.bounds
    },

    batiments: buildings,
    routes: roads,
    relations_batiments: relations
  };
}

function numberOrNull(value) {
  if (value == null || value === "") return null;

  const match = String(value).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}


// AFFICHAGE


function renderData(data) {
  cityLayer.clearLayers();

  for (const building of data.batiments) {
    const points = building.sommets.map(p => [p.lat, p.lon]);

    if (points.length < 3) continue;

    const polygon = L.polygon(points, {
      color: "#e69b35",
      weight: 1,
      fillColor: "#f5c26b",
      fillOpacity: 0.45
    });

    polygon.bindPopup(
      `<b>${escapeHTML(building.id)}</b><br>` +
      `Type : ${escapeHTML(building.type || "inconnu")}<br>` +
      `Surface : ${building.surface_m2 ?? "inconnue"} m²<br>` +
      `Périmètre : ${building.perimetre_m ?? "inconnu"} m`
    );

    cityLayer.addLayer(polygon);
  }

  for (const road of data.routes) {
    if (road.trace_gps.length < 2) continue;

    L.polyline(
      road.trace_gps.map(p => [p.lat, p.lon]),
      { color: "#4784db", weight: 2, opacity: 0.8 }
    ).addTo(cityLayer);
  }

  if (cityLayer.getLayers().length) {
    map.fitBounds(cityLayer.getBounds(), { padding: [20, 20] });
  }

  document.getElementById("stats").textContent =
    `${data.batiments.length} bâtiments | ` +
    `${data.routes.length} routes | ` +
    `${data.relations_batiments.length} relations proches`;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function setStatus(message) {
  document.getElementById("status").textContent = message;
}


// GESTIONNAIRE D'EXPORT


function getExportSelection() {
  return {
    categories: [
      ...document.querySelectorAll(
        'input[name="export-category"]:checked'
      )
    ].map(input => input.value),

    profile: document.getElementById("export-profile").value,

    split: document.getElementById("export-split").checked,

    materials: document.getElementById("export-materials").checked
  };
}

function getExportFiles() {
  if (!extractedData) return [];

  const options = getExportSelection();
  const files = [];

  const datasets = {
    batiments: extractedData.batiments,
    routes: extractedData.routes,
    relations: extractedData.relations_batiments,
    metadata: {
      schema_version: extractedData.schema_version,
      source: extractedData.source,
      attribution: extractedData.attribution,
      date_extraction: extractedData.date_extraction,
      ville: extractedData.ville,
      statistiques: {
        batiments: extractedData.batiments.length,
        routes: extractedData.routes.length,
        relations: extractedData.relations_batiments.length
      }
    }
  };

  for (const category of options.categories) {
    const data = datasets[category];

    if (data === undefined) continue;

    // Les métadonnées ne sont pas découpées.
    if (category === "metadata" || !options.split) {
      files.push({
        path: `${category}.json`,
        data: {
          schema_version: "1.0.0",
          profil_export: options.profile,
          categorie: category,
          donnees: data
        }
      });

      continue;
    }

    const sectors = new Map();

    for (const item of data) {
      const point = getItemLocalPosition(category, item);

      if (!point) continue;

      const sx = Math.floor(point.x / 500);
      const sy = Math.floor(point.y / 500);
      const key = `${sx}_${sy}`;

      if (!sectors.has(key)) sectors.set(key, []);

      sectors.get(key).push(item);
    }

    for (const [sector, items] of sectors) {
      files.push({
        path: `${category}/secteur_${sector}.json`,
        data: {
          schema_version: "1.0.0",
          profil_export: options.profile,
          categorie: category,
          secteur: sector,
          taille_secteur_m: 500,
          donnees: items
        }
      });
    }
  }

  if (options.materials) {
    files.push({
      path: "materials.json",
      data: {
        schema_version: "1.0.0",
        presets: {
          wall_default: {
            material: "plaster",
            color: "#C8BBA5"
          },
          roof_default: {
            material: "roof_tiles",
            color: "#805347"
          },
          window_default: {
            material: "glass",
            color: "#7899A8"
          }
        }
      }
    });
  }

  return files;
}

// Position locale représentative d'un objet.
function getItemLocalPosition(category, item) {
  let points = [];

  if (category === "batiments") {
    points = item.sommets || [];
  } else if (category === "routes") {
    points = item.trace_gps || [];
  } else {
    return null;
  }

  if (!points.length) return null;

  const valid = points.filter(
    p => Number.isFinite(p.x_m) && Number.isFinite(p.y_m)
  );

  if (!valid.length) return null;

  return {
    x: valid.reduce((sum, p) => sum + p.x_m, 0) / valid.length,
    y: valid.reduce((sum, p) => sum + p.y_m, 0) / valid.length
  };
}

function updateExportPreview() {
  const preview = document.getElementById("export-preview");

  if (!extractedData) {
    preview.textContent = "Aucune ville extraite.";
    return;
  }

  const files = getExportFiles();

  const size = new Blob(
    files.map(file => JSON.stringify(file.data))
  ).size;

  const formatSize = bytes =>
    bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} Ko`
      : `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;

  preview.textContent =
    `${files.length} fichier(s) prévu(s) · ` +
    `Environ ${formatSize(size)} avant compression · ` +
    `${files.length > 1 ? "Archive ZIP" : "JSON individuel"}`;
}

async function generateExport() {
  if (!extractedData) {
    alert("Aucune donnée à exporter.");
    return;
  }

  const files = getExportFiles();

  if (!files.length) {
    alert("Sélectionne au moins une catégorie.");
    return;
  }

  const button = document.getElementById("btn-generate-export");
  button.disabled = true;
  button.textContent = "Préparation de l'export...";

  try {
    const cityName = sanitizeFilename(
      extractedData.ville.nom.split(",")[0]
    );

    // Un seul fichier : téléchargement direct.
    if (files.length === 1) {
      const file = files[0];

      downloadBlob(
        new Blob(
          [JSON.stringify(file.data, null, 2)],
          { type: "application/json;charset=utf-8" }
        ),
        `${cityName}_${file.path.split("/").pop()}`
      );

      return;
    }

    // Plusieurs fichiers : création d'un ZIP.
    if (typeof JSZip === "undefined") {
      throw new Error(
        "JSZip n'est pas chargé. Vérifie son script dans index.html."
      );
    }

    const zip = new JSZip();

    zip.file("manifest.json", JSON.stringify({
      schema_version: "1.0.0",
      ville: extractedData.ville,
      profil_export: getExportSelection().profile,
      date_export: new Date().toISOString(),
      nombre_fichiers: files.length,
      fichiers: files.map(file => file.path)
    }, null, 2));

    for (const file of files) {
      zip.file(file.path, JSON.stringify(file.data, null, 2));
    }
    button.textContent = "Compression du ZIP...";

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });

    downloadBlob(blob, `${cityName}_export.zip`);

  } catch (error) {
    console.error(error);
    alert(`Erreur pendant l'export : ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Générer et télécharger";
    updateExportPreview();
  }
}

function sanitizeFilename(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "") || "ville";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
