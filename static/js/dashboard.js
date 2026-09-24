/**
 * AGRO VISOR - DASHBOARD LOGIC
 * Manages Leaflet map, NetCDF data visualization, and interactive charts.
 */

// Redundant sidebar logic removed (using app.js)

// --- MAPA ---
let map;
let lightTiles;
let darkTiles;
let capaActual = null;
let marcadorClick = null;
let chartInstancia = null;
let nombreArchivoNetCDF = null;
let datosGlobales = [];

function initMap() {
    map = L.map('map', { zoomControl: false }).setView([-1.8312, -78.1834], 7);
    
    lightTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });
    
    // Usamos ESRI Dark Gray para el modo oscuro, que es gratuito y no tiene marcas de agua
    darkTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ'
    });

    // Init Tile
    const initialTheme = localStorage.getItem('theme') || 'light';
    if (initialTheme === 'dark') darkTiles.addTo(map);
    else lightTiles.addTo(map);

    map.on('click', function (e) {
        const lang = document.documentElement.lang || 'es';
        
        if (!nombreArchivoNetCDF) {
            Swal.fire({
                title: translations[lang]['swal_error_title'] || "Acción Requerida",
                text: translations[lang]['swal_error_text'] || "Por favor, carga un archivo para comenzar.",
                icon: 'info',
                confirmButtonColor: '#004423',
                confirmButtonText: translations[lang]['btn_ready'] || "Entendido",
                background: document.documentElement.classList.contains('dark') ? '#191c1d' : '#fff',
                color: document.documentElement.classList.contains('dark') ? '#fff' : '#000'
            });
            return;
        }

        // Show Toast
        const Toast = Swal.mixin({
            toast: true, position: 'top-end', showConfirmButton: false, timer: 2000, 
            timerProgressBar: true, background: document.documentElement.classList.contains('dark') ? '#191c1d' : '#fff',
            color: document.documentElement.classList.contains('dark') ? '#fff' : '#000'
        });
        Toast.fire({ icon: 'info', title: translations[lang]['toast_searching'] || "Consultando..." });

        if (marcadorClick) map.removeLayer(marcadorClick);
        
        // Define Custom Pulse Icon (Sonar Effect)
        const pulseIcon = L.divIcon({
            className: 'custom-pulse-container',
            html: '<div class="pulse-marker"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });

        marcadorClick = L.marker(e.latlng, { icon: pulseIcon }).addTo(map);
        consultarPunto(e.latlng.lat, e.latlng.lng);
    });
}

function updateMapLayer(isDark) {
    if (!map) return;
    if (isDark) {
        map.removeLayer(lightTiles);
        darkTiles.addTo(map);
    } else {
        map.removeLayer(darkTiles);
        lightTiles.addTo(map);
    }
}

// --- FUNCIONES LOGICAS ---

let capaGeoJSON = null;

function cargarGeoJSON(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (capaGeoJSON) map.removeLayer(capaGeoJSON);
            
            capaGeoJSON = L.geoJSON(data, {
                style: { 
                    color: '#ff5722', // Color distinto (naranja) para diferenciarlo de la máscara verde
                    weight: 3, 
                    fillOpacity: 0.2,
                    dashArray: '5, 5' // Línea punteada
                },
                onEachFeature: function(feature, layer) {
                    if (feature.properties && feature.properties.name) {
                        layer.bindPopup("<b>Zona:</b> " + feature.properties.name);
                    }
                }
            }).addTo(map);
            
            map.fitBounds(capaGeoJSON.getBounds());
            descargarRiosDesdeOverpass(capaGeoJSON.getBounds());
            
            // Agregar al historial visual
            document.getElementById('activeFiles').innerHTML += `
                <div class="bg-white dark:bg-white/5 p-3 rounded-lg flex items-center space-x-2 border border-tertiary/10 dark:border-white/10">
                    <span class="material-symbols-outlined text-tertiary dark:text-tertiary-fixed text-sm" style="font-variation-settings: 'FILL' 1;">public</span>
                    <p class="text-[10px] font-black truncate text-on-surface dark:text-white/80">${file.name}</p>
                </div>
            `;
            
            // Add notification
            if (window.addNotification) {
                window.addNotification("Zona geográfica cargada: " + file.name);
            }
        } catch (error) {
            console.error("Error leyendo GeoJSON:", error);
            alert("El archivo no es un GeoJSON válido.");
        } finally {
            event.target.value = ''; // Reset input so the same file can be selected again
        }
    };
    reader.readAsText(file);
}
function cargarShapefile() {
    var file = document.getElementById('archivoShapefile').files[0];
    if (!file) return;
    document.getElementById('loader').classList.remove('hidden');

    var reader = new FileReader();
    reader.onload = function (e) {
        shp(e.target.result).then(function (geojson) {
            if (capaActual) map.removeLayer(capaActual);
            capaActual = L.geoJSON(geojson, { 
                style: { color: '#004423', weight: 2, fillOpacity: 0.1 } 
            }).addTo(map);
            map.fitBounds(capaActual.getBounds());
            document.getElementById('loader').classList.add('hidden');
            
            // Add notification for mask
            if (window.addNotification) {
                const lang = document.documentElement.lang || 'es';
                const msg = translations[lang]['notif_upload_mask'] || "Máscara geográfica aplicada";
                window.addNotification(msg);
            }
            
            descargarRiosDesdeOverpass(capaActual.getBounds());
        });
    };
    reader.readAsArrayBuffer(file);
}

let riosCapas = {}; // Para guardar las capas de los ríos por nombre
let capaGrupoRios = null; // Grupo unificado para limpiar memoria fácilmente
let canvasRendererRios = null;

let controllerDescargaRios = null;

function descargarRiosDesdeOverpass(bounds) {
    if (!bounds || !bounds.isValid()) return;
    
    // Abortar consulta previa si todavía está corriendo
    if (controllerDescargaRios) {
        try { controllerDescargaRios.abort(); } catch(e) {}
    }
    controllerDescargaRios = new AbortController();
    
    if (window.addNotification) window.addNotification("Buscando ríos principales en la zona...");
    
    // Limpiar capas anteriores para no saturar memoria
    if (capaGrupoRios) {
        map.removeLayer(capaGrupoRios);
    }
    capaGrupoRios = L.layerGroup().addTo(map);
    riosCapas = {};
    
    // Crear renderer Canvas de alto rendimiento (10x más rápido que SVG)
    if (!canvasRendererRios) {
        canvasRendererRios = L.canvas({ padding: 0.5 });
    }
    
    // Mostrar el contenedor del buscador y limpiar la lista
    const contenedorBuscador = document.getElementById('contenedorBuscadorRios');
    if (contenedorBuscador) contenedorBuscador.classList.remove('hidden');
    const select = document.getElementById('buscadorRios');
    if (select) select.innerHTML = '<option value="" disabled selected>Cargando ríos...</option>';
    
    const s = bounds.getSouth().toFixed(4);
    const w = bounds.getWest().toFixed(4);
    const n = bounds.getNorth().toFixed(4);
    const e = bounds.getEast().toFixed(4);
    const bbox = `${s},${w},${n},${e}`;
    
    // MODO TURBO: 'out geom' devuelve las coordenadas directamente en el camino sin descargar nodos separados
    const query = `[out:json][timeout:10];(way["waterway"~"river|stream"][name](${bbox}););out geom;`;
    
    fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: query,
        signal: controllerDescargaRios.signal
    })
    .then(res => {
        if (!res.ok) throw new Error("Servidor ocupado");
        return res.json();
    })
    .then(data => {
        let riosEncontrados = 0;
        let nombresUnicos = new Set();
        
        data.elements.forEach(e => {
            if (e.geometry && e.geometry.length > 1 && e.tags && e.tags.waterway) {
                const latlngs = e.geometry.map(pt => [pt.lat, pt.lon]);
                const nombre = e.tags.name || '';
                const tipo = e.tags.waterway === 'river' ? 'Río' : 'Arroyo';
                
                const polyline = L.polyline(latlngs, { 
                    color: '#0078FF',
                    weight: e.tags.waterway === 'river' ? 2.5 : 1.5,
                    opacity: 0.85,
                    renderer: canvasRendererRios
                }).bindPopup(`<b>Agua:</b> ${nombre || 'Sin nombre'} (${tipo})`);
                
                capaGrupoRios.addLayer(polyline);
                  
                if (nombre) {
                    if (!riosCapas[nombre]) riosCapas[nombre] = [];
                    riosCapas[nombre].push(polyline);
                    nombresUnicos.add(nombre);
                }
                
                riosEncontrados++;
            }
        });
        
        // Poblar select en una sola operación atómica de DOM (instantáneo)
        if (select) {
            if (nombresUnicos.size > 0) {
                const lista = Array.from(nombresUnicos).sort((a,b) => a.localeCompare(b));
                let optionsHtml = '<option value="" disabled selected>Selecciona un río de la lista...</option>';
                for (let i = 0; i < lista.length; i++) {
                    optionsHtml += `<option value="${lista[i]}">${lista[i]}</option>`;
                }
                select.innerHTML = optionsHtml;
            } else {
                select.innerHTML = '<option value="" disabled selected>No se encontraron ríos nombrados</option>';
            }
        }
        
        if (window.addNotification) window.addNotification(`Se cargaron ${nombresUnicos.size} ríos de forma instantánea.`);
    })
    .catch(err => {
        if (err.name === 'AbortError') return;
        console.error("Error buscando ríos:", err);
        if (select) select.innerHTML = '<option value="" disabled selected>Ríos no disponibles temporalmente</option>';
    });
}

let rioSeleccionadoActual = null;
let coordsRioActual = [];
let capaSatelitalDeforestacion = null;
let debounceTimerGEE = null;

function enfocarRio(nombreRio) {
    if (!nombreRio || !riosCapas[nombreRio]) return;
    
    rioSeleccionadoActual = nombreRio;
    
    const polylines = riosCapas[nombreRio];
    if (polylines.length > 0) {
        const grupoTemporal = L.featureGroup(polylines);
        map.fitBounds(grupoTemporal.getBounds(), { maxZoom: 14, animate: true, duration: 0.5 });
    }
    
    // Extraer coordenadas reales del río para el satélite
    coordsRioActual = [];
    polylines.forEach(layer => {
        const latlngs = layer.getLatLngs();
        latlngs.forEach(pt => coordsRioActual.push([pt.lat, pt.lng || pt.lon]));
    });
    
    // Mostrar panel de degradación
    const panel = document.getElementById('panelDegradacion');
    if (panel) panel.classList.remove('hidden');
    
    document.getElementById('rioSeleccionadoTexto').innerText = "Análisis: " + nombreRio;
    
    // Reiniciar slider a 2014 y consultar satélite real
    const slider = document.getElementById('yearSlider');
    if (slider) {
        slider.value = 2014;
        document.getElementById('yearValor').innerText = "2014";
        consultarDeforestacionSatelitalReal(2014);
    }
    
    // Resaltar temporalmente el río
    polylines.forEach(layer => {
        const estiloOriginal = { color: layer.options.color, weight: layer.options.weight };
        layer.setStyle({ color: '#FF4500', weight: 5 });
        setTimeout(() => layer.setStyle(estiloOriginal), 3000);
    });
}

function actualizarDegradacion(year) {
    document.getElementById('yearValor').innerText = year;
    
    // Vista previa inmediata mientras arrastra el slider
    const texto = document.getElementById('textoDegradacion');
    if (texto) texto.innerHTML = `<span class="text-secondary/70">Consultando satélites NASA/ESA para ${year}...</span>`;
    
    // Debounce de 350ms para no saturar con llamadas de red mientras se mueve el slider
    if (debounceTimerGEE) clearTimeout(debounceTimerGEE);
    debounceTimerGEE = setTimeout(() => {
        consultarDeforestacionSatelitalReal(year);
    }, 350);
}

async function consultarDeforestacionSatelitalReal(year) {
    if (!rioSeleccionadoActual || !coordsRioActual || coordsRioActual.length < 2) return;
    
    const texto = document.getElementById('textoDegradacion');
    const barra = document.getElementById('barraDegradacion');
    
    try {
        const response = await fetch('/api/analisis_deforestacion_rio', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').content
            },
            body: JSON.stringify({
                nombre_rio: rioSeleccionadoActual,
                year: year,
                coords: coordsRioActual
            })
        });
        
        const data = await response.json();
        if (!data.exito) throw new Error(data.error);
        
        const pct = data.porcentaje;
        if (barra) barra.style.width = pct + '%';
        
        let labelNivel = 'Saludable';
        let colorNivel = '#22c55e';
        let colorRio = '#0078FF';
        
        if (pct >= 40) {
            labelNivel = 'Degradación Crítica';
            colorNivel = '#FF4500';
            colorRio = '#FF4500';
        } else if (pct >= 20) {
            labelNivel = 'Impacto Moderado';
            colorNivel = '#f97316';
            colorRio = '#f97316';
        } else if (pct >= 8) {
            labelNivel = 'Impacto Leve';
            colorNivel = '#eab308';
            colorRio = '#eab308';
        }
        
        if (texto) {
            texto.innerHTML = `
                <div class="mt-1">
                    <span class="font-bold text-xs" style="color: ${colorNivel}">${pct}% (${labelNivel})</span>
                    <p class="text-[9px] text-secondary/80 mt-0.5 font-normal">
                        Bosque perdido: <b>${data.hectareas_perdidas} ha</b> de ${data.hectareas_bosque} ha
                    </p>
                    <p class="text-[8px] text-secondary/60 mt-0.5 truncate">
                        🛰️ Satélites: Landsat + Hansen GFC
                    </p>
                </div>
            `;
        }
        
        // Superponer la mancha satelital roja de deforestación real en Leaflet
        if (data.tile_url) {
            if (capaSatelitalDeforestacion) map.removeLayer(capaSatelitalDeforestacion);
            capaSatelitalDeforestacion = L.tileLayer(data.tile_url, { 
                maxZoom: 18, 
                opacity: 0.9,
                zIndex: 400
            }).addTo(map);
        }
        
        // Pintar el río según la degradación real
        const polylines = riosCapas[rioSeleccionadoActual];
        if (polylines && Array.isArray(polylines)) {
            polylines.forEach(layer => layer.setStyle({ color: colorRio }));
        }
        
    } catch(err) {
        console.error("Error consultando satélites:", err);
        if (texto) texto.innerText = "Error consultando satélites";
    }
}

function buscarModulo(event) {
    if (event.key === 'Enter') {
        const term = event.target.value.toLowerCase().trim();
        if (!term) return;

        // Note: These URLs are hardcoded for now, but in a real app 
        // you might want to pass them from the template or use a global config
        if (term.includes('explo') || term.includes('mapa') || term.includes('visor')) {
            window.location.href = "/dashboard";
        } else if (term.includes('tendencia') || term.includes('analisis') || term.includes('histor')) {
            window.location.href = "/tendencias";
        } else if (term.includes('carga') || term.includes('dato') || term.includes('subir')) {
            window.location.href = "/carga_datos";
        } else if (term.includes('config') || term.includes('perfil') || term.includes('ajuste') || term.includes('seguridad')) {
            window.location.href = "/configuracion";
        } else {
            const isDark = document.documentElement.classList.contains('dark');
            if (typeof Swal !== 'undefined') {
                Swal.fire({
                    title: "Módulo no encontrado", 
                    text: 'No hay resultados para: "' + term + '"', 
                    icon: "info",
                    background: isDark ? '#191c1d' : '#fff',
                    color: isDark ? '#fff' : '#000',
                    customClass: { popup: 'rounded-3xl border border-outline-variant/10' }
                });
            } else {
                alert('No hay resultados para: "' + term + '"');
            }
        }
    }
}

async function subirNetCDF() {
    var fileInput = document.getElementById('archivoNetCDF');
    var file = fileInput.files[0];
    if (!file) return;

    actualizarUIUpload('loading');

    var formData = new FormData();
    formData.append('archivo_nc', file);
    ejecutarConsulta('/api/procesar_netcdf', formData, true);
    
    fileInput.value = '';
}

function actualizarUIUpload(estado, nombre = "") {
    const btn = document.getElementById('btnCargarDatos');
    const icon = document.getElementById('iconData');
    const text = document.getElementById('btnDataText');
    const status = document.getElementById('uploadStatus');

    const lang = document.documentElement.lang || 'es';
    if (estado === 'loading') {
        btn.classList.add('opacity-50', 'pointer-events-none');
        status.classList.remove('hidden');
        text.innerText = translations[lang]['btn_loading'] || "Procesando...";
    } else if (estado === 'success') {
        btn.classList.remove('opacity-50', 'pointer-events-none', 'bg-primary');
        btn.classList.add('bg-green-600');
        status.classList.add('hidden');
        icon.innerText = "check_circle";
        text.innerText = (translations[lang]['btn_ready'] || "¡Listo!") + " " + nombre;
    } else if (estado === 'error') {
        btn.classList.remove('opacity-50', 'pointer-events-none', 'bg-green-600');
        btn.classList.add('bg-error');
        status.classList.add('hidden');
        icon.innerText = "error";
        text.innerText = nombre ? "Error: " + nombre : "Error - Reintentar";
    }
}

async function consultarPunto(lat, lon) {
    localStorage.setItem('active_lat', lat);
    localStorage.setItem('active_lon', lon);
    var payload = { filename: nombreArchivoNetCDF, lat: lat, lon: lon };
    ejecutarConsulta('/api/consultar_punto', JSON.stringify(payload), false);
}

async function ejecutarConsulta(url, bodyData, esUpload) {
    document.getElementById('loader').classList.remove('hidden');
    try {
        const options = { 
            method: 'POST',
            headers: {
                'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').content
            }
        };
        if (esUpload) options.body = bodyData;
        else { 
            options.headers['Content-Type'] = 'application/json'; 
            options.body = bodyData; 
        }

        const response = await fetch(url, options);
        const data = await response.json();
        if (!data.exito) throw new Error(data.error);

        if (data.filename) {
            nombreArchivoNetCDF = data.filename;
            localStorage.setItem('active_netcdf_file', data.filename);
            localStorage.removeItem('active_lat');
            localStorage.removeItem('active_lon');
            actualizarUIUpload('success', data.filename);
            document.getElementById('activeFiles').innerHTML = `
                <div class="bg-white dark:bg-white/5 p-3 rounded-lg flex items-center space-x-2 border border-primary/10 dark:border-white/10">
                    <span class="material-symbols-outlined text-primary dark:text-primary-fixed text-sm" style="font-variation-settings: 'FILL' 1;">check_circle</span>
                    <p class="text-[10px] font-black truncate text-on-surface dark:text-white/80">${data.filename}</p>
                </div>
            `;

            // Add notification for file
            if (window.addNotification) {
                const lang = document.documentElement.lang || 'es';
                const msg = (translations[lang]['notif_upload_nc'] || "Archivo procesado") + ": " + data.filename;
                window.addNotification(msg);
            }
        } else if (!esUpload) {
            // Show Success Toast for map clicks
            const lang = document.documentElement.lang || 'es';
            const Toast = Swal.mixin({
                toast: true, position: 'top-end', showConfirmButton: false, timer: 3000, 
                timerProgressBar: true, background: document.documentElement.classList.contains('dark') ? '#191c1d' : '#fff',
                color: document.documentElement.classList.contains('dark') ? '#fff' : '#000'
            });
            Toast.fire({ icon: 'success', title: translations[lang]['toast_success'] || "Análisis completado" });
        }
        
        datosGlobales = data.datos;
        document.getElementById('resultIndicator').classList.remove('hidden');
        document.getElementById('indicatorCoords').innerText = data.coords || "Resumen Regional";

        llenarComboAnios(datosGlobales);
        aplicarFiltro();
        document.getElementById('statsSection').classList.remove('hidden');
        document.getElementById('emptyStats').classList.add('hidden');

    } catch (error) {
        console.error("Error al procesar:", error);
        actualizarUIUpload('error', error.message);
        document.getElementById('statsSection').classList.add('hidden');
        document.getElementById('emptyStats').classList.remove('hidden');
    } finally {
        document.getElementById('loader').classList.add('hidden');
    }
}

function llenarComboAnios(datos) {
    const select = document.getElementById('filtroAnio');
    if (!select) return;
    select.innerHTML = '<option value="todos" data-i18n="opt_all">Histórico Completo</option>';
    const anios = new Set();
    datos.forEach(d => { if (d.fecha && d.fecha.length >= 4) anios.add(d.fecha.substring(0, 4)); });
    Array.from(anios).sort().forEach(anio => {
        if (!isNaN(anio)) {
            const opt = document.createElement('option');
            opt.value = anio; opt.innerText = "Año " + anio; select.appendChild(opt);
        }
    });
}

function aplicarFiltro() {
    const anio = document.getElementById('filtroAnio').value;
    const datos = (anio === "todos") ? datosGlobales : datosGlobales.filter(d => d.fecha.startsWith(anio));
    
    const labels = datos.map(d => d.fecha);
    const values = datos.map(d => d.valor);
    renderizar(labels, values);
}

function renderizar(labels, values) {
    const canvas = document.getElementById('graficoPrecipitacion');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (chartInstancia) chartInstancia.destroy();

    const filtroAnio = document.getElementById('filtroAnio').value;
    const nombresMeses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    
    const promediosMensuales = {};
    const conteoMensual = {};

    for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        if (!label || label.length < 7) continue;
        
        const anioLabel = label.substring(0, 4);
        if (filtroAnio !== 'todos' && anioLabel !== filtroAnio) continue;

        const mesIdx = parseInt(label.substring(5, 7), 10) - 1;
        if (mesIdx < 0 || mesIdx > 11) continue;
        const mesNombre = nombresMeses[mesIdx];
        
        if (!promediosMensuales[mesNombre]) {
            promediosMensuales[mesNombre] = 0;
            conteoMensual[mesNombre] = 0;
        }
        promediosMensuales[mesNombre] += values[i];
        conteoMensual[mesNombre] += 1;
    }

    const labelsFinal = nombresMeses;
    const valuesFinal = nombresMeses.map(m => (promediosMensuales[m] / (conteoMensual[m] || 1)).toFixed(2));

    // UI Labels
    document.getElementById('chartLabel').innerText = filtroAnio === 'todos' ? "Promedio Mensual Histórico (mm)" : `Ciclo Mensual ${filtroAnio} (mm)`;
    
    if (valuesFinal.length > 0) {
        document.getElementById('indicatorValue').innerText = valuesFinal[valuesFinal.length - 1] + " mm";
        document.getElementById('reliabilityValue').innerText = "98.2%";
    }

    const isDark = document.documentElement.classList.contains('dark');
    const primaryColor = isDark ? '#7cda9a' : '#004423';
    const textColor = isDark ? '#c0c9bb' : '#717a6d';

    chartInstancia = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labelsFinal,
            datasets: [{
                label: 'Precipitación (mm)',
                data: valuesFinal,
                backgroundColor: primaryColor,
                borderRadius: 8,
                hoverBackgroundColor: isDark ? '#97f7b5' : '#006d38',
                barThickness: 'flex',
                maxBarThickness: 35
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(25, 28, 29, 0.9)',
                    padding: 12,
                    cornerRadius: 8,
                    titleFont: { family: 'Roboto', size: 12 },
                    bodyFont: { family: 'Inter', size: 12 }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'Inter', size: 10 }, color: textColor }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)', drawBorder: false },
                    ticks: { font: { family: 'Inter', size: 10 }, color: textColor }
                }
            },
            animation: { duration: 800, easing: 'easeOutQuart' }
        }
    });
}

function actualizarNombreMascara() {
    const input = document.getElementById('archivoShapefile');
    const display = document.getElementById('nombreMascara');
    if (input.files.length > 0) {
        display.innerText = "Archivo: " + input.files[0].name;
        display.classList.remove('hidden');
    } else {
        display.classList.add('hidden');
    }
}

function actualizarNombreNetCDF() {
    const input = document.getElementById('archivoNetCDF');
    const display = document.getElementById('nombreNetCDF');
    if (input.files.length > 0) {
        display.innerText = "Archivo: " + input.files[0].name;
        display.classList.remove('hidden');
    } else {
        display.classList.add('hidden');
    }
}

let pendingGeoJSONEvent = null;
function actualizarNombreGeoJSON(event) {
    pendingGeoJSONEvent = event;
    const input = document.getElementById('archivoGeoJSON');
    const display = document.getElementById('nombreGeoJSON');
    if (input.files.length > 0) {
        display.innerText = "Archivo: " + input.files[0].name;
        display.classList.remove('hidden');
    } else {
        display.classList.add('hidden');
        pendingGeoJSONEvent = null;
    }
}

async function procesarArchivosSeleccionados() {
    const btn = document.getElementById('btnProcesarTodo');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div><span>Procesando...</span>';
    btn.classList.add('opacity-70', 'pointer-events-none');
    
    // Procesar de manera secuencial para no saturar
    const hasNetCDF = document.getElementById('archivoNetCDF').files.length > 0;
    const hasShape = document.getElementById('archivoShapefile').files.length > 0;
    const hasGeoJSON = document.getElementById('archivoGeoJSON').files.length > 0;
    
    if (hasNetCDF) {
        await subirNetCDF();
    }
    if (hasGeoJSON && pendingGeoJSONEvent) {
        cargarGeoJSON(pendingGeoJSONEvent);
    } else if (hasShape) {
        cargarShapefile();
    }
    
    if (!hasNetCDF && !hasShape && !hasGeoJSON) {
        alert("Selecciona al menos un archivo primero.");
    }
    
    setTimeout(() => {
        btn.innerHTML = originalText;
        btn.classList.remove('opacity-70', 'pointer-events-none');
    }, 1500);
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    // Re-check theme on map
    updateMapLayer(document.documentElement.classList.contains('dark'));
    
    // InvalidateSize fix: ensure tiles render after container settles
    if (map) {
        setTimeout(() => map.invalidateSize(), 400);
        
        // Listen for layout changes (like sidebar toggle)
        window.addEventListener('resize', () => {
            setTimeout(() => map.invalidateSize(), 50);
        });
    }
});
